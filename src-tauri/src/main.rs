// Nasconde la finestra del terminale su Windows nelle build di rilascio.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// ───────────────────────── Note ─────────────────────────

#[derive(Serialize)]
struct NoteInfo {
    id: String,
    title: String,
    modified: u64,
    preview: String,
}

/// Cartella dove vivono le note: ~/Documents/Rust Notepad
fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("Cartella Documenti non trovata: {e}"))?
        .join("Rust Notepad");
    fs::create_dir_all(&dir).map_err(|e| format!("Impossibile creare la cartella: {e}"))?;
    Ok(dir)
}

/// Impedisce che un id esca dalla cartella delle note (es. "../qualcosa").
fn note_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.starts_with('.') || id.contains('/') || id.contains('\\') {
        return Err("Nome nota non valido".into());
    }
    Ok(notes_dir(app)?.join(format!("{id}.md")))
}

/// Trasforma un titolo in un nome di file valido.
fn sanitize_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let short: String = trimmed.chars().take(80).collect();
    if short.is_empty() {
        "Senza titolo".into()
    } else {
        short
    }
}

/// Trova un nome libero: "Nota", "Nota 2", "Nota 3"...
fn unique_stem(app: &AppHandle, base: &str, current: Option<&str>) -> Result<String, String> {
    let dir = notes_dir(app)?;
    let mut candidate = base.to_string();
    let mut n = 2;
    while dir.join(format!("{candidate}.md")).exists() && Some(candidate.as_str()) != current {
        candidate = format!("{base} {n}");
        n += 1;
    }
    Ok(candidate)
}

fn preview_of(content: &str) -> String {
    let mut in_code = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if !in_code && !t.is_empty() {
            return t.chars().take(90).collect();
        }
    }
    String::new()
}

#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<NoteInfo>, String> {
    let dir = notes_dir(&app)?;
    let mut notes = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let content = fs::read_to_string(&path).unwrap_or_default();
        notes.push(NoteInfo {
            id: stem.to_string(),
            title: stem.to_string(),
            modified,
            preview: preview_of(&content),
        });
    }
    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(notes)
}

#[tauri::command]
fn read_note(app: AppHandle, id: String) -> Result<String, String> {
    fs::read_to_string(note_path(&app, &id)?).map_err(|e| format!("Impossibile aprire la nota: {e}"))
}

#[tauri::command]
fn create_note(app: AppHandle) -> Result<String, String> {
    let id = unique_stem(&app, "Nuova nota", None)?;
    fs::write(note_path(&app, &id)?, "").map_err(|e| e.to_string())?;
    Ok(id)
}

/// Salva la nota. Se il titolo è cambiato rinomina il file e restituisce il nuovo id.
#[tauri::command]
fn save_note(app: AppHandle, id: String, title: String, content: String) -> Result<String, String> {
    let old_path = note_path(&app, &id)?;
    let wanted = sanitize_title(&title);
    let new_id = if wanted == id { id.clone() } else { unique_stem(&app, &wanted, Some(&id))? };
    let new_path = note_path(&app, &new_id)?;
    if new_id != id && old_path.exists() {
        fs::rename(&old_path, &new_path).map_err(|e| format!("Impossibile rinominare: {e}"))?;
    }
    fs::write(&new_path, content).map_err(|e| format!("Impossibile salvare: {e}"))?;
    Ok(new_id)
}

/// Sposta la nota nel Cestino (si può sempre recuperare).
#[tauri::command]
fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    trash::delete(note_path(&app, &id)?).map_err(|e| format!("Impossibile spostare nel Cestino: {e}"))
}

#[tauri::command]
fn notes_folder(app: AppHandle) -> Result<String, String> {
    Ok(notes_dir(&app)?.to_string_lossy().into_owned())
}

// ───────────────────────── Impostazioni ─────────────────────────

/// Server ponte di Rust Notepad (server/worker.js): l'IA funziona senza chiave.
/// Si può cambiare in fase di compilazione con la variabile RUST_NOTEPAD_AI_URL.
const BUILTIN_AI_URL: &str = match option_env!("RUST_NOTEPAD_AI_URL") {
    Some(url) => url,
    None => "https://rust-notepad-ai.ascaniolocorotondo.workers.dev/v1",
};

fn is_builtin(url: &str) -> bool {
    url.trim_end_matches('/') == BUILTIN_AI_URL.trim_end_matches('/')
}

#[tauri::command]
fn builtin_ai_url() -> &'static str {
    BUILTIN_AI_URL
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    base_url: String,
    api_key: String,
    model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            base_url: BUILTIN_AI_URL.into(),
            api_key: String::new(),
            model: "openai/gpt-oss-120b".into(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // La chiave è leggibile solo dal tuo utente.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ───────────────────────── Assistente IA ─────────────────────────

/// Se il modello risponde con ```lang ... ``` tiene solo il codice dentro.
fn strip_fences(text: &str) -> String {
    let t = text.trim();
    if let Some(start) = t.find("```") {
        let after = &t[start + 3..];
        let body = match after.find('\n') {
            Some(nl) => &after[nl + 1..],
            None => after,
        };
        let body = match body.rfind("```") {
            Some(end) => &body[..end],
            None => body,
        };
        return body.trim_end().to_string();
    }
    t.to_string()
}

#[tauri::command]
async fn ai_code(app: AppHandle, instruction: String, code: String, language: String) -> Result<String, String> {
    let s = load_settings(&app);
    let is_local = s.base_url.contains("localhost") || s.base_url.contains("127.0.0.1");
    if s.api_key.trim().is_empty() && !is_local && !is_builtin(&s.base_url) {
        return Err("Manca la chiave API: aggiungila in ⚙︎ Impostazioni.".into());
    }
    if instruction.trim().is_empty() {
        return Err("Scrivi cosa deve fare il codice.".into());
    }

    let lang = if language.is_empty() || language == "testo" { "il linguaggio più adatto".to_string() } else { language };
    let system = format!(
        "Sei un assistente di programmazione dentro un editor. Scrivi codice in {lang}. \
         Rispondi SOLO con il codice completo e funzionante, senza spiegazioni e senza blocchi ```. \
         Se servono chiarimenti mettili come commenti nel codice, in italiano."
    );
    let user = if code.trim().is_empty() {
        format!("Scrivi il codice per: {instruction}")
    } else {
        format!("Questo è il codice attuale:\n\n{code}\n\nModificalo così: {instruction}\n\nRestituisci il codice completo aggiornato.")
    };

    let body = serde_json::json!({
        "model": s.model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });

    let url = format!("{}/chat/completions", s.base_url.trim_end_matches('/'));
    let mut req = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(120))
        .json(&body);
    if !s.api_key.trim().is_empty() {
        req = req.bearer_auth(s.api_key.trim());
    }

    let res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "L'IA ci sta mettendo troppo. Riprova.".to_string()
        } else {
            format!("Connessione non riuscita: controlla internet e l'indirizzo nelle impostazioni ({e})")
        }
    })?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(match status.as_u16() {
            401 | 403 => format!("Chiave API non valida o senza permessi. ({detail})"),
            404 => format!("Modello o indirizzo non trovato: controlla le impostazioni. ({detail})"),
            429 => format!("Limite gratuito raggiunto per ora: riprova più tardi. ({detail})"),
            _ => format!("Errore {status}: {detail}"),
        });
    }

    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Risposta non valida: {e}"))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("L'IA non ha restituito testo.")?;
    Ok(strip_fences(content))
}

// ───────────────────────── Esecuzione del codice ─────────────────────────

const RUN_TIMEOUT: Duration = Duration::from_secs(15);
const COMPILE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_OUTPUT: usize = 200_000;

#[derive(Serialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    millis: u64,
}

struct Output {
    stdout: String,
    stderr: String,
    status: Option<i32>,
    timed_out: bool,
}

static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Le app aperte dal Finder hanno un PATH minimo: aggiungiamo le cartelle
/// dove di solito vivono rustc, Homebrew, Go, ecc.
fn extended_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("go").join("bin"));
        dirs.push(home.join(".local").join("bin"));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(existing) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn read_limited<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if buf.len() < MAX_OUTPUT {
                buf.extend_from_slice(&chunk[..n]);
            }
        }
        let mut s = String::from_utf8_lossy(&buf).into_owned();
        if buf.len() >= MAX_OUTPUT {
            s.push_str("\n… (output troncato)");
        }
        s
    })
}

/// Avvia un programma, raccoglie l'output e lo ferma se supera il tempo massimo.
fn run_process(program: &str, args: &[String], dir: &Path, timeout: Duration) -> Result<Output, std::io::Error> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("PATH", extended_path())
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let out = read_limited(child.stdout.take().expect("stdout"));
    let err = read_limited(child.stderr.take().expect("stderr"));
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s.code();
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    Ok(Output {
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        status,
        timed_out,
    })
}

/// Come installare ciò che manca, in base al linguaggio.
fn missing_tool(lang: &str, program: &str) -> String {
    let how = match lang {
        "python" => "Installa Python da python.org.",
        "javascript" => "Installa Node.js da nodejs.org.",
        "rust" => "Installa Rust da rustup.rs.",
        "c" | "cpp" => {
            if cfg!(target_os = "macos") {
                "Esegui nel Terminale: xcode-select --install"
            } else {
                "Installa un compilatore C/C++ (gcc, clang o Visual Studio Build Tools)."
            }
        }
        "go" => "Installa Go da go.dev.",
        "swift" => "Installa Swift da swift.org (sul Mac: xcode-select --install).",
        "java" => "Installa Java (JDK 11 o più recente) da adoptium.net.",
        "php" => "Installa PHP da php.net.",
        "bash" => "Serve bash (su Windows: Git Bash o WSL).",
        _ => "",
    };
    format!("Non trovo «{program}» sul computer. {how}")
}

fn run_code_blocking(language: String, code: String) -> Result<RunResult, String> {
    let n = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("rust-notepad-{}-{n}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = if cfg!(windows) { "programma.exe" } else { "programma" };
    let exe_path = dir.join(exe).to_string_lossy().into_owned();
    let s = |x: &str| x.to_string();

    // (file sorgente, passo di compilazione opzionale, comando di esecuzione)
    let python = if cfg!(windows) { "python" } else { "python3" };
    let (file, compile, run): (&str, Option<(&str, Vec<String>)>, (String, Vec<String>)) = match language.as_str() {
        "python" => ("main.py", None, (s(python), vec![s("main.py")])),
        "javascript" => ("main.js", None, (s("node"), vec![s("main.js")])),
        "bash" => ("main.sh", None, (s("bash"), vec![s("main.sh")])),
        "php" => ("main.php", None, (s("php"), vec![s("main.php")])),
        "go" => ("main.go", None, (s("go"), vec![s("run"), s("main.go")])),
        "swift" => ("main.swift", None, (s("swift"), vec![s("main.swift")])),
        "java" => ("Main.java", None, (s("java"), vec![s("Main.java")])),
        "rust" => ("main.rs", Some(("rustc", vec![s("main.rs"), s("-o"), s(exe)])), (exe_path.clone(), vec![])),
        "c" => ("main.c", Some(("cc", vec![s("main.c"), s("-o"), s(exe), s("-lm")])), (exe_path.clone(), vec![])),
        "cpp" => ("main.cpp", Some(("c++", vec![s("-std=c++17"), s("main.cpp"), s("-o"), s(exe)])), (exe_path.clone(), vec![])),
        "typescript" => return Err("TypeScript non si può eseguire direttamente: cambia il linguaggio in JavaScript.".into()),
        other => return Err(format!("Il linguaggio «{other}» non si può eseguire.")),
    };
    fs::write(dir.join(file), &code).map_err(|e| e.to_string())?;

    let start = Instant::now();
    let result = (|| {
        if let Some((compiler, args)) = &compile {
            let c = run_process(compiler, args, &dir, COMPILE_TIMEOUT).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound { missing_tool(&language, compiler) } else { e.to_string() }
            })?;
            if c.timed_out || c.status != Some(0) {
                return Ok(RunResult {
                    stdout: c.stdout,
                    stderr: if c.timed_out { "La compilazione ci ha messo troppo.".into() } else { c.stderr },
                    exit_code: c.status,
                    timed_out: c.timed_out,
                    millis: start.elapsed().as_millis() as u64,
                });
            }
        }
        let r = run_process(&run.0, &run.1, &dir, RUN_TIMEOUT).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { missing_tool(&language, &run.0) } else { e.to_string() }
        })?;
        Ok(RunResult {
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.status,
            timed_out: r.timed_out,
            millis: start.elapsed().as_millis() as u64,
        })
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

#[tauri::command]
async fn run_code(language: String, code: String) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_code_blocking(language, code))
        .await
        .map_err(|e| e.to_string())?
}

// ───────────────────────── Avvio ─────────────────────────

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_notes,
            read_note,
            create_note,
            save_note,
            delete_note,
            notes_folder,
            get_settings,
            save_settings,
            ai_code,
            run_code,
            builtin_ai_url
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di Rust Notepad");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizza_titoli() {
        assert_eq!(sanitize_title("Ciao/mondo?"), "Ciao-mondo-");
        assert_eq!(sanitize_title("   "), "Senza titolo");
        assert_eq!(sanitize_title("..nascosto"), "nascosto");
    }

    #[test]
    fn toglie_i_backtick() {
        assert_eq!(strip_fences("```python\nprint(1)\n```"), "print(1)");
        assert_eq!(strip_fences("print(1)"), "print(1)");
        assert_eq!(strip_fences("Ecco:\n```rs\nfn a() {}\n```\nfine"), "fn a() {}");
    }

    #[test]
    fn esegue_python() {
        let r = run_code_blocking("python".into(), "print(6 * 7)".into()).unwrap();
        assert_eq!(r.stdout.trim(), "42");
        assert_eq!(r.exit_code, Some(0));
    }

    #[test]
    fn compila_ed_esegue_c() {
        let r = run_code_blocking("c".into(), "#include <stdio.h>\nint main(){printf(\"ok\");return 0;}".into()).unwrap();
        assert_eq!(r.stdout, "ok");
    }

    #[test]
    fn segnala_errori_di_sintassi() {
        let r = run_code_blocking("python".into(), "def (".into()).unwrap();
        assert_ne!(r.exit_code, Some(0));
        assert!(r.stderr.contains("SyntaxError"));
    }

    #[test]
    fn anteprima_salta_il_codice() {
        assert_eq!(preview_of("```js\nx\n```\nTesto vero"), "Testo vero");
    }
}
