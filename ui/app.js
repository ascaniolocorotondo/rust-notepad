// Rust Notepad: interfaccia. La logica (file, IA) vive in Rust: src-tauri/src/main.rs
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const els = {
  search: $('search'), list: $('note-list'), newNote: $('new-note'), emptyNew: $('empty-new'),
  empty: $('empty'), note: $('note'), title: $('title'), status: $('status'),
  del: $('delete-note'), blocks: $('blocks'),
  settings: $('settings'), form: $('settings-form'), openSettings: $('open-settings'),
  cancelSettings: $('cancel-settings'), preset: $('preset'), baseUrl: $('base-url'),
  model: $('model'), apiKey: $('api-key'), keyHelp: $('key-help'),
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* niente */ } },
};

// Linguaggi con il pulsante ▶ (l'HTML si apre come anteprima dentro l'app)
const RUNNABLE = new Set(['python', 'javascript', 'rust', 'c', 'cpp', 'go', 'swift', 'java', 'php', 'bash', 'html']);

let notes = [];
let current = null; // { id, blocks: [{type:'text', text} | {type:'code', lang, code}] }
let dirty = false;
let saveTimer = null;
let saveChain = Promise.resolve();

// ───────────── Formato del file (.md) ─────────────

function parse(md) {
  const lines = md.split('\n');
  const blocks = [];
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```\s*([\w+#-]*)\s*$/);
    if (!open) { buf.push(lines[i]); continue; }
    const code = [];
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) code.push(lines[j++]);
    blocks.push({ type: 'text', text: buf.join('\n') });
    blocks.push({ type: 'code', lang: Syntax.normalize(open[1]), code: code.join('\n') });
    buf = [];
    i = j;
  }
  blocks.push({ type: 'text', text: buf.join('\n') });
  return blocks;
}

function serialize(blocks) {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : '```' + (b.lang === 'testo' ? '' : b.lang) + '\n' + b.code + '\n```'))
    .join('\n');
}

// ───────────── Salvataggio automatico ─────────────

function setStatus(text) { els.status.textContent = text; }

function markDirty() {
  dirty = true;
  setStatus('Modifiche…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !current) return saveChain;
  dirty = false;
  const note = current;
  const title = els.title.value;
  const content = serialize(note.blocks);
  saveChain = saveChain.then(async () => {
    try {
      note.id = await invoke('save_note', { id: note.id, title, content });
      if (note === current) store.set('lastNote', note.id);
      setStatus('Salvato');
      await refreshList();
    } catch (err) {
      dirty = true;
      setStatus('Errore nel salvataggio');
      console.error(err);
    }
  });
  return saveChain;
}

// ───────────── Elenco note ─────────────

async function refreshList() {
  try { notes = await invoke('list_notes'); } catch (err) { console.error(err); notes = []; }
  renderList();
}

function renderList() {
  const q = els.search.value.trim().toLowerCase();
  const shown = notes.filter((n) => !q || n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q));
  els.list.innerHTML = '';
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'n-empty';
    li.textContent = q ? 'Nessun risultato' : 'Ancora nessuna nota';
    els.list.appendChild(li);
    return;
  }
  for (const n of shown) {
    const li = document.createElement('li');
    if (current && n.id === current.id) li.classList.add('active');
    const t = document.createElement('div');
    t.className = 'n-title';
    t.textContent = n.title;
    const p = document.createElement('div');
    p.className = 'n-preview';
    p.textContent = n.preview || 'Nota vuota';
    li.append(t, p);
    li.addEventListener('click', () => openNote(n.id));
    els.list.appendChild(li);
  }
}

async function openNote(id) {
  await flushSave();
  let content;
  try { content = await invoke('read_note', { id }); } catch (err) { console.error(err); return; }
  current = { id, blocks: parse(content) };
  els.title.value = id;
  els.empty.hidden = true;
  els.note.hidden = false;
  setStatus('');
  store.set('lastNote', id);
  renderBlocks();
  renderList();
}

async function newNote() {
  await flushSave();
  const id = await invoke('create_note');
  await refreshList();
  await openNote(id);
  els.title.focus();
  els.title.select();
}

function showEmpty() {
  current = null;
  els.note.hidden = true;
  els.empty.hidden = false;
  renderList();
}

let deleteArmed = null;
async function deleteNote() {
  if (!current) return;
  if (!deleteArmed) {
    els.del.textContent = 'Conferma?';
    els.del.classList.add('danger');
    deleteArmed = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  clearTimeout(saveTimer);
  dirty = false;
  await saveChain;
  try { await invoke('delete_note', { id: current.id }); } catch (err) { setStatus(String(err)); return; }
  await refreshList();
  if (notes.length) openNote(notes[0].id); else showEmpty();
}
function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  els.del.textContent = 'Elimina';
  els.del.classList.remove('danger');
}

// ───────────── Editor a blocchi ─────────────

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function renderBlocks(focus) {
  els.blocks.innerHTML = '';
  current.blocks.forEach((b) => {
    els.blocks.appendChild(b.type === 'text' ? textBlock(b) : codeBlock(b));
  });
  // Subito (non in un frame successivo), così i tasti premuti non vanno persi.
  els.blocks.querySelectorAll('.text-block').forEach(autosize);
  if (focus) {
    const node = els.blocks.children[focus.index];
    const target = node?.matches('textarea') ? node : node?.querySelector('textarea');
    if (target) { target.focus(); target.setSelectionRange(focus.pos ?? 0, focus.pos ?? 0); }
  }
}

function textBlock(b) {
  const ta = document.createElement('textarea');
  ta.className = 'text-block';
  ta.rows = 1;
  ta.value = b.text;
  if (current.blocks.length === 1) ta.placeholder = 'Inizia a scrivere…';
  ta.addEventListener('input', () => { b.text = ta.value; autosize(ta); markDirty(); });
  ta.addEventListener('keydown', (e) => slashCommand(e, ta, b));
  return ta;
}

// "/code" o "/code python" su una riga + Invio → blocco di codice
function slashCommand(e, ta, b) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return;
  const val = ta.value;
  const start = val.lastIndexOf('\n', pos - 1) + 1;
  let end = val.indexOf('\n', pos);
  if (end === -1) end = val.length;
  const m = val.slice(start, end).trim().match(/^\/code(?:\s+(\S+))?$/i);
  if (!m) return;
  e.preventDefault();

  const lang = m[1] ? Syntax.normalize(m[1]) : (store.get('lastLang') || 'python');
  const before = val.slice(0, start).replace(/\n$/, '');
  const after = val.slice(end).replace(/^\n/, '');
  const idx = current.blocks.indexOf(b);
  current.blocks.splice(idx, 1,
    { type: 'text', text: before },
    { type: 'code', lang, code: '' },
    { type: 'text', text: after });
  markDirty();
  renderBlocks({ index: idx + 1 });
}

function removeCodeBlock(b) {
  const i = current.blocks.indexOf(b);
  const prev = current.blocks[i - 1];
  const next = current.blocks[i + 1];
  if (prev?.type === 'text' && next?.type === 'text') {
    const pos = prev.text.length;
    prev.text = [prev.text, next.text].filter((s) => s !== '').join('\n');
    current.blocks.splice(i, 2);
    markDirty();
    renderBlocks({ index: i - 1, pos });
  } else {
    current.blocks.splice(i, 1);
    markDirty();
    renderBlocks();
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function codeBlock(b) {
  const box = el('div', 'code-block');

  // Barra in alto: linguaggio + pulsanti
  const head = el('div', 'code-head');
  const select = el('select');
  for (const [value, label] of Syntax.LANGUAGES) {
    const o = el('option', null, label);
    o.value = value;
    select.appendChild(o);
  }
  select.value = b.lang;
  const runBtn = el('button', 'code-btn run');
  runBtn.title = 'Esegui (⌘↩)';
  const aiBtn = el('button', 'code-btn ai', '✨ Assistente IA');
  const copyBtn = el('button', 'code-btn', 'Copia');
  const delBtn = el('button', 'code-btn', '✕');
  delBtn.title = 'Elimina blocco';
  head.append(select, runBtn, el('span', 'spacer'), aiBtn, copyBtn, delBtn);
  const updateRunBtn = () => {
    runBtn.hidden = !RUNNABLE.has(b.lang);
    runBtn.textContent = b.lang === 'html' ? '▶ Anteprima' : '▶ Esegui';
  };
  updateRunBtn();

  // Barra dell'IA
  const aiBar = el('div', 'ai-bar');
  aiBar.hidden = true;
  const aiInput = el('input');
  aiInput.placeholder = 'Cosa deve fare il codice? Es. "una funzione che ordina una lista di nomi"';
  const aiGo = el('button', null, 'Genera');
  aiBar.append(aiInput, aiGo);
  const aiStatus = el('div', 'ai-status');
  aiStatus.hidden = true;

  // Area del codice: <pre> colorato sotto, <textarea> trasparente sopra
  const wrap = el('div', 'code-wrap');
  const pre = el('pre');
  const codeEl = el('code');
  pre.appendChild(codeEl);
  const ta = el('textarea');
  ta.spellcheck = false;
  ta.value = b.code;
  ta.placeholder = 'Scrivi il codice qui, oppure chiedilo a ✨ Assistente IA';
  wrap.append(pre, ta);

  const paint = () => { codeEl.innerHTML = Syntax.highlight(b.code, b.lang) + ' '; };
  paint();

  ta.addEventListener('input', () => { b.code = ta.value; paint(); markDirty(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (RUNNABLE.has(b.lang)) runCode();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
    }
  });
  select.addEventListener('change', () => {
    b.lang = select.value;
    store.set('lastLang', b.lang);
    paint();
    updateRunBtn();
    output.hidden = true;
    markDirty();
  });

  // Pannello del risultato
  const output = el('div', 'run-output');
  output.hidden = true;
  const outHead = el('div', 'run-head');
  const outTitle = el('span', null, 'Risultato');
  const outClose = el('button', 'code-btn', '✕');
  outClose.title = 'Chiudi risultato';
  outHead.append(outTitle, el('span', 'spacer'), outClose);
  const outBody = el('div', 'run-body');
  output.append(outHead, outBody);
  outClose.addEventListener('click', () => { output.hidden = true; });

  let running = false;
  async function runCode() {
    if (running) return;
    output.hidden = false;
    outBody.innerHTML = '';

    if (b.lang === 'html') {
      outTitle.textContent = 'Anteprima';
      const frame = el('iframe', 'html-preview');
      frame.sandbox = 'allow-scripts allow-modals';
      frame.srcdoc = b.code;
      outBody.appendChild(frame);
      return;
    }

    running = true;
    runBtn.disabled = true;
    runBtn.textContent = '■ In esecuzione…';
    outTitle.textContent = 'In esecuzione…';
    try {
      const r = await invoke('run_code', { language: b.lang, code: b.code });
      const secs = (r.millis / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 });
      const how = r.timed_out ? 'interrotto: troppo lungo'
        : r.exit_code === 0 ? 'completato' : `terminato con errore (codice ${r.exit_code ?? '?'})`;
      outTitle.textContent = `Risultato · ${how} · ${secs} s`;
      if (r.stdout) outBody.appendChild(el('pre', 'out', r.stdout));
      if (r.stderr) outBody.appendChild(el('pre', 'err', r.stderr));
      if (!r.stdout && !r.stderr) outBody.appendChild(el('pre', 'out muted-out', '(nessun output)'));
    } catch (err) {
      outTitle.textContent = 'Impossibile eseguire';
      outBody.appendChild(el('pre', 'err', String(err)));
    } finally {
      running = false;
      runBtn.disabled = false;
      updateRunBtn();
    }
  }
  runBtn.addEventListener('click', runCode);

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.code); }
    catch { ta.focus(); ta.select(); document.execCommand('copy'); }
    copyBtn.textContent = 'Copiato ✓';
    setTimeout(() => (copyBtn.textContent = 'Copia'), 1400);
  });

  let delArmed = null;
  delBtn.addEventListener('click', () => {
    if (!b.code.trim() || delArmed) { clearTimeout(delArmed); removeCodeBlock(b); return; }
    delBtn.textContent = 'Elimino?';
    delArmed = setTimeout(() => { delBtn.textContent = '✕'; delArmed = null; }, 2500);
  });

  aiBtn.addEventListener('click', () => {
    aiBar.hidden = !aiBar.hidden;
    aiBtn.classList.toggle('on', !aiBar.hidden);
    if (!aiBar.hidden) {
      aiInput.placeholder = b.code.trim()
        ? 'Come lo modifico? Es. "aggiungi i commenti", "correggi l\'errore", "rendilo più veloce"'
        : 'Cosa deve fare il codice? Es. "una funzione che ordina una lista di nomi"';
      aiInput.focus();
    }
  });
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runAi(); }
    if (e.key === 'Escape') { aiBar.hidden = true; aiBtn.classList.remove('on'); }
  });
  aiGo.addEventListener('click', runAi);

  function showAiStatus(kind, text, actions = []) {
    aiStatus.hidden = false;
    aiStatus.className = 'ai-status' + (kind === 'error' ? ' error' : '');
    aiStatus.innerHTML = '';
    if (kind === 'busy') aiStatus.appendChild(el('span', 'spinner'));
    aiStatus.appendChild(el('span', null, text));
    for (const [label, fn] of actions) {
      const btn = el('button', null, label);
      btn.addEventListener('click', fn);
      aiStatus.appendChild(btn);
    }
  }

  async function runAi() {
    const instruction = aiInput.value.trim();
    if (!instruction) { aiInput.focus(); return; }
    const before = b.code;
    aiGo.disabled = aiInput.disabled = true;
    showAiStatus('busy', before.trim() ? 'L\'IA sta modificando il codice…' : 'L\'IA sta scrivendo il codice…');
    try {
      const result = await invoke('ai_code', { instruction, code: before, language: b.lang });
      b.code = result;
      ta.value = result;
      paint();
      markDirty();
      aiInput.value = '';
      showAiStatus('ok', 'Fatto ✓', [['Annulla', () => {
        b.code = before; ta.value = before; paint(); markDirty(); aiStatus.hidden = true;
      }]]);
    } catch (err) {
      const msg = String(err);
      const actions = /chiave|impostazioni|modello/i.test(msg) ? [['Apri impostazioni', openSettings]] : [];
      showAiStatus('error', msg, actions);
    } finally {
      aiGo.disabled = aiInput.disabled = false;
    }
  }

  box.append(head, aiBar, aiStatus, wrap, output);
  return box;
}

// ───────────── Impostazioni IA ─────────────

const PRESETS = {
  builtin: {
    base: null, model: 'openai/gpt-oss-120b', // l'indirizzo arriva da Rust all'avvio
    help: 'Pronto all\'uso, nessuna chiave necessaria. Modello GPT-OSS 120B, fino a 30 richieste al giorno.',
  },
  groq: {
    base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b',
    help: 'Chiave gratuita: console.groq.com → API Keys → Create API Key (inizia con gsk_). L\'elenco dei modelli è nella sezione Models.',
  },
  openrouter: {
    base: 'https://openrouter.ai/api/v1', model: '',
    help: 'Chiave su openrouter.ai/keys. Come modello copia un nome che finisce con :free da openrouter.ai/models.',
  },
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest',
    help: 'Chiave su aistudio.google.com → Get API key. Nel piano gratuito Google può usare i dati per migliorare i servizi.',
  },
  ollama: {
    base: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b',
    help: 'Nessuna chiave: serve Ollama aperto sul Mac e il modello scaricato.',
  },
  custom: { base: null, model: null, help: 'Qualsiasi servizio compatibile OpenAI: indirizzo che finisce prima di /chat/completions.' },
};

const trimSlash = (u) => u.replace(/\/+$/, '');

function presetFor(url) {
  if (PRESETS.builtin.base && trimSlash(url) === trimSlash(PRESETS.builtin.base)) return 'builtin';
  return Object.keys(PRESETS).find((k) => k !== 'builtin' && PRESETS[k].base && url.startsWith(PRESETS[k].base)) || 'custom';
}

function showPresetFields() {
  const isBuiltin = els.preset.value === 'builtin';
  $('custom-fields').hidden = isBuiltin;
  els.keyHelp.textContent = PRESETS[els.preset.value].help;
}

async function openSettings() {
  if (!PRESETS.builtin.base) PRESETS.builtin.base = await invoke('builtin_ai_url');
  const s = await invoke('get_settings');
  els.baseUrl.value = s.base_url;
  els.model.value = s.model;
  els.apiKey.value = s.api_key;
  els.preset.value = presetFor(s.base_url);
  showPresetFields();
  els.settings.showModal();
}

els.preset.addEventListener('change', () => {
  const p = PRESETS[els.preset.value];
  if (p.base !== null) els.baseUrl.value = p.base;
  if (p.model !== null) els.model.value = p.model;
  els.model.placeholder = els.preset.value === 'openrouter' ? 'es. nome-del-modello:free' : '';
  showPresetFields();
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const builtin = els.preset.value === 'builtin';
  await invoke('save_settings', {
    settings: {
      base_url: builtin ? PRESETS.builtin.base : els.baseUrl.value.trim(),
      model: builtin ? PRESETS.builtin.model : els.model.value.trim(),
      api_key: builtin ? '' : els.apiKey.value.trim(),
    },
  });
  els.settings.close();
});
els.cancelSettings.addEventListener('click', () => els.settings.close());

// ───────────── Eventi generali ─────────────

els.newNote.addEventListener('click', newNote);
els.emptyNew.addEventListener('click', newNote);
els.del.addEventListener('click', deleteNote);
els.search.addEventListener('input', renderList);
els.title.addEventListener('input', markDirty);
els.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    els.blocks.querySelector('textarea')?.focus();
  }
});
els.openSettings.addEventListener('click', openSettings);

document.addEventListener('keydown', (e) => {
  if (!e.metaKey && !e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); newNote(); }
  if (k === 's') { e.preventDefault(); flushSave(); }
  if (k === 'f' && e.shiftKey) { e.preventDefault(); els.search.focus(); }
});
window.addEventListener('blur', flushSave);

// ───────────── Avvio ─────────────

(async () => {
  await refreshList();
  const last = store.get('lastNote');
  const target = notes.find((n) => n.id === last) || notes[0];
  if (target) await openNote(target.id); else showEmpty();
})();
