// The calendar page: month grid, agenda list, a day panel, and dialogs to add or look at an event.
// Weeks start on Monday. Events come from /api/mail/calendar (see server/services/calendar.js).
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const MAX_SPAN_DAYS = 100;

  // The Monday on or before the first of the month: where the 6-week grid begins.
  function gridStart(year, month) {
    const first = new Date(year, month, 1);
    return new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  }
  // Local days (YYYY-MM-DD) an event touches. All-day ends are exclusive; a timed event that ends at
  // exactly midnight does not spill into the next day.
  function daysOf(ev) {
    const out = [];
    if (ev.allDay) {
      const end = parseYmd(ev.end);
      for (let d = parseYmd(ev.start); (d < end || !out.length) && out.length < MAX_SPAN_DAYS; d = addDays(d, 1)) out.push(ymd(d));
      return out;
    }
    const start = new Date(ev.start), end = new Date(ev.end);
    const last = end > start ? new Date(end.getTime() - 1) : start;
    const stop = new Date(last.getFullYear(), last.getMonth(), last.getDate());
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= stop && out.length < MAX_SPAN_DAYS; d = addDays(d, 1)) out.push(ymd(d));
    return out;
  }
  // day -> events, all-day first and then by start time.
  function byDay(events) {
    const map = new Map();
    for (const ev of events) for (const day of daysOf(ev)) { if (!map.has(day)) map.set(day, []); map.get(day).push(ev); }
    for (const list of map.values()) list.sort((a, b) => (b.allDay - a.allDay) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return map;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { ymd, parseYmd, addDays, gridStart, daysOf, byDay };
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- page
  const $ = (id) => document.getElementById(id);
  const user = requireAuth();
  if (!user) return;
  renderProfileMenu(user);
  const locale = () => (root.TuI18n && root.TuI18n.lang === 'de' ? 'de-DE' : undefined);
  const state = { view: 'month', cursor: new Date(), selected: ymd(new Date()), events: [], token: 0 };
  state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}), 'X-Mail-Account': user.userId };
    if (options.body) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api/mail/calendar' + path, { ...options, headers, credentials: 'same-origin' });
    if (res.status === 401) { clearSession(); location.href = '/index.html'; throw new Error('Session expired'); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
  }
  const showError = (message) => { const el = $('cal-error'); el.textContent = message || ''; el.hidden = !message; };
  const timeLabel = (ev) => {
    if (ev.allDay) return 'All day';
    const s = new Date(ev.start), e = new Date(ev.end);
    const t = (d) => d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    if (ymd(s) === ymd(e) || e <= s) return t(s) + (e > s ? ' – ' + t(e) : '');
    const full = (d) => d.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return full(s) + ' – ' + full(e);
  };
  const dayLabel = (day) => parseYmd(day).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ---------------------------------------------------------------- loading
  async function load() {
    const token = ++state.token;
    let from, to;
    if (state.view === 'month') {
      const start = gridStart(state.cursor.getFullYear(), state.cursor.getMonth());
      from = ymd(start); to = ymd(addDays(start, 42));
    } else {
      const today = new Date();
      from = ymd(today); to = ymd(addDays(today, 60));
    }
    try {
      const data = await api('/events?from=' + from + '&to=' + to);
      if (token !== state.token) return;
      state.events = data.events;
      showError('');
    } catch (err) {
      if (token === state.token) { state.events = []; showError(err.message); }
    }
    render();
  }

  // ---------------------------------------------------------------- drawing
  function render() {
    $('view-month').classList.toggle('active', state.view === 'month');
    $('view-agenda').classList.toggle('active', state.view === 'agenda');
    $('view-month').setAttribute('aria-pressed', String(state.view === 'month'));
    $('view-agenda').setAttribute('aria-pressed', String(state.view === 'agenda'));
    $('cal-month').hidden = state.view !== 'month';
    $('cal-agenda').hidden = state.view !== 'agenda';
    if (state.view === 'month') { renderMonth(); $('cal-heading').textContent = state.cursor.toLocaleDateString(locale(), { month: 'long', year: 'numeric' }); }
    else { renderAgenda(); $('cal-heading').textContent = 'Next 60 days'; }
    renderDay();
  }

  function eventButton(ev, withDate) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-event-btn';
    const title = document.createElement('span');
    title.textContent = ev.title;
    title.setAttribute('data-i18n-skip', '');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = (withDate ? '' : '') + timeLabel(ev) + (ev.location ? ' · ' + ev.location : '');
    if (ev.location) when.setAttribute('data-i18n-skip', '');
    b.append(title, when);
    b.addEventListener('click', () => showEvent(ev));
    return b;
  }

  function renderMonth() {
    const days = byDay(state.events);
    const start = gridStart(state.cursor.getFullYear(), state.cursor.getMonth());
    const names = $('cal-weekdays');
    names.replaceChildren();
    for (let i = 0; i < 7; i++) { const s = document.createElement('span'); s.textContent = addDays(start, i).toLocaleDateString(locale(), { weekday: 'short' }); names.append(s); }
    const grid = $('cal-grid');
    grid.replaceChildren();
    const todayKey = ymd(new Date());
    for (let i = 0; i < 42; i++) {
      const date = addDays(start, i), key = ymd(date), list = days.get(key) || [];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-cell' + (date.getMonth() !== state.cursor.getMonth() ? ' other' : '') + (key === todayKey ? ' today' : '') + (key === state.selected ? ' selected' : '');
      cell.dataset.day = key;
      cell.tabIndex = key === state.selected ? 0 : -1;
      cell.setAttribute('aria-label', dayLabel(key) + (list.length ? ', ' + list.length + (list.length === 1 ? ' event' : ' events') : ''));
      const num = document.createElement('span');
      num.className = 'cal-num';
      num.textContent = String(date.getDate());
      cell.append(num);
      for (const ev of list.slice(0, 3)) {
        const chip = document.createElement('span');
        chip.className = 'cal-chip' + (ev.status === 'tentative' ? ' tentative' : '');
        chip.textContent = (ev.allDay ? '' : new Date(ev.start).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) + ' ') + ev.title;
        chip.setAttribute('data-i18n-skip', '');
        cell.append(chip);
      }
      if (list.length > 3) { const more = document.createElement('span'); more.className = 'cal-more'; more.textContent = '+' + (list.length - 3); cell.append(more); }
      grid.append(cell);
    }
  }

  function renderAgenda() {
    const box = $('cal-agenda');
    box.replaceChildren();
    const days = byDay(state.events);
    const keys = [...days.keys()].sort().filter((k) => k >= ymd(new Date()));
    if (!keys.length) { const p = document.createElement('p'); p.className = 'cal-empty'; p.textContent = 'No events in the next 60 days.'; box.append(p); return; }
    for (const key of keys) {
      const h = document.createElement('h4');
      h.textContent = dayLabel(key);
      h.setAttribute('data-i18n-skip', '');
      const ul = document.createElement('ul');
      for (const ev of days.get(key)) { const li = document.createElement('li'); li.append(eventButton(ev)); ul.append(li); }
      box.append(h, ul);
    }
  }

  function renderDay() {
    $('cal-day-title').textContent = dayLabel(state.selected);
    $('cal-day-title').setAttribute('data-i18n-skip', '');
    const list = $('cal-day-list');
    list.replaceChildren();
    const events = byDay(state.events).get(state.selected) || [];
    if (!events.length) { const li = document.createElement('li'); li.className = 'cal-empty'; li.textContent = 'Nothing planned.'; list.append(li); }
    for (const ev of events) { const li = document.createElement('li'); li.append(eventButton(ev)); list.append(li); }
  }

  // ---------------------------------------------------------------- dialogs
  function dialog(title) {
    const d = document.createElement('dialog');
    d.className = 'mail-utility-dialog';
    d.setAttribute('aria-labelledby', 'cal-dialog-title');
    const h = document.createElement('h2');
    h.id = 'cal-dialog-title';
    h.textContent = title;
    d.append(h);
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    return d;
  }
  const button = (text, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', onClick); return b; };
  const line = (label, value, skip) => { const p = document.createElement('p'); p.textContent = label + ': ' + value; if (skip) p.setAttribute('data-i18n-skip', ''); return p; };

  async function showEvent(ev) {
    const d = dialog(ev.title);
    d.firstChild.setAttribute('data-i18n-skip', '');
    const body = document.createElement('div');
    body.className = 'cal-detail';
    body.append(line('When', dayLabel(ev.allDay ? ev.start : ymd(new Date(ev.start))) + ' · ' + timeLabel(ev), true));
    if (ev.location) body.append(line('Location', ev.location, true));
    if (ev.status === 'tentative') { const p = document.createElement('p'); p.textContent = 'Tentative'; body.append(p); }
    d.append(body);
    try {
      const full = await api('/events/' + ev.id);
      if (full.description) { const p = document.createElement('p'); p.textContent = full.description; p.setAttribute('data-i18n-skip', ''); body.append(p); }
      if (full.recurring) { const p = document.createElement('p'); p.textContent = 'This event repeats.'; body.append(p); }
    } catch (err) { /* the summary is enough */ }
    const del = button('Delete', () => {
      if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Click again to delete'; return; }
      api('/events/' + ev.id, { method: 'DELETE' }).then(() => { d.close(); load(); }, (err) => showError(err.message));
    });
    d.append(del, button('Close', () => d.close()));
    d.showModal();
  }

  function newEvent(day) {
    const d = dialog('New event');
    const form = document.createElement('form');
    form.className = 'cal-form';
    const base = parseYmd(day || state.selected);
    const local = (date, h) => ymd(date) + 'T' + pad(h) + ':00';
    form.innerHTML = '<label for="ev-title">Title</label><input type="text" id="ev-title" maxlength="300" required>'
      + '<div class="check"><input type="checkbox" id="ev-allday"><label for="ev-allday" style="margin:0">All day</label></div>'
      + '<div class="row"><div><label for="ev-start">Starts</label><input type="datetime-local" id="ev-start" required></div>'
      + '<div><label for="ev-end">Ends</label><input type="datetime-local" id="ev-end"></div></div>'
      + '<label for="ev-where">Location</label><input type="text" id="ev-where" maxlength="300">'
      + '<label for="ev-notes">Notes</label><textarea id="ev-notes" rows="3" maxlength="5000"></textarea>';
    d.append(form);
    const f = (id) => form.querySelector('#' + id);
    f('ev-start').value = local(base, 9);
    f('ev-end').value = local(base, 10);
    f('ev-allday').addEventListener('change', () => {
      const all = f('ev-allday').checked;
      for (const id of ['ev-start', 'ev-end']) {
        const input = f(id), v = input.value.slice(0, 10);
        input.type = all ? 'date' : 'datetime-local';
        input.value = all ? v : v + (id === 'ev-start' ? 'T09:00' : 'T10:00');
      }
    });
    const error = document.createElement('p');
    error.className = 'form-error';
    error.setAttribute('role', 'alert');
    const save = document.createElement('button');
    save.type = 'submit'; save.textContent = 'Save';
    form.append(error, save, button('Cancel', () => d.close()));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const allDay = f('ev-allday').checked;
      const conv = (v) => (allDay ? v : v ? new Date(v).toISOString() : '');
      try {
        await api('/events', { method: 'POST', body: JSON.stringify({ title: f('ev-title').value, allDay, start: conv(f('ev-start').value), end: conv(f('ev-end').value), location: f('ev-where').value, description: f('ev-notes').value }) });
        d.close();
        state.selected = f('ev-start').value.slice(0, 10);
        const sel = parseYmd(state.selected);
        state.cursor = new Date(sel.getFullYear(), sel.getMonth(), 1);
        load();
      } catch (err) { error.textContent = err.message; }
    });
    d.showModal();
    f('ev-title').focus();
  }

  // ---------------------------------------------------------------- navigation
  function shift(months) { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + months, 1); state.selected = ymd(state.cursor); load(); }
  $('cal-prev').addEventListener('click', () => shift(-1));
  $('cal-next').addEventListener('click', () => shift(1));
  $('cal-today').addEventListener('click', () => { const t = new Date(); state.cursor = new Date(t.getFullYear(), t.getMonth(), 1); state.selected = ymd(t); load(); });
  $('view-month').addEventListener('click', () => { state.view = 'month'; load(); });
  $('view-agenda').addEventListener('click', () => { state.view = 'agenda'; load(); });
  $('cal-new').addEventListener('click', () => newEvent(state.selected));
  $('cal-day-add').addEventListener('click', () => newEvent(state.selected));
  $('cal-export').href = '/api/mail/calendar/export.ics?account=' + encodeURIComponent(user.userId);
  $('cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    state.selected = cell.dataset.day;
    renderMonth(); renderDay();
    $('cal-grid').querySelector('.cal-cell.selected').focus();
  });
  // Arrow keys move through days, PageUp/PageDown through months.
  $('cal-grid').addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step && e.key !== 'PageUp' && e.key !== 'PageDown') return;
    e.preventDefault();
    const sel = parseYmd(state.selected);
    const next = step ? addDays(sel, step) : new Date(sel.getFullYear(), sel.getMonth() + (e.key === 'PageUp' ? -1 : 1), sel.getDate());
    state.selected = ymd(next);
    const needsLoad = next.getMonth() !== state.cursor.getMonth() || next.getFullYear() !== state.cursor.getFullYear();
    if (needsLoad) { state.cursor = new Date(next.getFullYear(), next.getMonth(), 1); load().then(() => { const c = $('cal-grid').querySelector('.cal-cell.selected'); if (c) c.focus(); }); }
    else { renderMonth(); renderDay(); $('cal-grid').querySelector('.cal-cell.selected').focus(); }
  });

  load();
})(typeof window !== 'undefined' ? window : globalThis);
