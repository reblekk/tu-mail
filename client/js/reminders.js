// "Remind me": pick a time for the open message and the app reminds you while it is open. Reminders
// are stored in this browser, per account; the message itself is not changed or moved.
(function (root) {
  const MAX = 100;

  // Preset times, as timestamps. Weekends are not special-cased.
  function presets(now) {
    const d = new Date(now);
    const at = (days, hour) => { const t = new Date(d); t.setDate(t.getDate() + days); t.setHours(hour, 0, 0, 0); return t.getTime(); };
    const evening = at(0, 18);
    // The coming Monday, but never tomorrow: "next week" must differ from "tomorrow morning".
    let toMonday = (8 - d.getDay()) % 7 || 7;
    if (toMonday < 2) toMonday += 7;
    const monday = new Date(d); monday.setDate(monday.getDate() + toMonday); monday.setHours(8, 0, 0, 0);
    const list = [{ label: 'In 1 hour', due: now + 3600000 }];
    if (evening > now + 30 * 60000) list.push({ label: 'This evening', due: evening });
    list.push({ label: 'Tomorrow morning', due: at(1, 8) }, { label: 'Next week', due: monday.getTime() });
    return list;
  }
  function dueNow(reminders, now) { return reminders.filter((r) => r.due <= now); }
  function clean(list) {
    return (Array.isArray(list) ? list : []).filter((r) => r && Number.isFinite(r.due) && typeof r.uid === 'number' && typeof r.folder === 'string')
      .map((r) => ({ id: String(r.id || r.due + ':' + r.uid), folder: r.folder, uid: r.uid, subject: String(r.subject || '').slice(0, 200), from: String(r.from || '').slice(0, 120), due: r.due, notified: !!r.notified }));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { presets, dueNow, clean };
  if (typeof document === 'undefined') return;

  const key = () => 'tu-mail-reminders:' + (typeof user !== 'undefined' && user ? user.userId : '');
  const load = () => { try { return clean(JSON.parse(localStorage.getItem(key()))); } catch (e) { return []; } };
  const save = (list) => { try { localStorage.setItem(key(), JSON.stringify(list.slice(0, MAX))); } catch (e) { toast('Could not save in this browser.'); } };
  const fmt = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  function dialog(title) {
    const d = document.createElement('dialog');
    d.className = 'mail-utility-dialog';
    const h = document.createElement('h2');
    h.textContent = title;
    d.append(h);
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    return d;
  }
  const button = (text, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', onClick); return b; };

  function add(message, due) {
    const list = load().filter((r) => !(r.folder === message.folder && r.uid === message.uid));
    list.push({ id: due + ':' + message.uid, folder: message.folder, uid: message.uid, subject: message.subject, from: message.from, due, notified: false });
    save(list.sort((a, b) => a.due - b.due));
    refreshMenuLabel();
    toast('Reminder set for ' + fmt(due));
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  function chooseTime() {
    const cur = typeof state !== 'undefined' ? state.current : null;
    if (!cur) { toast('Open a message first.'); return; }
    const message = { folder: cur.folder || state.folder, uid: cur.uid, subject: cur.subject || '(no subject)', from: (cur.from && (cur.from.name || cur.from.address)) || '' };
    const d = dialog('Remind me');
    const menu = document.createElement('div');
    menu.className = 'remind-menu';
    for (const p of presets(Date.now())) menu.append(button(p.label + ' · ' + fmt(p.due), () => { add(message, p.due); d.close(); }));
    const custom = document.createElement('input');
    custom.type = 'datetime-local';
    custom.setAttribute('aria-label', 'Pick a date and time');
    const pad = (n) => String(n).padStart(2, '0');
    const soon = new Date(Date.now() + 3600000);
    custom.value = soon.getFullYear() + '-' + pad(soon.getMonth() + 1) + '-' + pad(soon.getDate()) + 'T' + pad(soon.getHours()) + ':00';
    menu.append(custom, button('Set reminder', () => {
      const ts = new Date(custom.value).getTime();
      if (!Number.isFinite(ts) || ts <= Date.now()) { toast('Pick a time in the future.'); return; }
      add(message, ts); d.close();
    }));
    d.append(menu, button('Close', () => d.close()));
    d.showModal();
  }

  function showList() {
    const d = dialog('Reminders');
    const reminders = load();
    if (!reminders.length) { const p = document.createElement('p'); p.textContent = 'No reminders.'; d.append(p); }
    for (const r of reminders) {
      const row = document.createElement('div');
      row.className = 'reminder-row' + (r.due <= Date.now() ? ' due' : '');
      const main = document.createElement('div');
      main.className = 'rem-main';
      const title = document.createElement('div');
      title.textContent = r.subject || '(no subject)';
      title.setAttribute('data-i18n-skip', '');
      const when = document.createElement('span');
      when.className = 'rem-when';
      when.textContent = fmt(r.due);
      when.setAttribute('data-i18n-skip', '');
      main.append(title, when);
      row.append(main,
        button('Open', () => { d.close(); go(r.folder, r.uid); }),
        button('Dismiss', () => { save(load().filter((x) => x.id !== r.id)); row.remove(); refreshMenuLabel(); }));
      d.append(row);
    }
    d.append(button('Close', () => d.close()));
    d.showModal();
  }

  function check() {
    const list = load();
    const fresh = dueNow(list, Date.now()).filter((r) => !r.notified);
    if (!fresh.length) return;
    for (const r of fresh) {
      r.notified = true;
      toast('Reminder: ' + (r.subject || '(no subject)'));
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Reminder', { body: r.subject || '(no subject)' }); } catch (e) { /* not available */ }
      }
    }
    save(list);
    refreshMenuLabel();
  }

  let labelEl = null;
  const label = () => { const n = dueNow(load(), Date.now()).length; return n ? 'Reminders (' + n + ')' : 'Reminders'; };
  function refreshMenuLabel() { if (labelEl) labelEl.textContent = label(); }

  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#msg-remind')) chooseTime(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'b' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
    if (typeof state !== 'undefined' && state.current) { e.preventDefault(); chooseTime(); }
  });
  setInterval(check, 30000);
  setTimeout(check, 2000);

  root.MailReminders = { label, showList, bindLabel: (el) => { labelEl = el; refreshMenuLabel(); }, presets };
})(typeof window !== 'undefined' ? window : globalThis);
