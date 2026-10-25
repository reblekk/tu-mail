// Desktop notifications for new mail while a Mail tab is open (hidden tabs included). Off by default; the
// choice is per browser. "Count only" shows how many unread messages there are; "Sender and subject" shows
// who wrote, which is more useful but visible to anyone who can see the screen. Nothing runs when the
// tab is closed: the server holds no credentials in the background (see the README).
(function (root) {
  const KEY = 'tu-mail-notify';
  const MODES = ['off', 'count', 'detail'];
  const LABELS = { off: 'Notifications: off', count: 'Notifications: count only', detail: 'Notifications: sender and subject' };

  const next = (mode) => MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  // What to show for one poll result; `t` translates the fixed sentences.
  function describe(mode, result, t = (s) => s) {
    const latest = (result && result.latest) || [];
    if (mode === 'off' || !latest.length) return null;
    if (mode === 'count') {
      const n = result.unseen || latest.length;
      return { title: t('New mail'), body: t('You have ' + n + (n === 1 ? ' unread message' : ' unread messages')) };
    }
    const lines = latest.slice(-3).reverse().map((m) => (m.from || '?') + ' — ' + (m.subject || t('(no subject)')));
    return { title: t(latest.length === 1 ? 'New message' : 'New mail'), body: lines.join('\n') };
  }
  // Ask once per sign-in, and only when it can help: notifications are off, this is the mail page, the browser
  // supports them and has not been told to block them for good.
  function shouldPrompt({ page, flag, mode, supported, permission }) {
    return page === 'mail' && flag === '1' && mode === 'off' && !!supported && permission !== 'denied';
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { next, describe, shouldPrompt, MODES, LABELS };
  if (typeof document === 'undefined') return;

  const stored = () => { try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : 'off'; } catch (e) { return 'off'; } };
  const save = (mode) => { try { localStorage.setItem(KEY, mode); } catch (e) { /* applies until reload */ } };
  let mode = stored();
  let last = -1; // newest message number already announced (or present when we started)
  let timer = null;

  async function poll() {
    if (mode === 'off' || !('Notification' in root) || Notification.permission !== 'granted') return;
    try {
      const data = await mailFetch('/api/mail/unread?since=0' + (last >= 0 ? '&after=' + last : ''));
      const newest = Math.max(0, (data.uidNext || 1) - 1);
      if (last < 0) { last = newest; return; }
      const shown = describe(mode, data, root.TuI18n ? root.TuI18n.t : undefined);
      last = Math.max(last, newest);
      if (!shown || (!document.hidden && document.hasFocus())) return;
      const n = new Notification(shown.title, { body: shown.body, tag: 'tu-mail-new', renotify: true, icon: '/assets/icon-192.png' });
      n.onclick = () => { root.focus(); n.close(); if (typeof go === 'function') go('INBOX', data.latest.length === 1 ? data.latest[0].uid : undefined); };
    } catch (e) { /* the next poll tries again */ }
  }
  function schedule() {
    clearInterval(timer);
    timer = null;
    if (mode !== 'off') { timer = setInterval(poll, 60000); poll(); }
  }

  async function set(wanted) {
    if (wanted !== 'off') {
      if (!('Notification' in root)) { toast('This browser does not support notifications.'); return label(); }
      if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* treated as denied */ } }
      if (Notification.permission !== 'granted') { toast('Notifications are blocked in your browser settings.', 'error'); mode = 'off'; save(mode); schedule(); return label(); }
    }
    mode = wanted;
    save(mode);
    last = -1;
    schedule();
    root.dispatchEvent(new Event('tu-notify-changed'));
    return label();
  }
  const cycle = () => set(next(mode));
  const label = () => LABELS[mode];

  // The reminder shown after signing in while notifications are off.
  function prompt() {
    if (document.querySelector('dialog[open]')) { setTimeout(prompt, 3000); return; }
    const d = document.createElement('dialog');
    d.className = 'mail-utility-dialog notify-prompt';
    d.setAttribute('aria-labelledby', 'notify-prompt-title');
    d.addEventListener('close', () => d.remove());
    const title = document.createElement('h2');
    title.id = 'notify-prompt-title';
    title.textContent = 'Turn on notifications?';
    const text = document.createElement('p');
    text.textContent = 'Get a desktop alert when new mail arrives while this tab is open. Choose what the alert shows.';
    const choose = (label, wanted) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', async () => { d.close(); await set(wanted); });
      return b;
    };
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Not now';
    later.addEventListener('click', () => d.close());
    d.append(title, text, choose('Count only', 'count'), choose('Sender and subject', 'detail'), later);
    document.body.append(d);
    d.showModal();
  }
  function maybePrompt() {
    let flag = null;
    try { flag = sessionStorage.getItem('tu-mail-notify-prompt'); sessionStorage.removeItem('tu-mail-notify-prompt'); } catch (e) { return; }
    if (shouldPrompt({ page: document.body.dataset.page, flag, mode, supported: 'Notification' in root, permission: root.Notification && Notification.permission })) setTimeout(prompt, 1800);
  }

  root.MailNotify = { label, cycle, set, describe, next, shouldPrompt };
  setTimeout(schedule, 3000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybePrompt); else maybePrompt();
})(typeof window !== 'undefined' ? window : globalThis);
