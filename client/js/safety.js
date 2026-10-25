// Phishing hints. These are heuristics that point at things worth a second look; they never block or
// hide a message, and a message with no hint is not thereby safe. The checker is a pure function so the
// rules can be tested; attach() shows the result above a message.
(function (root) {
  const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

  function host(value) {
    try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : 'https://' + value).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return ''; }
  }
  // "mail.example.co.uk" -> "example.co.uk"; "www.tu-darmstadt.de" -> "tu-darmstadt.de".
  function registrable(h) {
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const last = parts[parts.length - 1], second = parts[parts.length - 2];
    return (last.length === 2 && SECOND_LEVEL.has(second) ? parts.slice(-3) : parts.slice(-2)).join('.');
  }
  function levenshtein(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  }
  // Letters people confuse, folded together: "paypa1" and "rnicrosoft" collapse onto the real names.
  function skeleton(domain) {
    return domain.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[01|]/g, (c) => (c === '0' ? 'o' : 'l')).replace(/[-_.]/g, '');
  }
  const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
  const looksLikeAddress = (t) => /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(t);
  const looksLikeUrl = (t) => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(t.trim()) && !/\s/.test(t.trim());

  // message: { from: {name, address}, replyTo: [{address}], links: [{text, href}] }
  // known: domains the reader already deals with (their own, their contacts').
  function analyze(message, known = []) {
    const findings = [];
    const add = (level, text) => { if (!findings.some((f) => f.text === text)) findings.push({ level, text }); };
    const from = message.from || {};
    const fromAddress = String(from.address || '').toLowerCase();
    const fromDomain = fromAddress.split('@')[1] || '';
    const fromReg = registrable(fromDomain);

    const shown = looksLikeAddress(String(from.name || ''));
    if (shown && shown[0].toLowerCase() !== fromAddress) add('high', 'The sender name shows the address ' + shown[0] + ', but the message really comes from ' + fromAddress + '.');

    if (fromDomain && /[^\x00-\x7f]/.test(fromDomain)) add('high', 'The sender\'s domain contains unusual characters that can imitate a familiar name.');
    if (fromDomain.split('.').some((l) => l.startsWith('xn--'))) add('high', 'The sender\'s domain is an internationalised look-alike form (xn--).');

    const knownRegs = [...new Set(known.map((d) => registrable(String(d).toLowerCase())).filter(Boolean))];
    if (fromReg && !knownRegs.includes(fromReg)) {
      for (const k of knownRegs) {
        const label = k.split('.')[0];
        const sameLength = Math.min(fromReg.length, k.length) >= 7;
        if (skeleton(fromReg) === skeleton(k) || (sameLength && levenshtein(fromReg, k) <= 2)) {
          add('high', 'The sender\'s domain ' + fromDomain + ' looks very similar to ' + k + ' but is not the same.');
          break;
        }
        if (label.length >= 6 && fromDomain.includes(label) && !fromDomain.endsWith('.' + k) && fromDomain !== k) {
          add('high', 'The sender\'s domain ' + fromDomain + ' contains "' + label + '" but does not belong to ' + k + '.');
          break;
        }
      }
    }

    for (const r of message.replyTo || []) {
      const rd = registrable(String(r.address || '').toLowerCase().split('@')[1] || '');
      if (rd && fromReg && rd !== fromReg) { add('medium', 'Replies would go to ' + r.address + ', a different domain from the sender\'s.'); break; }
    }

    let mismatches = 0;
    for (const link of message.links || []) {
      const target = host(link.href || '');
      if (!target) continue;
      if (/@/.test((link.href || '').replace(/^[a-z]+:\/\//i, '').split('/')[0])) add('high', 'A link contains a user name before the web address, a common disguise.');
      if (isIp(target)) add('medium', 'A link points to a numeric address (' + target + ') instead of a name.');
      if (target.split('.').some((l) => l.startsWith('xn--'))) add('medium', 'A link points to an internationalised look-alike domain (' + target + ').');
      const text = String(link.text || '').trim();
      if (looksLikeUrl(text) && registrable(host(text)) !== registrable(target) && mismatches < 3) {
        mismatches += 1;
        add('high', 'A link shows "' + text.slice(0, 60) + '" but leads to ' + target + '.');
      }
    }
    return findings;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { analyze, registrable, skeleton, levenshtein, host };
  if (typeof document === 'undefined') return;

  function knownDomains() {
    const domains = ['tu-darmstadt.de'];
    if (typeof user !== 'undefined' && user && user.email) domains.push(user.email.split('@')[1]);
    try { if (typeof savedMailContacts !== 'undefined') for (const c of savedMailContacts) domains.push(String(c.address).split('@')[1]); } catch (e) { /* contacts not loaded yet */ }
    return domains.filter(Boolean);
  }

  function attach(cardEl, m) {
    const slot = cardEl.querySelector('.safety-slot');
    if (!slot || m.fromSelf) return;
    const links = [];
    try {
      const doc = new DOMParser().parseFromString(m.html || '', 'text/html');
      for (const a of doc.querySelectorAll('a[href]')) links.push({ text: a.textContent, href: a.getAttribute('href') });
    } catch (e) { /* analyse the headers only */ }
    const findings = analyze({ from: m.from, replyTo: m.replyTo, links }, knownDomains());
    slot.replaceChildren();
    if (!findings.length) return;
    const box = document.createElement('div');
    box.className = 'safety-banner' + (findings.some((f) => f.level === 'high') ? ' high' : '');
    box.setAttribute('role', 'note');
    const title = document.createElement('strong');
    title.textContent = 'Be careful with this message';
    const list = document.createElement('ul');
    for (const f of findings.slice(0, 5)) { const li = document.createElement('li'); li.textContent = f.text; list.append(li); }
    const note = document.createElement('div');
    note.textContent = 'These are automatic hints, not proof. Do not enter passwords or open attachments unless you are sure of the sender.';
    box.append(title, list, note);
    slot.append(box);
  }
  root.MailSafety = { attach, analyze };
})(typeof window !== 'undefined' ? window : globalThis);
