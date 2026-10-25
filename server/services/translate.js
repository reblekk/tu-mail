// Translation of message text into English through a LibreTranslate-compatible server chosen by the
// operator (TRANSLATE_URL). Nothing is sent anywhere unless the operator sets it, and message text only
// goes to that server. Browsers that can translate on the device never use this.
const MAX_TEXTS = 300;
const MAX_TEXT_CHARS = 5000;
const MAX_TOTAL_CHARS = 30000;

function fail(message, status) { return Object.assign(new Error(message), { status }); }

function fromEnv(env = process.env) {
  if (!env.TRANSLATE_URL) return null;
  let url;
  try { url = new URL(env.TRANSLATE_URL); } catch { throw new Error('TRANSLATE_URL is not a valid URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash) throw new Error('TRANSLATE_URL must be an http(s) address without a query string.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && env.TRANSLATE_ALLOW_HTTP !== 'true') {
    throw new Error('TRANSLATE_URL must use https, because message text is sent to it. Set TRANSLATE_ALLOW_HTTP=true only for a trusted internal network.');
  }
  return {
    endpoint: url.origin + url.pathname.replace(/\/$/, '') + '/translate',
    key: env.TRANSLATE_API_KEY || '',
    timeoutMs: (Number(env.TRANSLATE_TIMEOUT_SECONDS) || 20) * 1000,
  };
}

// Checks what the browser sent. Returns the list of strings to translate.
function validate(texts) {
  if (!Array.isArray(texts) || !texts.length) throw fail('Nothing to translate.', 400);
  if (texts.length > MAX_TEXTS) throw fail('Too many text parts to translate at once.', 413);
  let total = 0;
  for (const t of texts) {
    if (typeof t !== 'string') throw fail('Text parts must be strings.', 400);
    if (t.length > MAX_TEXT_CHARS) throw fail('A text part is too long to translate.', 413);
    total += t.length;
  }
  if (total > MAX_TOTAL_CHARS) throw fail('This message is too long to translate at once.', 413);
  return texts;
}

// fetchImpl is replaceable for tests.
async function translateTexts(config, texts, fetchImpl = fetch) {
  validate(texts);
  let res;
  try {
    res = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, source: 'auto', target: 'en', format: 'text', ...(config.key ? { api_key: config.key } : {}) }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch {
    throw fail('The translation service did not answer. Try again later.', 502);
  }
  if (!res.ok) throw fail('The translation service could not translate this message.', 502);
  let data;
  try { data = await res.json(); } catch { throw fail('The translation service sent an unreadable answer.', 502); }
  const out = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
  if (out.length !== texts.length || out.some((t) => typeof t !== 'string')) throw fail('The translation service sent an unexpected answer.', 502);
  const first = Array.isArray(data.detectedLanguage) ? data.detectedLanguage[0] : data.detectedLanguage;
  const detected = first && typeof first.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(first.language) ? first.language : null;
  return { translations: out, detected };
}

module.exports = { fromEnv, validate, translateTexts, MAX_TEXTS, MAX_TEXT_CHARS, MAX_TOTAL_CHARS };
