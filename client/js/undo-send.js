// Undo send: the message is held for a few seconds before it is submitted. The delay is a per-browser
// preference (account menu). Nothing is sent while the countdown runs, so "Undo" is a true cancel.
(function () {
  const KEY = 'tu-mail-undo-seconds';
  const OPTIONS = [0, 5, 10, 20, 30];
  const DEFAULT = 10;

  function seconds() {
    try {
      const v = Number(localStorage.getItem(KEY));
      if (OPTIONS.includes(v) && localStorage.getItem(KEY) !== null) return v;
    } catch (e) { /* default */ }
    return DEFAULT;
  }
  function setSeconds(n) { try { localStorage.setItem(KEY, String(n)); } catch (e) { /* applies until reload */ } }
  function label() { const n = seconds(); return n ? 'Undo send: ' + n + ' s' : 'Undo send: off'; }
  function cycle() { setSeconds(OPTIONS[(OPTIONS.indexOf(seconds()) + 1) % OPTIONS.length]); return label(); }

  // Resolves true when the time is up, false if the person pressed Undo.
  function wait() {
    const n = seconds();
    if (!n) return Promise.resolve(true);
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'undo-send';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      const text = document.createElement('span');
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = 'Undo';
      const bar = document.createElement('i');
      bar.className = 'undo-bar';
      bar.style.animation = 'undo-countdown ' + n + 's linear forwards';
      box.append(text, undo, bar);
      document.body.append(box);
      let left = n;
      const paint = () => { text.textContent = 'Sending in ' + left + ' s…'; };
      paint();
      const done = (go) => { clearInterval(tick); box.remove(); resolve(go); };
      const tick = setInterval(() => { left -= 1; if (left <= 0) done(true); else paint(); }, 1000);
      undo.addEventListener('click', () => done(false));
      undo.focus({ preventScroll: true });
    });
  }

  window.UndoSend = { seconds, setSeconds, label, cycle, wait, OPTIONS };
})();
