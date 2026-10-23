// A local copy of mail already seen, so opening it again (or on the next visit) needs no round trip
// to the mail server. Two layers: memory (instant) and IndexedDB (survives reloads). One database per
// mailbox, wiped on log out. Everything degrades to memory-only where IndexedDB isn't available.
//
//   lists    folder name        -> { messages, related, total, savedAt }   the first page of a folder
//   threads  record id          -> { id, messages, savedAt }               one conversation
//   members  "folder/uid"       -> record id                               lets any message find its chain
(function () {
  const DB_PREFIX = 'tumail:';
  const MAX_THREADS = 600;

  const mem = { lists: new Map(), threads: new Map(), members: new Map() };
  let db = null;
  let email = '';

  const keyOf = (m) => `${m.folder}/${m.uid}`;

  function openDb(name) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('lists');
          d.createObjectStore('threads');
          d.createObjectStore('members');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
        // Some browser windows (installed apps, locked-down profiles) never answer. Mail must not wait:
        // after this the cache simply runs from memory.
        setTimeout(() => resolve(null), 2000);
      } catch (err) {
        resolve(null);
      }
    });
  }

  function tx(store, mode, fn) {
    return new Promise((resolve) => {
      if (!db) return resolve(undefined);
      try {
        const t = db.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
        t.onerror = () => resolve(undefined);
        t.onabort = () => resolve(undefined);
        setTimeout(() => resolve(undefined), 3000); // never leave the page waiting on storage
      } catch (err) {
        resolve(undefined);
      }
    });
  }

  async function init(address) {
    email = String(address || '').toLowerCase();
    mem.lists.clear(); mem.threads.clear(); mem.members.clear();
    db = null; // Session-only cache: no mailbox contents persisted on this computer.
    if (!db) return;
    // Folder lists are small and wanted immediately, so they are loaded up front.
    await new Promise((resolve) => {
      try {
        const t = db.transaction('lists', 'readonly');
        const req = t.objectStore('lists').openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { mem.lists.set(cur.key, cur.value); cur.continue(); }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
        t.onabort = () => resolve();
      } catch (err) {
        resolve();
      }
    });
  }

  function getList(folder) {
    return mem.lists.get(folder) || null;
  }

  function putList(folder, snap) {
    const record = { ...snap, savedAt: Date.now() };
    mem.lists.set(folder, record);
    tx('lists', 'readwrite', (s) => s.put(record, folder));
  }

  async function getThread(folder, uid) {
    const key = `${folder}/${uid}`;
    let id = mem.members.get(key);
    if (!id) {
      id = await tx('members', 'readonly', (s) => s.get(key));
      if (!id) return null;
    }
    let record = mem.threads.get(id);
    if (!record) {
      record = await tx('threads', 'readonly', (s) => s.get(id));
      if (!record) return null;
      mem.threads.set(id, record);
      record.messages.forEach((m) => mem.members.set(keyOf(m), id));
    }
    return record;
  }

  // Stores a conversation, replacing whatever was kept for any of its messages before.
  async function putThread(messages) {
    if (!messages || !messages.length) return;
    const newest = messages.slice().sort((a, b) => new Date(b.received || b.date || 0) - new Date(a.received || a.date || 0))[0];
    const id = keyOf(newest);
    const stale = new Set();
    messages.forEach((m) => { const old = mem.members.get(keyOf(m)); if (old && old !== id) stale.add(old); });
    stale.forEach((old) => dropRecord(old));
    const record = { id, messages, savedAt: Date.now() };
    mem.threads.set(id, record);
    messages.forEach((m) => mem.members.set(keyOf(m), id));
    if (!db) return;
    try {
      const t = db.transaction(['threads', 'members'], 'readwrite');
      t.objectStore('threads').put(record, id);
      const members = t.objectStore('members');
      messages.forEach((m) => members.put(id, keyOf(m)));
    } catch (err) {
      // storage full or unavailable — memory still has it
    }
    if (mem.threads.size > MAX_THREADS) trim();
  }

  function dropRecord(id) {
    const record = mem.threads.get(id);
    mem.threads.delete(id);
    if (record) record.messages.forEach((m) => { if (mem.members.get(keyOf(m)) === id) mem.members.delete(keyOf(m)); });
    if (!db) return;
    try {
      const t = db.transaction(['threads', 'members'], 'readwrite');
      t.objectStore('threads').delete(id);
      if (record) record.messages.forEach((m) => t.objectStore('members').delete(keyOf(m)));
    } catch (err) {
      // ignore
    }
  }

  function trim() {
    const oldest = [...mem.threads.values()].sort((a, b) => a.savedAt - b.savedAt).slice(0, mem.threads.size - MAX_THREADS + 50);
    oldest.forEach((r) => dropRecord(r.id));
  }

  // Forget every conversation that contains any of these messages ({ folder, uid } each) — called
  // after move / delete / send, when what we kept is no longer the whole truth.
  async function invalidate(items) {
    const ids = new Set();
    for (const it of items || []) {
      const key = `${it.folder}/${it.uid}`;
      let id = mem.members.get(key);
      if (!id) id = await tx('members', 'readonly', (s) => s.get(key));
      if (id) ids.add(id);
    }
    ids.forEach(dropRecord);
  }

  function dropFolderList(folder) {
    mem.lists.delete(folder);
    tx('lists', 'readwrite', (s) => s.delete(folder));
  }

  async function has(folder, uid) {
    return Boolean(mem.members.get(`${folder}/${uid}`) || (await tx('members', 'readonly', (s) => s.getKey(`${folder}/${uid}`))));
  }

  // Everything this device holds for the current mailbox goes (used on log out).
  function wipeAll() {
    mem.lists.clear(); mem.threads.clear(); mem.members.clear();
    try { if (db) db.close(); } catch (err) { /* ignore */ }
    db = null;
    return window.egWipeMailCache ? window.egWipeMailCache() : Promise.resolve();
  }

  window.MailCache = { init, getList, putList, dropFolderList, getThread, putThread, invalidate, has, wipeAll };
})();
