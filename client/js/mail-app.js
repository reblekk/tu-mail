const user = requireAuth();
if (user) renderProfileMenu(user);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

const ICON = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  drafts: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  sent: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  junk: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  other: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  mailEmpty: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
const svg = (name, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ${extra}>${ICON[name]}</svg>`;

const state = {
  folders: [],
  folder: 'INBOX',
  loaded: false,
  q: '',
  scopeAll: false,
  unreadOnly: false,
  filters: {},
  page: 0,
  pageSize: 40,
  total: 0,
  messages: [],
  listReq: 0,
  snapshots: new Map(),
  loadingMore: false,
  uid: null,
  openReq: 0,
  current: null,
  showImages: false,
  pushedOpen: false,
  selecting: false,
  selected: new Set(),
};

class MailAuthRequired extends Error {}

async function mailFetch(path, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${getToken()}`, 'X-Mail-Account': user.userId };
  // A FormData body (compose/send) must be left alone so the browser sets its multipart boundary.
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch (err) { data = null; }
  if (res.status === 401) {
    if (window.composeIsOpen?.()) throw new MailAuthRequired('Session expired. Your writing is kept locally; sign in again in another tab, then retry.');
    clearSession();
    window.location.href = `${ROOT}index.html`;
    throw new Error('Session expired');
  }
  if (res.status === 409 && data && data.code === 'MAIL_AUTH') throw new MailAuthRequired(data.error);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.code = data && data.code;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ formatting helpers

function colorFor(seed) {
  let h = 0;
  for (const ch of String(seed || '?')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 42% 42%)`;
}
function initials(name, address) {
  const base = (name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return [...parts[0]][0] + [...parts[1]][0];
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('');
  return ([...(address || '?')][0] || '?');
}
function avatar(person, big) {
  const seed = (person && (person.address || person.name)) || '?';
  return `<div class="mail-avatar" style="background:${colorFor(seed)}">${esc(initials(person && person.name, person && person.address))}</div>`;
}
function personLabel(p) {
  return (p && (p.name || p.address)) || '(unknown sender)';
}
function fmtListDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtFullDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function toast(message, type) { showToast(message, type); }

// ------------------------------------------------------------------ top-level states

function showOnly(which) {
  $('mail-state-loading').hidden = which !== 'loading';
  $('mail-state-connect').hidden = which !== 'connect';
  $('mail-state-error').hidden = which !== 'error';
  $('mail-app').hidden = which !== 'app';
}
function showConnect() {
  $('connect-address').textContent = user.email;
  $('connect-username').value = user.email;
  $('connect-password').value = '';
  $('connect-error').textContent = '';
  showOnly('connect');
  setTimeout(() => $('connect-password').focus(), 50);
}
function showFatal(err) {
  if (err instanceof MailAuthRequired) return showConnect();
  $('mail-error-text').textContent = err.message || 'Something went wrong.';
  showOnly('error');
}
function handleError(err) {
  if (err instanceof MailAuthRequired) return showConnect();
  toast(err.message || 'Mail request failed', 'error');
}

$('connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('connect-submit');
  btn.disabled = true;
  $('connect-error').textContent = '';
  try {
    await mailFetch('/api/mail/connect', { method: 'POST', body: JSON.stringify({ password: $('connect-password').value }) });
    start();
  } catch (err) {
    $('connect-error').textContent = err.code === 'MAIL_AUTH' ? "That password didn't open the mailbox." : err.message;
  } finally {
    btn.disabled = false;
  }
});
$('mail-error-retry').addEventListener('click', () => start());

// ------------------------------------------------------------------ folders

function currentFolder() { return state.folders.find((f) => f.path === state.folder); }
function inboxUnseen() { const f = state.folders.find((x) => x.role === 'inbox'); return f ? f.unseen : 0; }

async function loadFolders() {
  state.folders = await mailFetch('/api/mail/folders');
  renderFolders();
}
function renderFolders() {
  $('mail-folder-list').innerHTML = state.folders.map((f) => `
    <li class="mail-folder${f.path === state.folder ? ' active' : ''}${f.unseen ? ' unread' : ''}${f.selectable ? '' : ' disabled'}" data-path="${esc(f.path)}" style="padding-left:${10 + f.depth * 16}px">
      ${svg(f.role)}<span class="name">${esc(f.name)}</span>${f.unseen ? `<span class="count">${f.unseen}</span>` : ''}
      ${f.role === 'other' || f.role === 'trash' || f.role === 'junk' ? `<button type="button" class="folder-more" data-path="${esc(f.path)}" aria-label="Folder options" title="Folder options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>` : ''}
    </li>`).join('');
  const cur = currentFolder();
  const titleHtml = `${esc(cur ? cur.name : 'Mail')}${cur && cur.unseen ? `<span class="unread-pill">${cur.unseen} unread</span>` : ''}`;
  $('mail-folder-title').innerHTML = titleHtml;
  $('mail-top-title').innerHTML = titleHtml;
  const unseen = inboxUnseen();
  document.title = `${unseen ? `(${unseen}) ` : ''}Mail — ${window.TuBrandName || 'TUDa Mail'}`;
}
$('mail-folder-list').addEventListener('click', (e) => {
  const li = e.target.closest('.mail-folder');
  if (!li || li.classList.contains('disabled')) return;
  closeDrawer();
  go(li.dataset.path);
});

function openDrawer() { $('mail-app').classList.add('drawer-open'); }
function closeDrawer() { $('mail-app').classList.remove('drawer-open'); }
$('folders-toggle').addEventListener('click', openDrawer);
$('folders-toggle-top').addEventListener('click', openDrawer);
$('mail-scrim').addEventListener('click', closeDrawer);

// ------------------------------------------------------------------ routing (#folder/uid)

function parseHash() {
  const raw = location.hash.slice(1);
  if (!raw) return { folder: 'INBOX', uid: null };
  const [f, u] = raw.split('/');
  let folder = 'INBOX';
  try { folder = decodeURIComponent(f || 'INBOX'); } catch (err) { folder = 'INBOX'; }
  const uid = Number(u);
  return { folder, uid: Number.isInteger(uid) && uid > 0 ? uid : null };
}
function hashFor(folder, uid) { return `#${enc(folder)}${uid ? `/${uid}` : ''}`; }
function go(folder, uid, { replace = false } = {}) {
  const target = hashFor(folder, uid);
  if (location.hash === target) { route(); return; }
  if (replace) location.replace(target);
  else location.hash = target;
}

async function route() {
  if (!state.loaded) return;
  const { folder, uid } = parseHash();
  const folderChanged = folder !== state.folder || (!state.messages.length && !state.listReq);
  state.folder = folder;
  if (!uid) state.pushedOpen = false;
  $('mail-app').dataset.view = uid ? 'read' : 'list';
  if (folderChanged) {
    state.messages = [];
    state.related = [];
    state.selecting = false;
    state.selected.clear();
    if (typeof updateBulkBar === 'function') updateBulkBar();
    renderFolders();
    await loadMessages(true);
  } else {
    highlightSelected();
  }
  if (uid) await openMessage(uid);
  else clearMessagePane();
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ message list

// Mail linked by Message-ID / In-Reply-To / References folds into one row, wherever its messages
// live (this folder, or the Inbox/Sent counterpart the server sent along as `related`). The row
// shows the newest message of the whole chain; clicking it opens the chain (newest on top).
function roleOfFolder(path) {
  const f = state.folders.find((x) => x.path === path);
  return f ? f.role : '';
}
function buildGroups() {
  const all = state.messages.concat(state.related || [], state.pending || []);
  all.forEach((m) => { m._k = `${m.folder || state.folder}/${m.uid}`; });
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const owner = new Map();
  all.forEach((m) => parent.set(m._k, m._k));
  all.forEach((m) => (m.threadIds || []).forEach((id) => {
    if (owner.has(id)) parent.set(find(m._k), find(owner.get(id)));
    else owner.set(id, m._k);
  }));
  const byRoot = new Map();
  all.forEach((m) => {
    const root = find(m._k);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(m);
  });
  state.groupOf = new Map();
  state.heads = [];
  const pending = new Set();
  byRoot.forEach((members) => {
    const own = members.filter((x) => (x.folder || state.folder) === state.folder);
    if (!own.length) return; // a chain with nothing in this folder doesn't belong in its list
    const newest = (a, b) => new Date(b.date || 0) - new Date(a.date || 0) || b.uid - a.uid;
    members.sort(newest);
    own.sort(newest);
    const group = { head: members[0], open: own[0], members: own, unread: own.some((x) => !x.seen), flagged: own.some((x) => x.flagged) };
    own.forEach((x) => state.groupOf.set(x.uid, group));
    pending.add(group);
  });
  // Newest chain first, judged by its final message — wherever that message is, whoever sent it.
  const ordered = [...pending].sort((a, b) => new Date(b.head.date || 0) - new Date(a.head.date || 0) || b.head.uid - a.head.uid);
  state.heads = ordered.map((g) => g.open);
}
// The messages a row stands for (items are {folder, uid}); used by delete / archive / move.
// Only messages in the folder being viewed are included, never anything from another folder.
window.expandToConversation = function expandToConversation(items) {
  const out = new Map();
  items.forEach((it) => {
    out.set(`${it.folder}/${it.uid}`, it);
    const group = it.folder === state.folder ? state.groupOf && state.groupOf.get(it.uid) : null;
    if (group) group.members.forEach((x) => out.set(`${state.folder}/${x.uid}`, { folder: state.folder, uid: x.uid }));
  });
  return [...out.values()];
};

function itemHtml(open) {
  const group = (state.groupOf && state.groupOf.get(open.uid)) || { head: open, open, members: [open], unread: !open.seen };
  const m = group.head; // what the row displays: the final message of the chain
  const headRole = roleOfFolder(m.folder || state.folder);
  const outgoing = m._pending || headRole === 'sent' || headRole === 'drafts';
  const person = outgoing ? (m.to && m.to[0]) : m.from;
  const label = outgoing ? `To: ${personLabel(person)}` : personLabel(person);
  const selectedRow = group.members.some((x) => x.uid === state.uid);
  const picked = state.selected.has(open.uid);
  return `
    <li class="mail-item${m._pending ? ' sending' : ''}${group.unread ? ' unread' : ''}${selectedRow ? ' selected' : ''}${picked ? ' picked' : ''}" data-uid="${open.uid}" tabindex="0" role="button">
      <div class="mail-av-wrap">${avatar(person)}<span class="sel-box" data-sel="${open.uid}" role="checkbox" aria-checked="${picked}" aria-label="Select message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span></div>
      <div class="mail-item-body">
        <div class="mail-item-row"><span class="from">${esc(label)}</span><span class="date">${m._pending ? 'Sending…' : esc(fmtListDate(m.date))}</span></div>
        <div class="mail-item-row">
          <span class="subject">${open.draft ? '<span class="draft-tag">Draft</span>' : ''}${esc(m.subject || '(no subject)')}</span>
          <span class="badges">
            ${open.answered ? svg('reply', 'class="answered-icon"') : ''}
            ${open.hasAttachment ? svg('clip') : ''}
            <button type="button" class="mail-flag-btn${open.flagged ? ' on' : ''}" data-flag="${open.uid}" aria-label="${open.flagged ? 'Remove flag' : 'Flag'}">${svg('flag')}</button>
          </span>
        </div>
        <div class="preview">${esc(m.preview || '')}</div>
      </div>
    </li>`;
}
function skeletonHtml(n) {
  return Array.from({ length: n }, () => '<li class="mail-skeleton"><div class="sk round"></div><div><div class="sk l1"></div><div class="sk l2"></div><div class="sk l3"></div></div></li>').join('');
}
// Filters from the search panel (mail-search.js): from, to, subject, since, before, flagged, attach.
function hasFilters() { return Object.values(state.filters).some(Boolean); }
function isFiltered() { return !!state.q || state.unreadOnly || hasFilters(); }
function addFilterParams(params) {
  for (const [key, value] of Object.entries(state.filters)) {
    if (value === true) params.set(key, '1'); else if (value) params.set(key, value);
  }
}
function emptyHtml() {
  if (state.q || hasFilters()) return `<li class="mail-empty">${svg('mailEmpty')}<div class="big">No results</div>${state.q ? `Nothing in this folder matches “${esc(state.q)}”.` : 'Nothing in this folder matches these filters.'}</li>`;
  if (state.unreadOnly) return `<li class="mail-empty">${svg('mailEmpty')}<div class="big">All caught up</div>No unread messages here.</li>`;
  return `<li class="mail-empty">${svg('mailEmpty')}<div class="big">Nothing here</div>This folder is empty.</li>`;
}

function renderList() {
  const list = $('mail-list');
  buildGroups();
  list.innerHTML = state.messages.length ? state.heads.map(itemHtml).join('') : emptyHtml();
  const more = $('mail-more');
  const hasMore = state.messages.length && state.page * state.pageSize < state.total;
  more.hidden = !hasMore;
  if (hasMore) more.innerHTML = '<button type="button" class="btn btn-secondary" id="mail-load-more">Load more</button>';
  if (typeof updateBulkBar === 'function') updateBulkBar();
}

async function loadMessages(reset) {
  const folder = state.folder;
  // Coming back to a folder shows what we had straight away, then refreshes it underneath.
  const snap = reset && !isFiltered() ? MailCache.getList(folder) : null;
  if (reset) {
    state.page = 0;
    state.total = 0;
    state.messages = snap ? snap.messages.slice() : [];
    state.related = snap ? snap.related.slice() : [];
    if (snap) renderList();
    else $('mail-list').innerHTML = skeletonHtml(8);
    $('mail-more').hidden = true;
    $('mail-list-scroll').scrollTop = 0;
  }
  // listReq is a generation counter: it only moves on a reset (new folder / search / filter),
  // so loading further pages never discards the previews still arriving for earlier ones.
  if (reset) state.listReq += 1;
  const reqId = state.listReq;
  state.loadingMore = true;
  const page = state.page + 1;
  try {
    const params = new URLSearchParams({ folder, page, pageSize: state.pageSize });
    if (state.q) { params.set('q', state.q); if (state.scopeAll) params.set('scope', 'all'); }
    if (state.unreadOnly) params.set('unread', '1');
    addFilterParams(params);
    const data = await mailFetch(`/api/mail/messages?${params}`);
    if (reqId !== state.listReq) return;
    state.page = page;
    state.total = data.total;
    if (page === 1 && snap) {
      // keep the one-line previews already fetched; everything else is replaced by the fresh list
      const old = new Map(state.messages.map((m) => [m.uid, m.preview]));
      const oldRelated = new Map(state.related.map((m) => [`${m.folder}/${m.uid}`, m.preview]));
      state.messages = [];
      data.messages.forEach((m) => { if (old.get(m.uid) !== undefined) m.preview = old.get(m.uid); });
      (data.related || []).forEach((m) => { const p = oldRelated.get(`${m.folder}/${m.uid}`); if (p !== undefined) m.preview = p; });
    }
    if (data.related) state.related = data.related;
    const known = new Set(state.messages.map((m) => m.uid));
    const fresh = data.messages.filter((m) => !known.has(m.uid));
    state.messages = state.messages.concat(fresh).sort((a, b) => b.uid - a.uid);
    renderList();
    if (page === 1 && !isFiltered()) { MailCache.putList(folder, { messages: state.messages.slice(), related: state.related.slice(), total: state.total }); prefetchChains(folder, reqId); }
    loadPreviews(fresh.filter((m) => m.preview === undefined).map((m) => m.uid), folder, reqId);
    loadRelatedPreviews(reqId);
  } catch (err) {
    if (reqId !== state.listReq) return;
    if (err instanceof MailAuthRequired) return showConnect();
    $('mail-list').innerHTML = `<li class="mail-empty"><div class="big">Couldn't load messages</div>${esc(err.message)}<br><br><button type="button" class="btn btn-secondary" id="mail-list-retry">Try again</button></li>`;
  } finally {
    if (reqId === state.listReq) state.loadingMore = false;
  }
}

// When the newest message of a chain lives in the other folder (e.g. your reply, seen from the
// Inbox), its grey one-liner comes from there.
async function loadRelatedPreviews(reqId) {
  const need = (state.heads || []).map((o) => state.groupOf.get(o.uid)).filter((g) => g && g.head.folder && g.head.folder !== state.folder && g.head.preview === undefined).map((g) => g.head);
  const byFolder = new Map();
  need.forEach((m) => { if (!byFolder.has(m.folder)) byFolder.set(m.folder, []); byFolder.get(m.folder).push(m); });
  for (const [folder, list] of byFolder) {
    try {
      const map = await mailFetch('/api/mail/previews', { method: 'POST', body: JSON.stringify({ folder, uids: list.map((m) => m.uid) }) });
      if (reqId !== state.listReq) return;
      list.forEach((m) => { m.preview = map[m.uid] || ''; });
    } catch (err) {
      // previews are a nicety
    }
  }
  if (reqId === state.listReq) renderList();
}

// Quietly keeps a local copy of the newest conversations of Inbox and Sent, one at a time and
// only while the person isn't doing anything, so opening them later needs no waiting.
let prefetchRun = 0;
let lastActivity = Date.now();
['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
async function prefetchChains(folder, listReq) {
  const role = roleOfFolder(folder);
  if (role !== 'inbox' && role !== 'sent') return;
  const run = ++prefetchRun;
  const heads = (state.heads || []).slice(0, 80).map((o) => ({ folder, uid: o.uid }));
  let done = 0;
  const paint = () => {}; // Background caching never displays sync status.
  let fetched = 0;
  for (const item of heads) {
    if (run !== prefetchRun || listReq !== state.listReq) {  return; } // moved on to something else
    if (await MailCache.has(item.folder, item.uid)) { done += 1; continue; }
    while (Date.now() - lastActivity < 2500 || document.hidden) {
      await new Promise((r) => setTimeout(r, 1000));
      if (run !== prefetchRun) return;
    }
    paint(false);
    try {
      const data = await mailFetch(`/api/mail/thread?folder=${enc(item.folder)}&uid=${item.uid}&peek=1`);
      MailCache.putThread(data.messages);
    } catch (err) {
      if (err instanceof MailAuthRequired) return;
    }
    done += 1;
    fetched += 1;
    paint(false);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (run === prefetchRun && fetched) {
    paint(true);

  }
}

async function loadPreviews(uids, folder, reqId) {
  if (!uids.length) return;
  try {
    const map = await mailFetch('/api/mail/previews', { method: 'POST', body: JSON.stringify({ folder, uids }) });
    if (reqId !== state.listReq) return;
    Object.entries(map).forEach(([uid, text]) => {
      const m = state.messages.find((x) => x.uid === Number(uid));
      if (m) m.preview = text;
      const li = $('mail-list').querySelector(`.mail-item[data-uid="${uid}"] .preview`);
      if (li) li.textContent = text;
    });
  } catch (err) {
    // previews are a nicety — never worth surfacing an error for
  }
}

function highlightSelected() {
  $('mail-list').querySelectorAll('.mail-item.selected').forEach((el) => el.classList.remove('selected'));
  if (state.uid) {
    const g = state.groupOf && state.groupOf.get(state.uid);
    const el = $('mail-list').querySelector(`.mail-item[data-uid="${g ? g.head.uid : state.uid}"]`);
    if (el) {
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}

$('mail-list').addEventListener('click', (e) => {
  const flagBtn = e.target.closest('[data-flag]');
  if (flagBtn) {
    e.stopPropagation();
    setFlag([Number(flagBtn.dataset.flag)], 'star');
    return;
  }
  if (e.target.closest('#mail-list-retry')) { loadMessages(true); return; }
  const box = e.target.closest('[data-sel]');
  if (box) { e.stopPropagation(); toggleSelect(Number(box.dataset.sel)); return; }
  const li = e.target.closest('.mail-item');
  if (!li) return;
  if (state.selecting) { toggleSelect(Number(li.dataset.uid)); return; }
  // In Drafts a message is something to keep writing, not to read.
  if ((currentFolder() || {}).role === 'drafts') {
    startCompose({ mode: 'draft', folder: state.folder, uid: Number(li.dataset.uid) });
    return;
  }
  // First open pushes a history entry (so Back returns to the list); switching between
  // messages on a wide screen replaces it instead of piling up entries.
  if (state.uid === null) state.pushedOpen = true;
  go(state.folder, Number(li.dataset.uid), { replace: state.uid !== null });
});
$('mail-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('mail-item')) e.target.click();
});
$('mail-more').addEventListener('click', (e) => {
  if (e.target.id === 'mail-load-more') loadMore();
});
function loadMore() {
  if (state.loadingMore || state.page * state.pageSize >= state.total) return;
  loadMessages(false);
}
// Endless scroll: the button above is the fallback, this just presses it a little early.
$('mail-list-scroll').addEventListener('scroll', (e) => {
  const el = e.target;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
});

// ------------------------------------------------------------------ search / filters

let searchTimer = null;
function applySearch() {
  state.q = $('mail-search').value.trim();
  $('mail-search-clear').hidden = !$('mail-search').value;
  $('scope-wrap').classList.toggle('show', !!state.q);
  loadMessages(true);
}
$('mail-search').addEventListener('input', () => {
  $('mail-search-clear').hidden = !$('mail-search').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearch, 450);
});
$('mail-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); applySearch(); }
  if (e.key === 'Escape') { $('mail-search').value = ''; clearTimeout(searchTimer); applySearch(); $('mail-search').blur(); }
});
$('mail-search-clear').addEventListener('click', () => { $('mail-search').value = ''; applySearch(); $('mail-search').focus(); });
$('scope-all').addEventListener('change', () => { state.scopeAll = $('scope-all').checked; loadMessages(true); });
function setUnreadFilter(on) {
  state.unreadOnly = on;
  $('chip-all').classList.toggle('active', !on);
  $('chip-unread').classList.toggle('active', on);
  loadMessages(true);
}
$('chip-all').addEventListener('click', () => setUnreadFilter(false));
$('chip-unread').addEventListener('click', () => setUnreadFilter(true));
$('mail-refresh').addEventListener('click', () => softRefresh(true));
$('mail-refresh-top').addEventListener('click', () => softRefresh(true));

// ------------------------------------------------------------------ flags

// 'star' is a toggle: it flags an unflagged message and unflags a flagged one.
async function setFlag(uids, action) {
  const folder = state.folder;
  const cur = state.current && uids.includes(state.current.uid) ? state.current : null;
  // The open message is a separate object from its list row, and may not even be in the
  // loaded list (deep link to an older message) — so each uid can have up to two copies.
  const copies = (uid) => [state.messages.find((m) => m.uid === uid), cur && cur.uid === uid ? cur : null].filter(Boolean);
  const snapshot = uids.flatMap((uid) => copies(uid).map((m) => ({ m, seen: m.seen, flagged: m.flagged })));
  const basis = (cur || copies(uids[0])[0]);
  const decided = action === 'star' ? (basis && basis.flagged ? 'unstar' : 'star') : action;

  const folderInfo = currentFolder();
  uids.forEach((uid) => {
    const all = copies(uid);
    if (!all.length) return;
    const wasSeen = all[0].seen;
    all.forEach((m) => {
      if (decided === 'read') m.seen = true;
      if (decided === 'unread') m.seen = false;
      if (decided === 'star') m.flagged = true;
      if (decided === 'unstar') m.flagged = false;
    });
    if (folderInfo && wasSeen !== all[0].seen) folderInfo.unseen = Math.max(0, folderInfo.unseen + (all[0].seen ? -1 : 1));
  });
  renderList();
  renderFolders();
  if (cur) updateToolbar();
  try {
    await mailFetch('/api/mail/messages/flags', { method: 'PUT', body: JSON.stringify({ folder, uids, action: decided }) });
  } catch (err) {
    snapshot.forEach(({ m, seen, flagged }) => { m.seen = seen; m.flagged = flagged; });
    renderList();
    if (cur) updateToolbar();
    loadFolders().catch(() => {});
    handleError(err);
  }
}

// ------------------------------------------------------------------ reading a message

function emailDocument(html, showImages) {
  const body = showImages ? html.replace(/(<img\b[^>]*?)data-blocked-src=/gi, '$1src=') : html;
  const csp = `default-src 'none'; img-src data: ${showImages ? 'https: http:' : ''}; style-src 'unsafe-inline'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>
    html{-webkit-text-size-adjust:100%;overflow:hidden}
    body{margin:0;padding:0;font:14.5px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b2430;overflow-wrap:anywhere;word-break:break-word}
    img{max-width:100%;height:auto}
    table{max-width:100%}
    pre{white-space:pre-wrap}
    a{color:#1e4593}
    blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:3px solid #d5dbe7;color:#555}
    p{margin:0 0 10px}
    .eg-fold{margin:8px 0}
    .eg-fold button{border:0;background:#eceff5;color:#5b6475;border-radius:4px;height:17px;padding:0 9px;font:700 13px/1 system-ui,sans-serif;letter-spacing:2px;cursor:pointer}
    .eg-fold button:hover{background:#dde3ee}
    .eg-fold.open button{background:#d3d9e6}
  </style></head><body>${body}</body></html>`;
}

function sizeFrame(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    const avail = frame.clientWidth;
    doc.body.style.zoom = '';
    const wide = Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth);
    if (avail > 0 && wide > avail + 2) doc.body.style.zoom = String(avail / wide);
    // Measure with the frame collapsed: emails that size things in % of the viewport (e.g.
    // height:90%) would otherwise just report the frame's current height back to us.
    const before = frame.style.height;
    frame.style.height = '0px';
    const h = Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight));
    frame.style.height = Math.abs(h - parseInt(before || '0', 10)) > 1 ? `${h}px` : before;
  } catch (err) {
    // frame not ready yet
  }
}

function personHtml(p) {
  if (!p) return '';
  return p.name && p.address ? `${esc(p.name)} <span class="addr">&lt;${esc(p.address)}&gt;</span>` : esc(p.name || p.address);
}
function listHtml(people) {
  return people.map((p) => esc(p.name ? `${p.name} <${p.address}>` : p.address)).join('; ');
}

// ------------------------------------------------------------------ writing mail (see js/mail-compose.js)

const composeOpen = () => typeof window.composeIsOpen === 'function' && window.composeIsOpen();
function startCompose(options) {
  if (typeof window.openCompose !== 'function') { toast('The mail editor is still loading — try again in a moment', 'error'); return; }
  window.openCompose(options);
}
$('compose-btn-folders').addEventListener('click', () => { closeDrawer(); startCompose({ mode: 'new' }); });
$('compose-btn-list').addEventListener('click', () => startCompose({ mode: 'new' }));
$('mail-fab').addEventListener('click', () => startCompose({ mode: 'new' }));
const replyTo = (mode) => { if (state.current) startCompose({ mode, folder: state.current.folder, uid: state.current.uid }); };

// A sent message shows up in the list as "answered" without waiting for the next refresh.
window.markMessageAnswered = (folder, uid) => {
  if (folder !== state.folder) return;
  const row = state.messages.find((m) => m.uid === uid);
  if (row) { row.answered = true; renderList(); }
};

$('msg-back').addEventListener('click', backToList);
// Swipe right on the message heading (or anywhere on the message while a phone shows it full screen) to go back.
(function () {
  const pane = $('mail-read-pane');
  let start = null;
  pane.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 && window.matchMedia('(max-width: 899px)').matches ? { x: t.clientX, y: t.clientY, heading: !!e.target.closest('.msg-toolbar') } : null;
  }, { passive: true });
  pane.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0], dx = t.clientX - start.x, dy = Math.abs(t.clientY - start.y);
    const fromEdge = start.x < 40;
    const long = dx > 70 && dy < 45 && dx > dy * 2;
    if (long && (start.heading || fromEdge) && state.uid !== null && !document.querySelector('dialog[open], .cmp-dialog-overlay')) backToList();
    start = null;
  }, { passive: true });
  pane.addEventListener('touchcancel', () => { start = null; }, { passive: true });
})();
function backToList() {
  if (state.pushedOpen) {
    state.pushedOpen = false;
    history.back();
  } else {
    go(state.folder);
  }
}
// ------------------------------------------------------------------ keyboard (desktop)

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
  if ($('mail-app').hidden || composeOpen()) return;
  const idx = state.messages.findIndex((m) => m.uid === state.uid);
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    const next = state.messages[idx + 1] || (idx === -1 ? state.messages[0] : null);
    if (next) go(state.folder, next.uid, { replace: state.uid !== null });
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    const prev = idx > 0 ? state.messages[idx - 1] : null;
    if (prev) go(state.folder, prev.uid, { replace: true });
  } else if (e.key === 'c') {
    e.preventDefault();
    startCompose({ mode: 'new' });
  } else if (e.key === 'r' && state.current) {
    e.preventDefault();
    replyTo('reply');
  } else if (e.key === 'a' && state.current) {
    e.preventDefault();
    replyTo('replyall');
  } else if (e.key === 'u' && state.current) {
    setFlag([state.current.uid], 'unread');
  } else if (e.key === 'f' && state.current) {
    setFlag([state.current.uid], 'star');
  } else if (e.key === '/') {
    e.preventDefault();
    $('mail-search').focus();
  } else if (e.key === 'Escape') {
    if ($('mail-app').classList.contains('drawer-open')) closeDrawer();
    else if (state.uid) backToList();
  }
});

// ------------------------------------------------------------------ keeping it fresh

let syncStatusTimer;
function showManualSyncStatus(label, finished = false) {
  clearTimeout(syncStatusTimer);
  const box = $('mail-sync');
  box.dataset.manual = 'true';
  box.hidden = false;
  box.classList.toggle('done', finished);
  $('mail-sync-label').textContent = label;
  $('mail-sync-pct').textContent = '';
  $('mail-sync-fill').style.width = finished ? '100%' : '35%';
  if (finished) syncStatusTimer = setTimeout(() => {
    box.hidden = true;
    delete box.dataset.manual;
  }, 2000);
}
let refreshing = false;
async function softRefresh(manual) {
  if ($('mail-app').hidden) return;
  if (refreshing) { if (manual) showManualSyncStatus('Sync already in progress', true); return; }
  if (document.hidden && !manual) return;
  refreshing = true;
  if (manual) { showManualSyncStatus('Syncing mailbox…'); $('mail-refresh').classList.add('spin'); $('mail-refresh-top').classList.add('spin'); }
  try {
    await loadFolders();
    resetMailBadge(); // they're looking at Mail, so anything arriving now isn't "new" to them
    const params = new URLSearchParams({ folder: state.folder, page: 1, pageSize: state.pageSize });
    if (state.q) { params.set('q', state.q); if (state.scopeAll) params.set('scope', 'all'); }
    if (state.unreadOnly) params.set('unread', '1');
    addFilterParams(params);
    const data = await mailFetch(`/api/mail/messages?${params}`);
    let changed = false;
    const fresh = [];
    // Mail in the Inbox/Sent counterpart can change which message ends a chain (a reply you just sent).
    if (data.related && !isFiltered()) {
      const sig = (list) => list.map((m) => `${m.folder}/${m.uid}`).join(',');
      if (sig(data.related) !== sig(state.related || [])) {
        const oldPreview = new Map((state.related || []).map((m) => [`${m.folder}/${m.uid}`, m.preview]));
        data.related.forEach((m) => { const p = oldPreview.get(`${m.folder}/${m.uid}`); if (p !== undefined) m.preview = p; });
        state.related = data.related;
        changed = true;
      }
    }
    data.messages.forEach((incoming) => {
      const existing = state.messages.find((m) => m.uid === incoming.uid);
      if (!existing) { state.messages.push(incoming); fresh.push(incoming.uid); changed = true; }
      else if (existing.seen !== incoming.seen || existing.flagged !== incoming.flagged || existing.answered !== incoming.answered) {
        existing.seen = incoming.seen; existing.flagged = incoming.flagged; existing.answered = incoming.answered; changed = true;
      }
    });
    // Anything in the window just fetched that is no longer there was deleted or moved
    // elsewhere (by this app or another mail program) — drop it.
    if (data.messages.length) {
      const incomingUids = new Set(data.messages.map((m) => m.uid));
      const floor = data.messages.length < state.pageSize ? 0 : Math.min(...incomingUids);
      const before = state.messages.length;
      state.messages = state.messages.filter((m) => incomingUids.has(m.uid) || m.uid < floor);
      if (state.messages.length !== before) changed = true;
    } else if (state.messages.length && !isFiltered()) {
      state.messages = [];
      changed = true;
    }
    if (changed) {
      state.messages.sort((a, b) => b.uid - a.uid);
      state.total = Math.max(state.total, data.total);
      renderList();
      loadPreviews(fresh, state.folder, state.listReq);
      loadRelatedPreviews(state.listReq);
      if (!isFiltered()) MailCache.putList(state.folder, { messages: state.messages.slice(), related: state.related.slice(), total: state.total });
    }
    if (manual) showManualSyncStatus('Mailbox up to date', true);
  } catch (err) {
    if (manual) showManualSyncStatus('Sync could not finish', true);
    if (err instanceof MailAuthRequired) showConnect();
    else if (manual) handleError(err);
  } finally {
    refreshing = false;
    $('mail-refresh').classList.remove('spin');
    $('mail-refresh-top').classList.remove('spin');
  }
}
setInterval(() => softRefresh(false), 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(false); });

// ------------------------------------------------------------------ boot

async function start() {
  showOnly('loading');
  $('mail-address').textContent = user.email;
  try {
    await loadFolders();
  } catch (err) {
    return showFatal(err);
  }
  showOnly('app');
  // The local copy is a speed-up, never a requirement: if storage is slow or stuck, carry on without it.
  try {
    await Promise.race([MailCache.init(user.userId), new Promise((resolve) => setTimeout(resolve, 2500))]);
  } catch (err) {
    // memory-only
  }
  state.loaded = true;
  resetMailBadge();
  const { folder } = parseHash();
  state.folder = state.folders.some((f) => f.path === folder) ? folder : 'INBOX';
  state.messages = [];
  state.listReq = 0;
  await route();
}
if (user) start();
