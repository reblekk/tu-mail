// Accessibility fixes applied to the whole interface, including parts the scripts build later.
(function () {
  function decorate(root) {
    if (!root || root.nodeType !== 1) return;
    // Icons next to text or inside a labelled control are decoration.
    const svgs = root.matches && root.matches('svg') ? [root] : root.querySelectorAll ? root.querySelectorAll('svg') : [];
    for (const svg of svgs) {
      if (!svg.hasAttribute('aria-hidden') && !svg.hasAttribute('aria-label')) { svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); }
    }
    const dialogs = root.matches && root.matches('.cmp-dialog,.cmp-window,.att-viewer') ? [root] : root.querySelectorAll ? root.querySelectorAll('.cmp-dialog,.cmp-window,.att-viewer') : [];
    for (const d of dialogs) {
      if (d.getAttribute('role')) continue;
      d.setAttribute('role', 'dialog');
      d.setAttribute('aria-modal', 'true');
      const heading = d.querySelector('h1,h2,h3');
      if (heading) d.setAttribute('aria-label', heading.textContent.trim());
    }
    // Toasts and snack bars announce themselves.
    const live = root.matches && root.matches('.mail-snack') ? [root] : root.querySelectorAll ? root.querySelectorAll('.mail-snack') : [];
    for (const l of live) if (!l.getAttribute('role')) { l.setAttribute('role', 'status'); l.setAttribute('aria-live', 'polite'); }
  }
  function current(root) {
    if (!root || !root.querySelectorAll) return;
    for (const el of root.querySelectorAll('.mail-item, .mail-folder')) {
      const on = el.classList.contains('selected') || el.classList.contains('active');
      if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
    }
  }
  function start() {
    decorate(document.body);
    new MutationObserver((records) => {
      let dirty = false;
      for (const r of records) {
        if (r.type === 'childList') { for (const n of r.addedNodes) { decorate(n); } dirty = true; }
        else if (r.type === 'attributes' && r.target.matches && r.target.matches('.mail-item,.mail-folder')) {
          const on = r.target.classList.contains('selected') || r.target.classList.contains('active');
          if (on) r.target.setAttribute('aria-current', 'true'); else r.target.removeAttribute('aria-current');
        }
      }
      if (dirty) current(document.getElementById('mail-app') || document.body);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  // Skip link target: move focus along with the scroll.
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('.skip-link');
    if (!link) return;
    const target = document.querySelector(link.getAttribute('href'));
    if (target) { e.preventDefault(); target.setAttribute('tabindex', '-1'); target.focus(); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
