// Loaded in <head> so the right theme is set before the first paint. The preference is
// 'system' (default), 'light' or 'dark'; the page always carries the resolved theme in
// data-theme, which is all the stylesheet looks at.
(function () {
  var KEY = 'tu-mail-theme';
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; } }
  function resolve(pref) { return pref === 'system' ? (query && query.matches ? 'dark' : 'light') : pref; }
  function apply() {
    var theme = resolve(stored());
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#16171a' : '#b90f22');
  }
  function set(pref) {
    try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch (e) { /* private mode: applies for this page only */ }
    apply();
  }
  var ORDER = ['system', 'light', 'dark'];
  window.TuTheme = {
    get: stored,
    set: set,
    next: function () { var pref = ORDER[(ORDER.indexOf(stored()) + 1) % ORDER.length]; set(pref); return pref; },
  };
  if (query && query.addEventListener) query.addEventListener('change', apply);
  apply();
})();
