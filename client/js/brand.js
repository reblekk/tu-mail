// Applies the operator's branding (name, colour, logo, footer, help link) from /api/brand. The page
// works unbranded if the request fails.
(function () {
  function apply(b) {
    window.TuFeatures = b.features || {};
    const root = document.documentElement;
    root.style.setProperty('--navy', b.color);
    root.style.setProperty('--navy-dark', b.colorDark);
    root.style.setProperty('--navy-tint', b.colorTint);
    root.style.setProperty('--emerald', b.color);
    root.style.setProperty('--emerald-dark', b.colorDark);
    root.style.setProperty('--emerald-tint', b.colorTint);
    root.style.setProperty('--accent', b.color);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', b.color);
    for (const img of document.querySelectorAll('.tu-header-logo, .university-logo')) {
      if (b.logoUrl) { img.src = b.logoUrl; img.alt = b.name; }
    }
    for (const el of document.querySelectorAll('.service-name')) el.textContent = b.name;
    for (const el of document.querySelectorAll('.help')) if (b.helpUrl) el.href = b.helpUrl;
    const footer = document.querySelector('body > footer');
    if (footer && b.footer) footer.textContent = b.footer;
    window.TuBrandName = b.name;
    document.title = document.title.replace(/TUDa Mail/g, b.name);
    window.dispatchEvent(new Event('tu-brand-ready'));
  }
  function start() {
    fetch('/api/brand', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((b) => { if (b) apply(b); }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
