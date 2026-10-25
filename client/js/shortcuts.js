// Keyboard shortcuts that sit on top of the ones in mail-app.js (j/k, c, r, a, u, f, /, Esc) and
// mail-organize.js (e, Delete): "?" opens the list, "g" then "i" goes to the Inbox, "p" prints. "b" (reminders) and
// "x" (export) live in reminders.js and message-tools.js and are listed here so the help is complete.
(function () {
  const ROWS = [
    ['j / ↓', 'Move down the list'],
    ['k / ↑', 'Move up the list'],
    ['c', 'Write a new message'],
    ['r', 'Reply to the open message'],
    ['a', 'Reply to all'],
    ['u', 'Toggle unread'],
    ['f', 'Toggle flag'],
    ['e', 'Archive the open message'],
    ['Delete', 'Delete the open message'],
    ['p', 'Print message'],
    ['b', 'Remind me'],
    ['x', 'Export as .eml'],
    ['/', 'Search'],
    ['g then i', 'Go to Inbox'],
    ['Esc', 'Back to the list, or close'],
    ['?', 'Show this help'],
  ];
  let dialog;
  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'mail-utility-dialog shortcuts-dialog';
    dialog.setAttribute('aria-labelledby', 'shortcuts-title');
    const title = document.createElement('h2');
    title.id = 'shortcuts-title';
    title.textContent = 'Keyboard shortcuts';
    const table = document.createElement('table');
    table.className = 'shortcuts-table';
    for (const [keys, what] of ROWS) {
      const row = table.insertRow();
      const k = row.insertCell();
      for (const part of keys.split(' ')) {
        if (part === '/' && keys !== '/') { k.append(' / '); continue; }
        if (['then'].includes(part)) { k.append(' then '); continue; }
        const kbd = document.createElement('kbd');
        kbd.textContent = part;
        k.append(kbd);
      }
      row.insertCell().textContent = what;
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => dialog.close());
    dialog.append(title, table, close);
    document.body.append(dialog);
  }
  window.showShortcuts = () => {
    if (!dialog) build();
    if (!dialog.open) dialog.showModal();
  };

  let pendingG = 0;
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (document.querySelector('dialog[open]') && e.key !== 'Escape') return;
    if (typeof window.composeIsOpen === 'function' && window.composeIsOpen()) return;
    if (e.key === '?') { e.preventDefault(); window.showShortcuts(); return; }
    if (e.key === 'g') { pendingG = Date.now(); return; }
    if (e.key === 'i' && Date.now() - pendingG < 1200) {
      pendingG = 0;
      e.preventDefault();
      if (typeof go === 'function') go('INBOX');
      return;
    }
    if (e.key === 'p' && typeof state !== 'undefined' && state.current) { e.preventDefault(); window.printMessage(); }
  });
})();
