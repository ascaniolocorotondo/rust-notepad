// Rust Notepad – server "ponte" per l'assistente IA (Cloudflare Worker)
//
// L'app manda la richiesta qui; il ponte aggiunge la chiave Groq (salvata come
// segreto GROQ_API_KEY su Cloudflare, mai nell'app) e inoltra a Groq.
//
// Protezioni:
//  - modello fisso, niente richieste arbitrarie
//  - dimensione massima della richiesta e della risposta
//  - limite di richieste al giorno per utente (se c'è il KV "LIMITS")
//    L'indirizzo IP non viene salvato: si salva solo un'impronta (hash) giornaliera.

const MODEL = 'openai/gpt-oss-120b';
const DAILY_LIMIT = 30;           // richieste al giorno per utente
const MAX_BODY_CHARS = 60_000;    // circa 1.500 righe di codice
const MAX_OUTPUT_TOKENS = 8192;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const fail = (status, message) => json({ error: { message } }, status);

async function userFingerprint(request, day, secret) {
  const ip = request.headers.get('CF-Connecting-IP') || 'sconosciuto';
  const data = new TextEncoder().encode(`${day}|${ip}|${secret}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkDailyLimit(request, env) {
  if (!env.LIMITS) return null; // KV non collegato: nessun limite per utente
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}:${await userFingerprint(request, day, env.GROQ_API_KEY)}`;
  const used = parseInt((await env.LIMITS.get(key)) || '0', 10);
  if (used >= DAILY_LIMIT) {
    return fail(429, `Hai usato le ${DAILY_LIMIT} richieste gratuite di oggi. Riprova domani, oppure inserisci una tua chiave in ⚙︎ Impostazioni IA.`);
  }
  await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  return null;
}

// Toglie spazi, a capo e virgolette finite per sbaglio nel segreto.
const cleanKey = (k) => (k || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiKey = cleanKey(env.GROQ_API_KEY);
    env = { ...env, GROQ_API_KEY: apiKey };

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/v1')) {
      return json({
        ok: true,
        service: 'Rust Notepad AI',
        model: MODEL,
        configured: Boolean(apiKey),
        key_format_ok: apiKey.startsWith('gsk_') && apiKey.length >= 40,
        daily_limit: env.LIMITS ? DAILY_LIMIT : null,
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return fail(404, 'Percorso non trovato.');
    }
    if (!env.GROQ_API_KEY) {
      return fail(500, 'Il server non è ancora configurato: manca il segreto GROQ_API_KEY.');
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) {
      return fail(413, 'Richiesta troppo grande: prova con meno codice nel blocco.');
    }
    let body;
    try { body = JSON.parse(raw); } catch { return fail(400, 'Richiesta non valida.'); }

    const messages = Array.isArray(body.messages)
      ? body.messages
          .filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(0, 10)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    if (!messages.length) return fail(400, 'Nessun messaggio da inviare.');

    const limited = await checkDailyLimit(request, env);
    if (limited) return limited;

    const temperature = Math.min(Math.max(Number(body.temperature) || 0.2, 0), 1);
    let upstream;
    try {
      upstream = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: MAX_OUTPUT_TOKENS }),
      });
    } catch {
      return fail(502, 'Il servizio IA non risponde. Riprova tra poco.');
    }

    if (upstream.status === 429) {
      return fail(429, 'Il servizio gratuito è molto usato in questo momento: riprova tra qualche minuto.');
    }
    if (upstream.status === 401 || upstream.status === 403) {
      let detail = '';
      try { detail = (await upstream.json())?.error?.message || ''; } catch { /* niente */ }
      return fail(502, `Il server di Rust Notepad non è configurato bene (chiave rifiutata${detail ? ': ' + detail : ''}).`);
    }
    if (!upstream.ok) {
      return fail(502, `Errore del servizio IA (${upstream.status}). Riprova tra poco.`);
    }

    const data = await upstream.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    // Rispondiamo nel formato OpenAI, ma solo con il testo (niente dettagli interni).
    return json({ choices: [{ index: 0, message: { role: 'assistant', content } }] });
  },
};
