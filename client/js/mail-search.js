// Search filters (from, to, subject, dates, attachment, flagged) and saved searches. The filters live
// in state.filters and ride along on every list request (see addFilterParams in mail-app.js).
// Saved searches are kept in this browser, per account.
(function () {
  const FIELDS = [['from', 'flt-from'], ['to', 'flt-to'], ['subject', 'flt-subject'], ['since', 'flt-since'], ['before', 'flt-before']];
  const FLAGS = [['attach', 'flt-attach'], ['flagged', 'flt-flagged']];
  const MAX_SAVED = 20;
  const panel = $('mail-filter-panel');
  const chip = $('chip-filters');

  function readForm() {
    const filters = {};
    for (const [key, id] of FIELDS) { const v = $(id).value.trim(); if (v) filters[key] = v; }
    for (const [key, id] of FLAGS) if ($(id).checked) filters[key] = true;
    return filters;
  }
  function fillForm(filters) {
    for (const [key, id] of FIELDS) $(id).value = filters[key] || '';
    for (const [key, id] of FLAGS) $(id).checked = !!filters[key];
  }
  function refreshChip() {
    const n = Object.keys(state.filters).length;
    chip.classList.toggle('active', n > 0);
    chip.textContent = n ? 'Filters (' + n + ')' : 'Filters';
  }
  let stopWatching = null;
  function setOpen(open) {
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
    if (stopWatching) { stopWatching(); stopWatching = null; }
    if (open) stopWatching = window.TuOutside.watch((t) => panel.contains(t) || chip.contains(t), () => setOpen(false), [panel, chip]);
  }
  function apply(filters) {
    state.filters = filters;
    refreshChip();
    loadMessages(true);
  }

  // ---- saved searches
  const storageKey = () => 'tu-mail-saved-searches:' + (typeof user !== 'undefined' && user ? user.userId : '');
  function loadSaved() {
    try { const v = JSON.parse(localStorage.getItem(storageKey())); return Array.isArray(v) ? v.filter((s) => s && typeof s.name === 'string') : []; } catch (e) { return []; }
  }
  function storeSaved(list) { try { localStorage.setItem(storageKey(), JSON.stringify(list)); } catch (e) { toast('Could not save in this browser.'); } }
  function renderSaved() {
    const list = $('saved-list');
    list.replaceChildren();
    const saved = loadSaved();
    $('saved-list').parentElement.querySelector('.saved-head').hidden = !saved.length;
    saved.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'saved-row';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'mail-chip';
      use.textContent = s.name;
      use.addEventListener('click', () => applySaved(s));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mail-icon-btn saved-del';
      del.setAttribute('aria-label', 'Delete saved search');
      del.title = 'Delete saved search';
      del.textContent = '×';
      del.addEventListener('click', () => { const next = loadSaved(); next.splice(i, 1); storeSaved(next); renderSaved(); });
      row.append(use, del);
      list.append(row);
    });
  }
  function applySaved(s) {
    $('mail-search').value = s.q || '';
    $('mail-search-clear').hidden = !s.q;
    state.q = s.q || '';
    state.scopeAll = !!s.scopeAll;
    $('scope-all').checked = state.scopeAll;
    $('scope-wrap').classList.toggle('show', !!state.q);
    state.unreadOnly = !!s.unreadOnly;
    $('chip-all').classList.toggle('active', !state.unreadOnly);
    $('chip-unread').classList.toggle('active', state.unreadOnly);
    fillForm(s.filters || {});
    apply(Object.assign({}, s.filters || {}));
  }
  function saveCurrent() {
    const name = $('saved-name').value.trim();
    const filters = readForm();
    const search = { name, q: state.q, scopeAll: state.scopeAll, unreadOnly: state.unreadOnly, filters };
    if (!name) { toast('Name this search first.'); $('saved-name').focus(); return; }
    if (!search.q && !search.unreadOnly && !Object.keys(filters).length) { toast('Nothing to save yet — set a search or a filter.'); return; }
    const list = loadSaved().filter((s) => s.name !== name);
    if (list.length >= MAX_SAVED) { toast('You can keep up to 20 saved searches.'); return; }
    list.push(search);
    storeSaved(list);
    $('saved-name').value = '';
    renderSaved();
    toast('Search saved');
  }

  chip.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('submit', (e) => { e.preventDefault(); apply(readForm()); });
  $('flt-reset').addEventListener('click', () => { fillForm({}); apply({}); });
  $('saved-save').addEventListener('click', saveCurrent);
  $('saved-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); chip.focus(); } });
  renderSaved();
  window.MailSearch = { readForm, fillForm, apply, loadSaved, applySaved };
})();
