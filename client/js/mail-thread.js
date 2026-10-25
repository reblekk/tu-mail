// The reading pane: a conversation shown as a stack of cards, one per message, newest first.
// Loaded by mail.html, which provides state, mailFetch, esc, svg, avatar helpers, emailDocument,
// sizeFrame, startCompose and the organizing actions from mail-organize.js.
//
// Each card renders its message in the same script-less sandboxed frame as before; quoted history
// inside a message (the "On … wrote:" tail every reply drags along) is folded behind a "•••"
// button so each card shows what that person actually wrote.
(function () {
  const T = { reqId: 0, subject: '', cards: new Map(), expandAll: false, cache: new Map() };
  const keyOf = (m) => `${m.folder}|${m.uid}`;

  // ------------------------------------------------------------------ small formatting helpers

  function pastel(seed) {
    let h = 0;
    for (const ch of String(seed || '?')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return { bg: `hsl(${h} 62% 86%)`, fg: `hsl(${h} 48% 24%)` };
  }

  function initialOf(p) {
    const base = String((p && (p.name || p.address)) || '?').replace(/[^\p{L}\p{N}]/gu, '');
    return ([...base][0] || '?').toUpperCase();
  }

  // "Tue 2026-09-29 8:13 AM"
  function cardDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${weekday} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
  }

  const isMe = (p) => p && String(p.address || '').toLowerCase() === String(user.email || '').toLowerCase();
  const nameOf = (p) => (p ? p.name || p.address : '');

  function toLine(m) {
    if (!m.to.length) return '(no recipients)';
    const shown = m.to.slice(0, 3).map((p) => (isMe(p) ? 'You' : nameOf(p)));
    return shown.join(', ') + (m.to.length > 3 ? ` +${m.to.length - 3}` : '');
  }

  const ACTION_ICONS = {
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    replyall: '<polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/>',
    forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  };
  const ico = (name) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[name]}</svg>`;

  // ------------------------------------------------------------------ building a card

  // Which attachments can be previewed inside the app (the server re-checks the file's real type).
  function previewKind(att) {
    const type = String(att.contentType || '').toLowerCase();
    const name = String(att.filename || '').toLowerCase();
    if (/^image\/(png|jpe?g|gif|webp)$/.test(type) || /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
    if (type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
    if (/\.(txt|csv|log)$/.test(name) && /^text\//.test(type)) return 'text';
    return '';
  }

  function attachmentsHtml(m) {
    return m.attachments.map((a) => {
      const base = `/api/mail/messages/${m.uid}/attachments/${a.index}?folder=${enc(m.folder)}&account=${enc(user.userId)}`;
      if (/\.ics$/i.test(a.filename || '') || /^text\/calendar/i.test(a.contentType || '')) return `<a class="msg-attachment" href="${base}" data-invitation="true" data-uid="${m.uid}" data-index="${a.index}" data-folder="${esc(m.folder)}">${svg('clip')}<span class="fname">${esc(a.filename || 'Meeting invitation')}</span><span class="fview">View invitation</span></a>`;
      const kind = previewKind(a);
      const preview = kind ? ` data-kind="${kind}" data-name="${esc(a.filename)}" data-size="${esc(fmtSize(a.size))}" data-src="${base}&inline=1" data-dl="${base}"` : '';
      return `<a class="msg-attachment${kind ? ' previewable' : ''}" href="${base}" download${preview}>${svg('clip')}<span class="fname">${esc(a.filename)}</span><span class="fsize">${esc(fmtSize(a.size))}</span>${kind ? '<span class="fview">Preview</span>' : ''}</a>`;
    }).join('');
  }

  function detailsHtml(m) {
    const rows = [
      ['From', m.from ? listHtml([m.from]) : ''],
      ['To', listHtml(m.to)],
      ['Cc', listHtml(m.cc)],
      ['Bcc', listHtml(m.bcc)],
      ['Reply-To', listHtml(m.replyTo)],
      ['Date', esc(fmtFullDate(m.date))],
    ].filter(([, v]) => v);
    return rows.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
  }

  function headHtml(card) {
    const m = card.m;
    const colours = pastel((m.from && (m.from.address || m.from.name)) || '?');
    const avatarStyle = m.fromSelf ? 'background:#1e4593;color:#fff' : `background:${colours.bg};color:${colours.fg}`;
    const sender = m.from
      ? `<span class="nm">${esc(m.fromSelf ? 'You' : nameOf(m.from))}</span>${m.from.name || m.fromSelf ? `<span class="ad">&lt;${esc(m.from.address)}&gt;</span>` : ''}`
      : '<span class="nm">(unknown sender)</span>';
    const flagged = m.flagged ? `<span class="card-flag" title="Flagged">${ico('flag')}</span>` : '';
    if (!card.expanded) {
      return `
        <div class="card-avatar" style="${avatarStyle}">${esc(initialOf(m.from))}</div>
        <div class="card-who">
          <div class="card-name">${sender}${flagged}</div>
          <div class="card-snippet">${esc(m.snippet || '(no preview)')}</div>
        </div>
        <div class="card-date">${esc(cardDate(m.date))}</div>`;
    }
    return `
      <div class="card-avatar" style="${avatarStyle}">${esc(initialOf(m.from))}</div>
      <div class="card-who">
        <div class="card-name">${sender}${flagged}</div>
        <div class="card-to">To: <span>${esc(toLine(m))}</span><button type="button" class="card-link" data-act="details">Details</button></div>
        <div class="card-date card-date-inline">${esc(cardDate(m.date))}</div>
      </div>
      <div class="card-actions">
        <div class="card-action-row">
          <button type="button" class="card-action translate" data-act="translate" title="Translate"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span>Translate</span></button>
          <button type="button" class="card-action reply" data-act="reply" title="Reply (R)">${ico('reply')}<span>Reply</span></button>
          <button type="button" class="card-action replyall" data-act="replyall" title="Reply all (A)">${ico('replyall')}<span>Reply all</span></button>
          <button type="button" class="card-action forward" data-act="forward" title="Forward">${ico('forward')}<span>Forward</span></button>
          <span class="card-divider"></span>
          <button type="button" class="card-more" data-act="more" aria-label="More actions" title="More">${ico('more')}</button>
        </div>
        <div class="card-date">${esc(cardDate(m.date))}</div>
      </div>`;
  }

  function cardHtml(card) {
    const m = card.m;
    if (!card.expanded) return `<div class="card-head card-head-collapsed" data-act="expand" role="button" tabindex="0">${headHtml(card)}</div>`;
    return `
      <div class="card-head">${headHtml(card)}</div>
      <div class="card-details" hidden>${detailsHtml(m)}</div>
      <div class="msg-attachments">${attachmentsHtml(m)}</div>
      <div class="safety-slot"></div>
      <div class="msg-banner card-banner" hidden>
        <span>Pictures are hidden to protect your privacy.</span>
        <button type="button" class="btn btn-secondary btn-sm" data-act="show-images">Show pictures</button>
      </div>
      <div class="card-body"><iframe class="msg-frame" title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe></div>
      <div class="card-foot">
        <button type="button" class="card-btn" data-act="reply">${ico('reply')}<span>Reply</span></button>
        <button type="button" class="card-btn" data-act="forward">${ico('forward')}<span>Forward</span></button>
      </div>`;
  }

  function buildCard(m, expanded) {
    const card = { m, expanded, showImages: window.TuPrefs ? window.TuPrefs.picturesOn() : false, el: document.createElement('article') };
    card.el.className = 'msg-card';
    card.el.dataset.key = keyOf(m);
    renderCard(card);
    return card;
  }

  function renderCard(card) {
    card.el.classList.toggle('collapsed', !card.expanded);
    card.el.classList.toggle('unread', !card.m.seen);
    card.el.innerHTML = cardHtml(card);
    if (card.expanded) loadBody(card);
  }

  // ------------------------------------------------------------------ the message body + folded quotes

  // Containers email programs wrap their quoted history in.
  const QUOTE_SELECTORS = ['.gmail_quote', '.yahoo_quoted', 'blockquote[type="cite"]', '.moz-cite-prefix', 'div[id^="appendonsend"]', '#divRplyFwdMsg', 'blockquote'];

  function quoteNodes(doc) {
    const body = doc.body;
    const found = new Set();
    QUOTE_SELECTORS.forEach((sel) => doc.querySelectorAll(sel).forEach((el) => found.add(el)));
    // Outlook: the "From:/Sent:/To:" block, and everything after it, is the quoted message. Outlook
    // on the web marks it with an id; the desktop app uses a thin top border instead.
    const outlook = doc.getElementById('divRplyFwdMsg') || doc.querySelector('div[style*="E1E1E1" i]');
    if (outlook) {
      const prev = outlook.previousElementSibling;
      if (prev && prev.tagName === 'HR') found.add(prev);
      let node = outlook;
      while (node && node !== body) {
        for (let s = node.nextSibling; s; s = s.nextSibling) {
          if (s.nodeType === 1) found.add(s);
          else if (s.nodeType === 3 && s.textContent.trim()) {
            const span = doc.createElement('span');
            s.replaceWith(span);
            span.appendChild(s);
            found.add(span);
          }
        }
        node = node.parentNode;
      }
    }
    // keep only outermost
    const all = [...found];
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  function foldQuotes(doc, frame) {
    const nodes = quoteNodes(doc);
    if (!nodes.length) return;
    // Only fold when the message has words of its own — a forward / quote-only mail shows everything.
    const quoted = new Set(nodes);
    let ownText = '';
    let ownImage = false;
    const walk = (parent) => {
      parent.childNodes.forEach((child) => {
        if (child.nodeType === 3) ownText += child.textContent;
        else if (child.nodeType === 1 && !quoted.has(child)) {
          if (child.tagName === 'IMG') ownImage = true;
          walk(child);
        }
      });
    };
    walk(doc.body);
    if (!ownText.trim() && !ownImage) return;

    const holder = doc.createElement('div');
    holder.className = 'eg-fold';
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = '•••';
    button.title = 'Show quoted text';
    holder.appendChild(button);
    nodes[0].parentNode.insertBefore(holder, nodes[0]);
    nodes.forEach((n) => { n.style.display = 'none'; });
    let open = false;
    button.addEventListener('click', () => {
      open = !open;
      nodes.forEach((n) => { n.style.display = open ? '' : 'none'; });
      button.title = open ? 'Hide quoted text' : 'Show quoted text';
      holder.classList.toggle('open', open);
      sizeFrame(frame);
    });
  }

  function loadBody(card) {
    const frame = card.el.querySelector('iframe');
    const m = card.m;
    card.el.querySelector('.card-banner').hidden = !m.remoteImages || card.showImages;
    try { if (window.MailSafety) window.MailSafety.attach(card.el, m); } catch (err) { /* hints are optional */ }
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      if (!card.folded) { foldQuotes(doc, frame); card.folded = true; }
      sizeFrame(frame);
      // mailto: links write a new message here instead of handing off to some other app.
      doc.addEventListener('click', (e) => {
        const link = e.target.closest && e.target.closest('a[href^="mailto:" i]');
        if (!link) return;
        e.preventDefault();
        let to = [];
        let subject = '';
        try {
          const url = new URL(link.getAttribute('href'));
          to = decodeURIComponent(url.pathname).split(/[,;]/).map((a) => a.trim()).filter(Boolean).map((address) => ({ address }));
          subject = url.searchParams.get('subject') || '';
        } catch (err) {
          // fall through with whatever parsed
        }
        startCompose({ mode: 'new', to, subject });
      });
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => sizeFrame(frame)));
      if (window.ResizeObserver) new ResizeObserver(() => sizeFrame(frame)).observe(doc.documentElement);
    });
    frame.srcdoc = emailDocument(m.html || '<p style="color:#6b7280">(This message has no content.)</p>', card.showImages);
    // The conversation view only read the start of a big message; fetch the rest once it's opened.
    if (m.partial && !card.hydrating) {
      card.hydrating = true;
      mailFetch(`/api/mail/messages/${m.uid}?folder=${enc(m.folder)}&peek=1`)
        .then((full) => {
          if (T.cards.get(keyOf(m)) !== card) return;
          Object.assign(card.m, full, { wasUnread: card.m.wasUnread, partial: false });
          card.folded = false;
          renderCard(card);
        })
        .catch(() => { card.hydrating = false; });
    }
  }

  // ------------------------------------------------------------------ the conversation

  function shouldExpand(m, index, total, primaryKey) {
    // `index` counts from the newest message: only the latest two (and the one opened) show open.
    return keyOf(m) === primaryKey || index < 2;
  }

  function sortedNewestFirst(messages) {
    return messages.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  }

  function headerHtml() {
    const count = T.cards.size;
    return `
      <div class="thread-head">
        <h1 class="msg-subject">${esc(T.subject || '(no subject)')}</h1>
        ${count > 1 ? `<div class="thread-meta"><span>${count} messages in this conversation</span><button type="button" class="card-link" data-act="toggle-all">${T.expandAll ? 'Collapse all' : 'Expand all'}</button></div>` : ''}
      </div>`;
  }

  function paintHeader() {
    const host = $('thread-header');
    if (host) host.innerHTML = headerHtml();
  }

  function startThread(primary) {
    T.cards = new Map();
    T.subject = primary.subject;
    T.expandAll = false;
    T.primaryKey = keyOf(primary);
    $('msg-content').innerHTML = `<div id="thread-header"></div><div class="thread" id="thread"></div>`;
    const card = buildCard(primary, true);
    T.cards.set(keyOf(primary), card);
    $('thread').appendChild(card.el);
    paintHeader();
    markLatest();
  }

  // Add the other messages of the conversation without touching the card already on screen
  // (moving an iframe in the DOM would reload it).
  function mergeConversation(messages) {
    const ordered = sortedNewestFirst(messages);
    const container = $('thread');
    if (!container) return;
    ordered.forEach((m, index) => {
      const key = keyOf(m);
      if (T.cards.has(key)) {
        // keep what the first fetch showed, but pick up fresher flags
        const existing = T.cards.get(key);
        existing.m.answered = m.answered;
        return;
      }
      const expanded = shouldExpand(m, index, ordered.length, T.primaryKey);
      const card = buildCard(m, expanded);
      T.cards.set(key, card);
      // find the first existing card that should come AFTER this one (older), insert before it
      let anchor = null;
      for (let j = index + 1; j < ordered.length; j += 1) {
        const later = T.cards.get(keyOf(ordered[j]));
        if (later && later.el.parentNode === container) { anchor = later.el; break; }
      }
      container.insertBefore(card.el, anchor);
    });
    T.subject = (ordered[ordered.length - 1] && ordered[ordered.length - 1].subject) || T.subject;
    paintHeader();
    markLatest();
  }

  function unreadBookkeeping(messages) {
    let changed = false;
    messages.forEach((m) => {
      if (!m.wasUnread) return;
      const row = m.folder === state.folder ? state.messages.find((x) => x.uid === m.uid) : null;
      if (row && !row.seen) { row.seen = true; changed = true; }
    });
    if (changed) renderList();
    loadFolders().catch(() => {});
  }

  // Anything that changes mail (move, delete, send) makes remembered conversations untrustworthy.
  // ---- a message that is still being sent: shown greyed out in the open chain and in the list ----
  window.mailPendingAdd = function mailPendingAdd(msg, source) {
    state.pending = state.pending || [];
    const src = source && state.current && T.cards.has(keyOf(state.current)) ? state.current : null;
    if (src) {
      msg.threadIds = [src.messageId, ...(src.references || [])].filter(Boolean);
      msg.sourceKey = keyOf(src);
      const container = $('thread');
      if (container && T.cards.has(keyOf({ folder: source.folder, uid: source.uid }))) {
        const card = buildCard(msg, true);
        card.el.classList.add('pending');
        T.cards.set(keyOf(msg), card);
        container.insertBefore(card.el, container.firstChild);
        paintHeader();
        markLatest();
      }
    }
    if (msg.threadIds.length) {
      state.pending.push(msg);
      renderList();
    }
  };
  window.mailPendingDone = function mailPendingDone(msg) {
    const card = T.cards.get(keyOf(msg));
    if (card) { card.el.remove(); T.cards.delete(keyOf(msg)); paintHeader(); markLatest(); }
    if (state.pending) state.pending = state.pending.filter((x) => x !== msg);
    renderList();
  };

  // Reply / Forward buttons belong to the newest real message only.
  function markLatest() {
    const container = $('thread');
    if (!container) return;
    let found = false;
    [...container.children].forEach((el) => {
      const isPending = el.classList.contains('pending');
      const latest = !found && !isPending;
      if (latest) found = true;
      el.classList.toggle('latest', latest);
    });
  }

  // Re-reads the open conversation (e.g. so a reply you just sent appears at the top).
  window.refreshThread = function refreshThread() {
    const m = state.current;
    if (m && $('thread')) return loadConversation(state.openReq, m.folder, m.uid);
    return null;
  };
  window.clearThreadCache = function clearThreadCache(items) { if (items && items.length) MailCache.invalidate(items); };

  window.clearMessagePane = function clearMessagePane() {
    state.uid = null;
    state.current = null;
    state.openReq += 1;
    T.reqId += 1;
    T.cards = new Map();
    $('mail-read-empty').hidden = false;
    $('mail-read-body').hidden = true;
    highlightSelected();
  };

  window.updateToolbar = function updateToolbar() {
    const m = state.current;
    if (!m) return;
    $('msg-flag').classList.toggle('on', !!m.flagged);
    $('msg-flag').querySelector('.label').textContent = m.flagged ? 'Unflag' : 'Flag';
    $('msg-unread').querySelector('.label').textContent = m.seen ? 'Mark unread' : 'Mark read';
    const role = (currentFolder() || {}).role;
    $('msg-spam').querySelector('.label').textContent = role === 'junk' ? 'Not spam' : 'Spam';
  };

  window.openMessage = async function openMessage(uid) {
    const folder = state.folder;
    const reqId = ++state.openReq;
    T.reqId = reqId;
    state.uid = uid;
    highlightSelected();
    $('mail-read-empty').hidden = true;
    $('mail-read-body').hidden = false;
    $('msg-content').innerHTML = '<div class="msg-loading"><div class="spinner"></div></div>';
    $('msg-scroll').scrollTop = 0;
    try {
      // A conversation opened before appears instantly from memory, then is brought up to date.
      const hit = await MailCache.getThread(folder, uid);
      if (reqId !== state.openReq) return;
      const cachedPrimary = hit && hit.messages.find((x) => x.folder === folder && x.uid === uid);
      if (cachedPrimary) {
        hit.messages.forEach((x) => { x.seen = true; }); // opening it marks the whole chain read
        state.current = cachedPrimary;
        startThread(cachedPrimary);
        updateToolbar();
        mergeConversation(hit.messages);
        loadConversation(reqId, folder, uid);
        return;
      }
      // 1. The message itself — shown straight away.
      const m = await mailFetch(`/api/mail/messages/${uid}?folder=${enc(folder)}`);
      if (reqId !== state.openReq) return;
      const wasUnread = state.messages.find((x) => x.uid === uid && !x.seen);
      m.wasUnread = Boolean(wasUnread);
      state.current = m;
      startThread(m);
      updateToolbar();
      if (wasUnread) {
        wasUnread.seen = true;
        const f = currentFolder();
        if (f) f.unseen = Math.max(0, f.unseen - 1);
        renderFolders();
        const li = $('mail-list').querySelector(`.mail-item[data-uid="${uid}"]`);
        if (li) li.classList.remove('unread');
      }
      // 2. The rest of the conversation arrives as cards a moment later.
      loadConversation(reqId, folder, uid);
    } catch (err) {
      if (reqId !== state.openReq) return;
      if (err instanceof MailAuthRequired) return showConnect();
      $('msg-content').innerHTML = `<div class="msg-error"><div class="big">Couldn't open this message</div>${esc(err.message)}</div>`;
    }
  };

  async function loadConversation(reqId, folder, uid) {
    try {
      const data = await mailFetch(`/api/mail/thread?folder=${enc(folder)}&uid=${uid}`);
      if (reqId !== state.openReq) return;
      MailCache.putThread(data.messages);
      if (data.messages.length > 1) mergeConversation(data.messages);
      unreadBookkeeping(data.messages);
    } catch (err) {
      // The conversation is a bonus on top of the message that's already showing.
    }
  }

  // ------------------------------------------------------------------ interactions

  function cardFor(el) {
    const article = el.closest('.msg-card');
    return article ? T.cards.get(article.dataset.key) : null;
  }

  function setExpanded(card, expanded) {
    card.expanded = expanded;
    card.folded = false;
    renderCard(card);
  }

  function openCardMenu(card, anchor) {
    const m = card.m;
    const role = m.folder === state.folder ? (currentFolder() || {}).role : null;
    const items = [
      { label: m.seen ? 'Mark as unread' : 'Mark as read', run: () => flagMessage(m, m.seen ? 'unread' : 'read') },
      { label: m.flagged ? 'Remove flag' : 'Flag', run: () => flagMessage(m, m.flagged ? 'unstar' : 'star') },
      { divider: true },
      { label: 'Reply', run: () => startCompose({ mode: 'reply', folder: m.folder, uid: m.uid }) },
      { label: 'Reply all', run: () => startCompose({ mode: 'replyall', folder: m.folder, uid: m.uid }) },
      { label: 'Forward', run: () => startCompose({ mode: 'forward', folder: m.folder, uid: m.uid }) },
      { divider: true },
      { label: 'Archive', run: () => actArchive([m]) },
      { label: 'Move to…', run: () => actMove([m]) },
      { label: role === 'junk' ? 'Not spam' : 'Mark as spam', run: () => actSpam([m]) },
      { label: 'Delete', danger: true, run: () => actDelete([m]) },
    ];
    openPopupMenu(anchor, items);
  }

  function onThreadClick(e) {
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'toggle-all') {
      T.expandAll = !T.expandAll;
      T.cards.forEach((card) => { if (card.expanded !== T.expandAll && keyOf(card.m) !== T.primaryKey) setExpanded(card, T.expandAll); });
      paintHeader();
      return;
    }
    const card = cardFor(actEl);
    if (!card) return;
    const m = card.m;
    if (act === 'expand') setExpanded(card, true);
    else if (act === 'details') {
      const box = card.el.querySelector('.card-details');
      box.hidden = !box.hidden;
      setTimeout(() => card.el.querySelector('iframe') && sizeFrame(card.el.querySelector('iframe')), 0);
    } else if (act === 'show-images') {
      card.showImages = true;
      card.el.querySelector('.card-banner').hidden = true;
      card.folded = false;
      card.el.querySelector('iframe').srcdoc = emailDocument(m.html || '', true);
    } else if (act === 'more') openCardMenu(card, actEl);
    else if (['reply', 'replyall', 'forward'].includes(act)) startCompose({ mode: act, folder: m.folder, uid: m.uid });
  }

  // Called by the organizing code after it changes a message (flag, read state) so any card on
  // screen reflects it.
  window.refreshCard = function refreshCard(m) {
    const card = T.cards.get(keyOf(m));
    if (!card) return;
    card.m.seen = m.seen;
    card.m.flagged = m.flagged;
    const head = card.el.querySelector('.card-head');
    if (head) head.innerHTML = headHtml(card);
    card.el.classList.toggle('unread', !card.m.seen);
  };

  // A message left this view (moved, deleted): drop its card; if it was the last, the pane clears.
  window.removeCard = function removeCard(folder, uid) {
    const key = `${folder}|${uid}`;
    const card = T.cards.get(key);
    if (!card) return false;
    card.el.remove();
    T.cards.delete(key);
    paintHeader();
    return key === T.primaryKey;
  };

  window.threadHasCards = () => T.cards.size > 0;

  $('msg-content').addEventListener('click', onThreadClick);
  $('msg-content').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card-head-collapsed')) { e.preventDefault(); onThreadClick({ target: e.target }); }
  });
  window.addEventListener('resize', () => T.cards.forEach((card) => { const f = card.el.querySelector('iframe'); if (f) sizeFrame(f); }));
})();
