// Registers the offline shell and offers "Install app" where the browser supports it.
(function () {
  let deferred = null;
  window.TuPwa = {
    canInstall: () => !!deferred,
    install: async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (e) { /* dismissed */ }
      deferred = null;
    },
  };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    window.dispatchEvent(new Event('tu-install-ready'));
  });
  window.addEventListener('appinstalled', () => { deferred = null; });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
})();
