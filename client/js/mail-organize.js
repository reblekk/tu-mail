// Organizing mail: delete, archive, move, spam, read/flag from cards and the toolbar, multi-select
// with a bulk bar, and folder management (create / rename / delete / empty).
// Loaded by mail.html after mail-thread.js; relies on the page's state, mailFetch, esc, toast,
// renderList, renderFolders, loadFolders, loadMessages, go, backToList, clearMessagePane, setFlag.
(function () {
  const isPhone = () => window.matchMedia('(max-width: 899px)').matches;

  // ------------------------------------------------------------------ pop-up menu

  let openMenu = null, stopWatching = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    if (stopWatching) { stopWatching(); stopWatching = null; }
    window.removeEventListener('scroll', closeMenu, true);
  }

  window.openPopupMenu = function openPopupMenu(anchor, items) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'mail-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items
      .map((item, i) => (item.divider ? '<div class="mail-menu-sep"></div>' : `<button type="button" role="menuitem" class="mail-menu-item${item.danger ? ' danger' : ''}" data-i="${i}">${esc(item.label)}</button>`))
      .join('');
    document.body.appendChild(menu);
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - m.width - 8, a.right - m.width));
    const below = a.bottom + 6 + m.height <= window.innerHeight - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${below ? a.bottom + 6 : Math.max(8, a.top - m.height - 6)}px`;
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.mail-menu-item');
      if (!btn) return;
      const item = items[Number(btn.dataset.i)];
      closeMenu();
      item.run();
    });
    openMenu = menu;
    stopWatching = window.TuOutside.watch(menu, closeMenu);
    setTimeout(() => window.addEventListener('scroll', closeMenu, true), 0);
  };

  // ------------------------------------------------------------------ dialogs

  function dialog({ title, message, input, confirmText = 'OK', cancelText = 'Cancel', danger = false, body = null }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'cmp-dialog-overlay';
      wrap.innerHTML = `
        <div class="cmp-dialog" role="alertdialog" aria-modal="true">
          <h4>${esc(title)}</h4>
          ${message ? `<p>${esc(message)}</p>` : ''}
          ${input ? `<input type="text" class="cmp-dialog-input" maxlength="80" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" />` : ''}
          ${body || ''}
          <div class="cmp-dialog-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-act="cancel">${esc(cancelText)}</button>
            ${confirmText ? `<button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="ok">${esc(confirmText)}</button>` : ''}
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const field = wrap.querySelector('.cmp-dialog-input');
      const finish = (value) => {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
        if (e.key === 'Enter' && field) { e.stopPropagation(); e.preventDefault(); finish(field.value.trim() || null); }
      };
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) finish(act.dataset.act === 'ok' ? (field ? field.value.trim() || null : true) : null);
        else if (e.target === wrap) finish(null);
        const pick = e.target.closest('[data-pick]');
        if (pick) finish({ pick: pick.dataset.pick });
      });
      setTimeout(() => (field || wrap.querySelector('[data-act="ok"]') || wrap.querySelector('[data-pick]') || wrap).focus(), 30);
    });
  }
  window.askText = (options) => dialog({ ...options, input: { placeholder: options.placeholder, value: options.value } });
  window.askConfirm = (options) => dialog(options);

  async function createFolder(name, parent) {
    const result = await mailFetch('/api/mail/folders', { method: 'POST', body: JSON.stringify({ name, parent: parent || undefined }) });
    await loadFolders();
    return result.path;
  }

  // Choose a destination folder (or make one on the spot). Resolves to a folder path or null.
  window.pickFolder = async function pickFolder({ exclude = [], title = 'Move to' } = {}) {
    const rows = state.folders.filter((f) => f.selectable && !exclude.includes(f.path));
    const body = `<div class="pick-list">${rows
      .map((f) => `<button type="button" class="pick-row" data-pick="${esc(f.path)}" style="padding-left:${12 + f.depth * 16}px">${svg(f.role)}<span>${esc(f.name)}</span></button>`)
      .join('')}<button type="button" class="pick-row pick-new" data-pick="__new__">${svg('other')}<span>New folder…</span></button></div>`;
    const choice = await dialog({ title, body, confirmText: null });
    if (!choice || !choice.pick) return null;
    if (choice.pick !== '__new__') return choice.pick;
    const name = await askText({ title: 'New folder', placeholder: 'Folder name', confirmText: 'Create' });
    if (!name) return null;
    try {
      return await createFolder(name);
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  };

  // ------------------------------------------------------------------ the "Undo" bar

  let snackTimer = null;
  function snack(text, undo) {
    let bar = document.getElementById('mail-snack');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mail-snack';
      bar.className = 'mail-snack';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button" id="mail-snack-undo">Undo</button>' : ''}`;
    bar.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => bar.classList.remove('show'), 8000);
    if (undo) {
      document.getElementById('mail-snack-undo').addEventListener('click', async () => {
        bar.classList.remove('show');
        try {
          await undo();
        } catch (err) {
          toast(err.message || "Couldn't undo", 'error');
        }
      });
    }
  }

  // ------------------------------------------------------------------ moving things

  const role = (m) => (m.folder === state.folder ? (currentFolder() || {}).role : null);

  // Remove messages from what's on screen after they've left their folder.
  function afterRemoved(folder, uids) {
    clearThreadCache(uids.map((u) => ({ folder, uid: u })));
    const wasPrimary = state.current && state.current.folder === folder && uids.includes(state.current.uid);
    let nextUid = null;
    if (folder === state.folder) {
      const index = state.messages.findIndex((m) => uids.includes(m.uid));
      state.messages = state.messages.filter((m) => !uids.includes(m.uid));
      uids.forEach((u) => state.selected.delete(u));
      state.total = Math.max(0, state.total - uids.length);
      if (wasPrimary && state.messages.length) nextUid = state.messages[Math.min(Math.max(index, 0), state.messages.length - 1)].uid;
      renderList();
      updateBulkBar();
    }
    uids.forEach((u) => removeCard(folder, u));
    if (wasPrimary || (state.current && !threadHasCards())) {
      if (isPhone()) { clearMessagePane(); backToList(); }
      else if (nextUid) go(state.folder, nextUid, { replace: true });
      else { clearMessagePane(); go(state.folder, null, { replace: true }); }
    }
  }

  async function performMove(items, { toRole, to, label, remove }) {
    const groups = new Map();
    items.forEach((i) => groups.set(i.folder, [...(groups.get(i.folder) || []), i.uid]));
    const undoPlan = [];
    let count = 0;
    let permanent = false;
    try {
      for (const [folder, uids] of groups) {
        const res = await mailFetch(remove ? '/api/mail/messages/delete' : '/api/mail/messages/move', {
          method: 'POST',
          body: JSON.stringify({ folder, uids, ...(to ? { to } : { toRole }) }),
        });
        count += res.moved !== undefined ? res.moved : res.deleted;
        if (res.permanent) permanent = true;
        if (!res.permanent && res.destination && res.uidMap && Object.keys(res.uidMap).length) {
          undoPlan.push({ from: res.destination, back: folder, uids: Object.values(res.uidMap) });
        }
        if (res.moved === 0 && !remove) { toast(`Already in that folder`); continue; }
        afterRemoved(folder, uids);
      }
    } catch (err) {
      if (err instanceof MailAuthRequired) return showConnect();
      toast(err.message || "That didn't work", 'error');
      return;
    }
    loadFolders().catch(() => {});
    if (!count) return;
    const text = `${label(count)}`;
    snack(text, permanent || !undoPlan.length ? null : async () => {
      for (const plan of undoPlan) {
        await mailFetch('/api/mail/messages/move', { method: 'POST', body: JSON.stringify({ folder: plan.from, uids: plan.uids, to: plan.back }) });
      }
      toast('Restored', 'success');
      loadFolders().catch(() => {});
      if (undoPlan.some((p) => p.back === state.folder)) loadMessages(true);
    });
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // In Archive or Deleted Items the same button, key and bulk action puts the messages back in the Inbox.
  window.actArchive = (items) => ['archive', 'trash'].includes(role(items[0])) ? actRestore(items) : performMove(items, { toRole: 'archive', label: (n) => `${plural(n, 'message', 'messages')} archived` });
  window.actMove = async (items) => {
    const to = await pickFolder({ exclude: [items[0].folder], title: items.length === 1 ? 'Move message to' : `Move ${items.length} messages to` });
    if (!to) return;
    const name = (state.folders.find((f) => f.path === to) || {}).name || 'folder';
    performMove(items, { to, label: (n) => `${plural(n, 'message', 'messages')} moved to ${name}` });
  };
  // Deleted Items only: put the messages back in the Inbox.
  window.actRestore = (items) => performMove(items, { toRole: 'inbox', label: (n) => `${plural(n, 'message', 'messages')} moved to Inbox` });
  window.actSpam = (items) => {
    const fromJunk = role(items[0]) === 'junk';
    return performMove(items, { toRole: fromJunk ? 'inbox' : 'junk', label: (n) => (fromJunk ? `${plural(n, 'message', 'messages')} moved to Inbox` : `${plural(n, 'message', 'messages')} marked as spam`) });
  };
  window.actDelete = async (items) => {
    const inTrash = role(items[0]) === 'trash';
    if (inTrash) {
      const ok = await askConfirm({ title: 'Delete permanently?', message: `${plural(items.length, 'message', 'messages')} will be deleted for good. This can't be undone.`, confirmText: 'Delete', danger: true });
      if (!ok) return;
    }
    return performMove(items, { remove: true, label: (n) => (inTrash ? `${plural(n, 'message', 'messages')} deleted` : `${plural(n, 'message', 'messages')} moved to Deleted Items`) });
  };

  // Read / unread / flag for one message (a card, or the one open in the toolbar).
  window.flagMessage = async function flagMessage(m, action) {
    const before = { seen: m.seen, flagged: m.flagged };
    if (action === 'read') m.seen = true;
    if (action === 'unread') m.seen = false;
    if (action === 'star') m.flagged = true;
    if (action === 'unstar') m.flagged = false;
    const row = m.folder === state.folder ? state.messages.find((x) => x.uid === m.uid) : null;
    if (row) { row.seen = m.seen; row.flagged = m.flagged; renderList(); }
    const folderInfo = state.folders.find((f) => f.path === m.folder);
    if (folderInfo && before.seen !== m.seen) { folderInfo.unseen = Math.max(0, folderInfo.unseen + (m.seen ? -1 : 1)); renderFolders(); }
    refreshCard(m);
    if (state.current && state.current.uid === m.uid && state.current.folder === m.folder) updateToolbar();
    try {
      await mailFetch('/api/mail/messages/flags', { method: 'PUT', body: JSON.stringify({ folder: m.folder, uids: [m.uid], action }) });
    } catch (err) {
      m.seen = before.seen;
      m.flagged = before.flagged;
      if (row) { row.seen = before.seen; row.flagged = before.flagged; renderList(); }
      refreshCard(m);
      loadFolders().catch(() => {});
      handleError(err);
    }
  };

  // ------------------------------------------------------------------ toolbar buttons

  const current = () => state.current;
  $('msg-delete').addEventListener('click', () => current() && actDelete(expandToConversation([current()])));
  $('msg-archive').addEventListener('click', () => current() && actArchive(expandToConversation([current()])));
  $('msg-move').addEventListener('click', () => current() && actMove(expandToConversation([current()])));
  $('msg-spam').addEventListener('click', () => current() && actSpam(expandToConversation([current()])));
  $('msg-flag').addEventListener('click', () => current() && flagMessage(current(), current().flagged ? 'unstar' : 'star'));
  $('msg-unread').addEventListener('click', () => {
    if (!current()) return;
    const m = current();
    flagMessage(m, m.seen ? 'unread' : 'read');
    if (m.seen === false && isPhone()) backToList();
  });

  // ------------------------------------------------------------------ selecting several

  window.updateBulkBar = function updateBulkBar() {
    const bar = $('mail-bulk');
    bar.hidden = !state.selecting;
    $('chip-select').classList.toggle('active', state.selecting);
    document.getElementById('mail-app').classList.toggle('selecting', state.selecting);
    const n = state.selected.size;
    $('bulk-count').textContent = n ? `${n} selected` : 'Select messages';
    bar.querySelectorAll('[data-bulk]').forEach((b) => { b.disabled = !n; });
    $('bulk-all').checked = n > 0 && n === (state.heads || state.messages).length;
  };

  window.setSelecting = function setSelecting(on) {
    state.selecting = on;
    if (!on) state.selected.clear();
    updateBulkBar();
    renderList();
  };

  window.toggleSelect = function toggleSelect(uid) {
    if (!state.selecting) state.selecting = true;
    if (state.selected.has(uid)) state.selected.delete(uid);
    else state.selected.add(uid);
    updateBulkBar();
    renderList();
  };

  $('chip-select').addEventListener('click', () => setSelecting(!state.selecting));
  $('bulk-all').addEventListener('change', (e) => {
    state.selected = new Set(e.target.checked ? (state.heads || state.messages).map((m) => m.uid) : []);
    updateBulkBar();
    renderList();
  });
  $('bulk-done').addEventListener('click', () => setSelecting(false));
  $('mail-bulk').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn || btn.disabled) return;
    const items = expandToConversation([...state.selected].map((uid) => ({ folder: state.folder, uid })));
    const uids = items.map((it) => it.uid);
    const kind = btn.dataset.bulk;
    if (kind === 'delete') await actDelete(items);
    else if (kind === 'archive') await actArchive(items);
    else if (kind === 'spam') await actSpam(items);
    else if (kind === 'move') await actMove(items);
    else if (['read', 'unread', 'star'].includes(kind)) {
      const allFlagged = state.messages.filter((m) => state.selected.has(m.uid)).every((m) => m.flagged);
      await bulkFlag(uids, kind === 'star' ? (allFlagged ? 'unstar' : 'star') : kind);
    }
    if (!state.selected.size) setSelecting(false);
  });

  // Read / unread / flag for the whole selection at once.
  async function bulkFlag(uids, action) {
    const rows = uids.map((u) => state.messages.find((m) => m.uid === u)).filter(Boolean);
    const info = currentFolder();
    rows.forEach((row) => {
      const was = row.seen;
      if (action === 'read') row.seen = true;
      if (action === 'unread') row.seen = false;
      if (action === 'star') row.flagged = true;
      if (action === 'unstar') row.flagged = false;
      if (info && was !== row.seen) info.unseen = Math.max(0, info.unseen + (row.seen ? -1 : 1));
    });
    renderList();
    renderFolders();
    try {
      await mailFetch('/api/mail/messages/flags', { method: 'PUT', body: JSON.stringify({ folder: state.folder, uids, action }) });
    } catch (err) {
      loadMessages(true);
      loadFolders().catch(() => {});
      handleError(err);
    }
  }

  // ------------------------------------------------------------------ folders

  $('folder-add').addEventListener('click', async () => {
    const name = await askText({ title: 'New folder', placeholder: 'Folder name', confirmText: 'Create' });
    if (!name) return;
    try {
      const path = await createFolder(name);
      toast('Folder created', 'success');
      closeDrawer();
      go(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function folderMenu(path, anchor) {
    const folder = state.folders.find((f) => f.path === path);
    if (!folder) return;
    const items = [];
    if (folder.role === 'other') {
      items.push(
        { label: 'New subfolder', run: async () => {
          const name = await askText({ title: `New folder inside “${folder.name}”`, placeholder: 'Folder name', confirmText: 'Create' });
          if (!name) return;
          try { await createFolder(name, path); toast('Folder created', 'success'); } catch (err) { toast(err.message, 'error'); }
        } },
        { label: 'Rename', run: async () => {
          const name = await askText({ title: 'Rename folder', value: folder.name, confirmText: 'Rename' });
          if (!name || name === folder.name) return;
          try {
            const result = await mailFetch('/api/mail/folders', { method: 'PUT', body: JSON.stringify({ path, name }) });
            await loadFolders();
            if (state.folder === path) go(result.path, null, { replace: true });
            toast('Folder renamed', 'success');
          } catch (err) { toast(err.message, 'error'); }
        } },
        { divider: true },
        { label: 'Delete folder', danger: true, run: async () => {
          const subfolders = state.folders.filter((f) => f.path !== path && f.path.startsWith(path) && f.depth > folder.depth).length;
          const inside = state.folders.filter((f) => f.path === path || (f.path.startsWith(path) && f.depth > folder.depth)).reduce((sum, f) => sum + (f.total || 0), 0);
          const ok = await askConfirm({
            title: `Delete “${folder.name}”?`,
            message: `${subfolders ? `The folder and its ${plural(subfolders, 'subfolder', 'subfolders')}` : 'The folder'}${inside ? `, with ${plural(inside, 'message', 'messages')} inside,` : ''} will be deleted for good.`,
            confirmText: 'Delete',
            danger: true,
          });
          if (!ok) return;
          try {
            await mailFetch('/api/mail/folders', { method: 'DELETE', body: JSON.stringify({ path }) });
            await loadFolders();
            if (state.folder === path || state.folder.startsWith(`${path}.`) || state.folder.startsWith(`${path}/`)) go('INBOX', null, { replace: true });
            toast('Folder deleted', 'success');
          } catch (err) { toast(err.message, 'error'); }
        } }
      );
    } else if (folder.role === 'trash' || folder.role === 'junk') {
      items.push({ label: 'Empty folder', danger: true, run: async () => {
        const ok = await askConfirm({ title: `Empty “${folder.name}”?`, message: folder.total ? `${plural(folder.total, 'message', 'messages')} will be deleted for good.` : 'It is already empty.', confirmText: 'Empty folder', danger: true });
        if (!ok || !folder.total) return;
        try {
          await mailFetch('/api/mail/folders/empty', { method: 'POST', body: JSON.stringify({ path }) });
          await loadFolders();
          if (state.folder === path) loadMessages(true);
          toast('Folder emptied', 'success');
        } catch (err) { toast(err.message, 'error'); }
      } });
    }
    if (items.length) openPopupMenu(anchor, items);
  }

  $('mail-folder-list').addEventListener('click', (e) => {
    const more = e.target.closest('.folder-more');
    if (!more) return;
    e.stopPropagation();
    e.preventDefault();
    folderMenu(more.dataset.path, more);
  }, true);

  // ------------------------------------------------------------------ long press / right-click on a row

  // Hold a message (touch) or right-click it (mouse) for everything that can be done with it.
  (function () {
    const list = $('mail-list');
    let timer = null, origin = null, openedAt = 0, suppressClickUntil = 0;
    const cancel = () => { clearTimeout(timer); timer = null; origin = null; };

    function openRowMenu(li, x, y) {
      const uid = Number(li.dataset.uid);
      const row = state.messages.find((m) => m.uid === uid);
      if (!row) return;
      const items = [{ folder: state.folder, uid }];
      const kind = (currentFolder() || {}).role;
      const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) };
      const menu = [];
      if (kind !== 'drafts') {
        menu.push(
          { label: row.seen ? 'Mark as unread' : 'Mark as read', run: () => setFlag([uid], row.seen ? 'unread' : 'read') },
          { label: row.flagged ? 'Remove flag' : 'Flag', run: () => setFlag([uid], 'star') },
          { divider: true },
          { label: 'Reply', run: () => startCompose({ mode: 'reply', folder: state.folder, uid }) },
          { label: 'Reply all', run: () => startCompose({ mode: 'replyall', folder: state.folder, uid }) },
          { label: 'Forward', run: () => startCompose({ mode: 'forward', folder: state.folder, uid }) },
          { divider: true },
          kind === 'trash' ? { label: 'Restore to Inbox', run: () => actRestore(expandToConversation(items)) }
            : kind === 'archive' ? { label: 'Unarchive', run: () => actRestore(expandToConversation(items)) }
            : { label: 'Archive', run: () => actArchive(expandToConversation(items)) },
          { label: 'Move to…', run: () => actMove(expandToConversation(items)) },
          { label: kind === 'junk' ? 'Not spam' : 'Mark as spam', run: () => actSpam(expandToConversation(items)) },
        );
      }
      menu.push(
        { label: kind === 'trash' ? 'Delete permanently' : 'Delete', danger: true, run: () => actDelete(expandToConversation(items)) },
        { divider: true },
        { label: 'Select', run: () => { setSelecting(true); toggleSelect(uid); } },
      );
      openedAt = Date.now();
      suppressClickUntil = openedAt + 900;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* not supported */ } }
      openPopupMenu(anchor, menu);
    }

    list.addEventListener('pointerdown', (e) => {
      cancel();
      if (e.pointerType === 'mouse' || e.button > 0 || state.selecting) return;
      const li = e.target.closest('.mail-item');
      if (!li || e.target.closest('[data-sel], [data-flag]')) return;
      origin = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => { const at = origin; cancel(); if (at) openRowMenu(li, at.x, at.y); }, 480);
    });
    list.addEventListener('pointermove', (e) => { if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 10) cancel(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => list.addEventListener(ev, cancel));
    $('mail-list-scroll').addEventListener('scroll', cancel, { passive: true });
    list.addEventListener('contextmenu', (e) => {
      const li = e.target.closest('.mail-item');
      if (!li) return;
      e.preventDefault();
      if (Date.now() - openedAt < 900) return;
      cancel();
      openRowMenu(li, e.clientX, e.clientY);
    });
    // The lift of the finger after a long press must not also open the message.
    list.addEventListener('click', (e) => { if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); } }, true);
  })();

  // ------------------------------------------------------------------ keyboard

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if ($('mail-app').hidden || composeOpen() || document.querySelector('.cmp-dialog-overlay') || openMenu) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      if (state.selecting && state.selected.size) actDelete(expandToConversation([...state.selected].map((uid) => ({ folder: state.folder, uid }))));
      else if (state.current) actDelete(expandToConversation([state.current]));
    } else if (e.key === 'e' && state.current) {
      e.preventDefault();
      actArchive(expandToConversation([state.current]));
    } else if (e.key === 'Escape' && state.selecting) {
      setSelecting(false);
    }
  });
})();
