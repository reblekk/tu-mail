// Language switch and printing. The mail page adds the language switch to its account menu
// (auth.js); the sign-in page gets a small bar in the header.
(function () {
  const langLabel = () => (window.TuI18n.lang === 'de' ? 'Language: Deutsch' : 'Language: English');
  // Pictures in messages: shown by default; the person can switch this off (per browser).
  const PICTURES_KEY = 'tu-mail-pictures';
  const picturesOn = () => { try { return localStorage.getItem(PICTURES_KEY) !== 'off'; } catch (e) { return true; } };
  const picturesLabel = () => (picturesOn() ? 'Pictures: on' : 'Pictures: off');
  const togglePictures = () => { try { localStorage.setItem(PICTURES_KEY, picturesOn() ? 'off' : 'on'); } catch (e) { /* stays as it was */ } return picturesLabel(); };
  window.TuPrefs = {
    picturesOn, picturesLabel, togglePictures,
    langLabel,
    toggleLang: () => window.TuI18n.set(window.TuI18n.lang === 'de' ? 'en' : 'de'),
  };

  function loginBar() {
    const header = document.querySelector('.site-header');
    if (!header || !document.getElementById('login')) return;
    const bar = document.createElement('div');
    bar.className = 'prefs-bar';
    const lang = document.createElement('button');
    lang.type = 'button';
    lang.textContent = langLabel();
    lang.addEventListener('click', () => window.TuPrefs.toggleLang());
    bar.append(lang);
    header.append(bar);
  }

  // Message bodies live in fixed-height frames; open them up for the print job and put them back.
  const saved = new Map();
  window.addEventListener('beforeprint', () => {
    for (const frame of document.querySelectorAll('iframe.msg-frame')) {
      try {
        saved.set(frame, frame.style.height);
        frame.style.height = frame.contentDocument.documentElement.scrollHeight + 8 + 'px';
      } catch (e) { /* cross-origin frames are not expected here */ }
    }
  });
  window.addEventListener('afterprint', () => {
    for (const [frame, height] of saved) frame.style.height = height;
    saved.clear();
  });
  window.printMessage = () => window.print();
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#msg-print')) window.printMessage(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loginBar); else loginBar();
})();
