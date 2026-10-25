// Per-message tools: export as .eml, and translate to English. Translation runs on the device when the
// browser supports it (the text never leaves the machine); otherwise it goes through the translation
// server the operator configured, if any. With neither, the Translate button stays hidden.
(function (root) {
  const MAX_CHARS = 20000;

  // Splits text nodes into batches the server accepts (a few hundred parts, a bounded total size).
  function batches(texts, maxParts = 250, maxChars = 25000) {
    const out = [];
    let cur = [], size = 0;
    texts.forEach((t, i) => {
      if (cur.length && (cur.length >= maxParts || size + t.length > maxChars)) { out.push(cur); cur = []; size = 0; }
      cur.push(i);
      size += t.length;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  // Leading and trailing spaces belong to the layout, not to the sentence, so keep them out of the request.
  function split(value) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    return { lead: m[1], core: m[2], tail: m[3] };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { batches, split };
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- availability
  const onDevice = () => 'Translator' in window && 'LanguageDetector' in window;
  const viaServer = () => !!(root.TuFeatures && root.TuFeatures.translate);
  function refresh() { document.body.classList.toggle('can-translate', onDevice() || viaServer()); }
  window.addEventListener('tu-brand-ready', refresh);
  document.addEventListener('DOMContentLoaded', refresh);

  // ---------------------------------------------------------------- export
  function exportCurrent() {
    const cur = typeof state !== 'undefined' ? state.current : null;
    if (!cur) { toast('Open a message first.'); return; }
    const folder = cur.folder || state.folder;
    const a = document.createElement('a');
    a.href = '/api/mail/messages/' + encodeURIComponent(cur.uid) + '/export?folder=' + encodeURIComponent(folder) + '&account=' + encodeURIComponent(user.userId);
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------------------------------------------------------------- translate
  const languageName = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (e) { return code; } };

  async function translateOnDevice(texts) {
    const sample = texts.join(' ').slice(0, 2000);
    const detector = await LanguageDetector.create();
    const guess = (await detector.detect(sample))[0];
    const source = guess && guess.detectedLanguage;
    if (!source || source === 'und') return null;
    if (source === 'en') return { translations: texts, detected: 'en' };
    const options = { sourceLanguage: source, targetLanguage: 'en' };
    if ((await Translator.availability(options)) === 'unavailable') return null;
    const translator = await Translator.create(options);
    const translations = [];
    for (const t of texts) translations.push(await translator.translate(t));
    return { translations, detected: source };
  }

  async function translateViaServer(texts) {
    const out = new Array(texts.length);
    let detected = null;
    for (const group of batches(texts)) {
      const data = await mailFetch('/api/mail/translate', { method: 'POST', body: JSON.stringify({ texts: group.map((i) => texts[i]) }) });
      group.forEach((i, k) => { out[i] = data.translations[k]; });
      detected = detected || data.detected;
    }
    return { translations: out, detected };
  }

  async function translateTexts(texts) {
    if (onDevice()) {
      try { const r = await translateOnDevice(texts); if (r) return r; } catch (e) { /* fall back to the server */ }
    }
    if (viaServer()) return translateViaServer(texts);
    return null;
  }

  function textNodes(doc) {
    const view = doc.defaultView;
    const found = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const el = n.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(el.tagName) || el.closest('.eg-fold')) continue;
      if (!/\p{L}{2}/u.test(n.nodeValue)) continue;
      let hidden = false;
      for (let p = el; p && p !== doc.body; p = p.parentElement) if (view.getComputedStyle(p).display === 'none') { hidden = true; break; }
      if (!hidden) found.push(n);
    }
    return found;
  }

  const states = new WeakMap(); // message frame -> { nodes, original, translated, showing, bar }

  function bar(card, frame) {
    let el = card.querySelector('.translate-bar');
    if (!el) {
      el = document.createElement('div');
      el.className = 'translate-bar';
      el.setAttribute('role', 'status');
      card.querySelector('.card-body').before(el);
    }
    return el;
  }

  async function translateCard(card) {
    const frame = card.querySelector('iframe.msg-frame');
    const doc = frame && frame.contentDocument;
    if (!doc || !doc.body) return;
    const prior = states.get(frame);
    const barEl = bar(card, frame);
    if (prior) { toggle(frame, prior, barEl); return; }

    barEl.replaceChildren();
    const note = document.createElement('span');
    note.className = 'tr-note';
    note.textContent = 'Translating…';
    barEl.append(note);

    let nodes = textNodes(doc);
    let truncated = false;
    let used = 0;
    nodes = nodes.filter((n) => { used += n.nodeValue.length; if (used > MAX_CHARS) { truncated = true; return false; } return true; });
    if (!nodes.length) { barEl.remove(); toast('There is no text to translate.'); return; }
    const parts = nodes.map((n) => split(n.nodeValue));
    try {
      const result = await translateTexts(parts.map((p) => p.core));
      if (!result) { barEl.remove(); toast('Translation is not available.', 'error'); return; }
      if (result.detected === 'en') { barEl.remove(); toast('This message is already in English.'); return; }
      const original = nodes.map((n) => n.nodeValue);
      const translated = nodes.map((n, i) => parts[i].lead + (result.translations[i] || parts[i].core) + parts[i].tail);
      const state = { nodes, original, translated, showing: true, from: result.detected, truncated };
      states.set(frame, state);
      nodes.forEach((n, i) => { n.nodeValue = translated[i]; });
      paint(frame, state, barEl);
    } catch (err) {
      barEl.remove();
      toast(err && err.message ? err.message : 'The translation failed. Try again.', 'error');
    }
  }

  function paint(frame, state, barEl) {
    barEl.replaceChildren();
    const note = document.createElement('span');
    note.className = 'tr-note';
    if (state.showing) note.textContent = state.from ? 'Translated to English from ' + languageName(state.from) + '.' : 'Translated to English.';
    else note.textContent = 'Showing the original text.';
    if (state.truncated) note.textContent += ' Only the first part of this long message was translated.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state.showing ? 'Show original' : 'Show translation';
    button.addEventListener('click', () => toggle(frame, state, barEl));
    barEl.append(note, button);
  }

  function toggle(frame, state, barEl) {
    state.showing = !state.showing;
    state.nodes.forEach((n, i) => { n.nodeValue = state.showing ? state.translated[i] : state.original[i]; });
    paint(frame, state, barEl);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    if (e.target.closest('#msg-export')) { exportCurrent(); return; }
    const t = e.target.closest('[data-act="translate"]');
    if (t) translateCard(t.closest('.msg-card'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'x' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
    if (typeof state !== 'undefined' && state.current) { e.preventDefault(); exportCurrent(); }
  });

  root.MailMessageTools = { exportCurrent, translateCard };
})(typeof window !== 'undefined' ? window : globalThis);
