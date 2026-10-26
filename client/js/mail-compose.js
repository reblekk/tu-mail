// Writing mail: new message, reply, reply all, forward. Loaded by mail.html, which provides
// mailFetch / state / esc / toast / MailAuthRequired.
//
// The message body is edited inside a script-less sandboxed <iframe> (designMode), the same
// containment used to *read* mail: whatever ends up in it — including quoted text from a hostile
// email — can never run code in the app's own page.
(function () {
  const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
  const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
  const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
  const $c = (id) => document.getElementById(id);

  const ICONS = {
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    redo: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    ul: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    ol: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    indent: '<polyline points="3 8 7 12 3 16"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="18" x2="11" y2="18"/>',
    outdent: '<polyline points="7 8 3 12 7 16"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="18" x2="11" y2="18"/>',
    left: '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>',
    center: '<line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/>',
    right: '<line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  };
  const ico = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

  const c = {
    mode: 'new',
    folder: null,
    uid: null,
    prep: null,
    attachments: [], // files added by the person
    forwarded: [], // attachments of the message being forwarded: {index, filename, size}
    dirty: false,
    sending: false,
    busy: false,
    editorDoc: null,
    editorReady: null,
    fields: {},
    draft: null, // {folder, uid} of this message's saved copy in Drafts, once there is one
    keep: null, // {folder, uid} of the message whose attachments (c.forwarded) are carried along
    saveTimer: null,
    savePromise: null,
  };
  let built = false;
  let revision = 0;
  let recoveryQueue = Promise.resolve();
  function preserveRecovery() {
    if (!built || !c.editorDoc || c.busy) return Promise.resolve();
    const record = { id:c.recoveryId, account:user.userId, updated:Date.now(), subject:$c('cmp-subject').value,
      html:editorBodyHtml(), fields:Object.fromEntries(Object.entries(c.fields).map(([k,f])=>[k,{items:f.items.map(x=>({...x})),input:f.input.value}])),
      files:c.attachments.map(a=>a.file), forwarded:c.forwarded.map(a=>({...a})), keep:c.keep, draft:c.draft,
      mode:c.mode, folder:c.folder, uid:c.uid, prep:c.prep, sendAttempt:c.sendAttempt, sendUncertain:Boolean(c.sendUncertain || c.sending) };
    recoveryQueue = recoveryQueue.catch(()=>{}).then(()=>MailRecovery.save(record));
    recoveryQueue.catch(()=>{ if(built) $c('cmp-status').textContent='Local recovery unavailable — keep this tab open until the draft is saved.'; });
    return recoveryQueue;
  }
  async function removeRecovery() { const id=c.recoveryId; await recoveryQueue.catch(()=>{}); await MailRecovery.remove(id); }

  let openToken = 0;

  // ------------------------------------------------------------------ small helpers

  function fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  const totalBytes = () => c.attachments.reduce((sum, a) => sum + a.size, 0) + c.forwarded.reduce((sum, a) => sum + a.size, 0);
  const isPhone = () => window.matchMedia('(max-width: 899px)').matches;

  // "Name <a@b.com>, c@d.com; ..." -> [{name, address}]
  function parseAddressList(text) {
    const out = [];
    const pattern = /(?:"?([^"<>,;]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g;
    let m;
    while ((m = pattern.exec(String(text))) !== null) {
      out.push({ name: (m[1] || '').trim(), address: (m[2] || m[3]).trim() });
    }
    return out;
  }

  function initialsOf(p) {
    const base = String((p.name || p.address || '?')).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (base.length >= 2) return ([...base[0]][0] + [...base[1]][0]).toUpperCase();
    return [...(base[0] || '?')].slice(0, 2).join('').toUpperCase();
  }

  // ------------------------------------------------------------------ in-app dialogs (no window.confirm)

  function askDialog({ title, message, confirmText = 'OK', cancelText = 'Cancel', input = null, danger = false }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'cmp-dialog-overlay';
      wrap.innerHTML = `
        <div class="cmp-dialog" role="alertdialog" aria-modal="true">
          <h4>${esc(title)}</h4>
          ${message ? `<p>${esc(message)}</p>` : ''}
          ${input ? `<input type="text" class="cmp-dialog-input" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" />` : ''}
          <div class="cmp-dialog-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-act="cancel">${esc(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const field = wrap.querySelector('.cmp-dialog-input');
      const finish = (ok) => {
        document.removeEventListener('keydown', onKey, true);
        const value = field ? field.value.trim() : true;
        wrap.remove();
        resolve(ok ? value : null);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); finish(true); }
      };
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) finish(act.dataset.act === 'ok');
        else if (e.target === wrap) finish(false);
      });
      setTimeout(() => (field || wrap.querySelector('[data-act="ok"]')).focus(), 30);
    });
  }

  // ------------------------------------------------------------------ recipient fields

  function contactPool() {
    const map = new Map();
    const me = String(user.email || '').toLowerCase();
    const add = (p, weight) => {
      if (!p || !p.address) return;
      const key = p.address.toLowerCase();
      if (key === me) return;
      const entry = map.get(key) || { name: '', address: p.address, score: 0 };
      if (p.name && !entry.name) entry.name = p.name;
      entry.score += weight;
      map.set(key, entry);
    };
    (window.savedMailContacts || []).forEach(p => add(p, 5));
    (state.messages || []).forEach((m) => {
      add(m.from, 1);
      (m.to || []).forEach((p) => add(p, 2)); // people you've written to rank higher
    });
    if (c.prep) {
      add(c.prep.from, 3);
      (c.prep.originalTo || []).forEach((p) => add(p, 2));
      (c.prep.originalCc || []).forEach((p) => add(p, 2));
    }
    return [...map.values()];
  }

  class RecipientField {
    constructor(root, key) {
      this.root = root;
      this.key = key;
      this.items = [];
      this.input = root.querySelector('input');
      this.active = -1;
      this.matches = [];
      this.suggestBox = root.closest('.cmp-row').querySelector('.cmp-suggest');
      this.bind();
    }

    add(person) {
      const address = String(person.address || '').trim();
      if (!address) return;
      if (this.items.some((i) => i.address.toLowerCase() === address.toLowerCase())) return;
      this.items.push({ name: person.name || '', address, valid: EMAIL_PATTERN.test(address) });
      this.render();
      markDirty();
    }

    set(list) {
      this.items = [];
      (list || []).forEach((p) => this.add(p));
      this.render();
    }

    commit() {
      const text = this.input.value.trim();
      if (!text) return;
      const parsed = parseAddressList(text);
      if (parsed.length) parsed.forEach((p) => this.add(p));
      else this.add({ address: text }); // shown red, so the typo is visible instead of silently dropped
      this.input.value = '';
      this.hideSuggest();
    }

    render() {
      this.root.querySelectorAll('.cmp-chip').forEach((el) => el.remove());
      this.items.forEach((item, i) => {
        const chip = document.createElement('span');
        chip.className = `cmp-chip${item.valid ? '' : ' invalid'}`;
        chip.dataset.i = String(i);
        chip.title = item.valid ? item.address : `"${item.address}" isn't a valid email address`;
        chip.innerHTML = `<span class="who">${esc(item.name || item.address)}</span><button type="button" class="x" aria-label="Remove">&times;</button>`;
        this.root.insertBefore(chip, this.input);
      });
    }

    values() {
      return this.items.filter((i) => i.valid).map((i) => ({ name: i.name, address: i.address }));
    }

    hasInvalid() {
      return this.items.some((i) => !i.valid);
    }

    hideSuggest() {
      this.suggestBox.hidden = true;
      this.matches = [];
      this.active = -1;
    }

    showSuggest() {
      const q = this.input.value.trim().toLowerCase();
      if (q.length < 1) return this.hideSuggest();
      const taken = new Set([...Object.values(c.fields)].flatMap((f) => f.items.map((i) => i.address.toLowerCase())));
      this.matches = contactPool()
        .filter((p) => !taken.has(p.address.toLowerCase()) && (p.address.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      if (!this.matches.length) return this.hideSuggest();
      this.active = 0;
      this.suggestBox.innerHTML = this.matches
        .map((p, i) => `<div class="cmp-suggest-item${i === 0 ? ' active' : ''}" data-i="${i}"><span class="av">${esc(initialsOf(p))}</span><span class="t"><b>${esc(p.name || p.address)}</b>${p.name ? `<span>${esc(p.address)}</span>` : ''}</span></div>`)
        .join('');
      this.suggestBox.hidden = false;
    }

    pick(i) {
      const p = this.matches[i];
      if (!p) return;
      this.input.value = '';
      this.add(p);
      this.hideSuggest();
      this.input.focus();
    }

    bind() {
      this.root.addEventListener('click', (e) => {
        const x = e.target.closest('.x');
        if (x) {
          this.items.splice(Number(x.closest('.cmp-chip').dataset.i), 1);
          this.render();
          markDirty();
          return;
        }
        const chip = e.target.closest('.cmp-chip');
        if (chip) {
          // Click a chip to edit it as text.
          const [item] = this.items.splice(Number(chip.dataset.i), 1);
          this.render();
          this.input.value = item.address;
          this.input.focus();
          return;
        }
        this.input.focus();
      });
      this.input.addEventListener('input', () => { this.showSuggest(); markDirty(); });
      this.input.addEventListener('keydown', (e) => {
        const open = !this.suggestBox.hidden && this.matches.length;
        if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length;
          this.suggestBox.querySelectorAll('.cmp-suggest-item').forEach((el, i) => el.classList.toggle('active', i === this.active));
        } else if ((e.key === 'Enter' || e.key === 'Tab') && open && this.input.value.trim()) {
          e.preventDefault();
          this.pick(this.active);
        } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
          if (this.input.value.trim()) { e.preventDefault(); this.commit(); }
        } else if (e.key === ' ' && EMAIL_PATTERN.test(this.input.value.trim())) {
          e.preventDefault();
          this.commit();
        } else if (e.key === 'Backspace' && !this.input.value && this.items.length) {
          this.items.pop();
          this.render();
          markDirty();
        } else if (e.key === 'Escape' && open) {
          e.stopPropagation();
          this.hideSuggest();
        }
      });
      this.input.addEventListener('blur', () => setTimeout(() => { this.commit(); this.hideSuggest(); }, 120));
      this.input.addEventListener('paste', (e) => {
        const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
        if (/[,;\s<]/.test(text.trim())) {
          e.preventDefault();
          parseAddressList(text).forEach((p) => this.add(p));
        }
      });
      this.suggestBox.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.cmp-suggest-item');
        if (item) { e.preventDefault(); this.pick(Number(item.dataset.i)); }
      });
    }
  }

  // ------------------------------------------------------------------ the editor (sandboxed)

  function editorDocument(bodyHtml) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
      html{height:100%;-webkit-text-size-adjust:100%}
      body{margin:0;padding:14px 18px 40px;min-height:100%;box-sizing:border-box;font:14.5px/1.55 Arial,Helvetica,sans-serif;color:#1b2430;overflow-wrap:anywhere;outline:none;cursor:text}
      img{max-width:100%;height:auto}
      a{color:#b90f22}
      p{margin:0 0 8px}
      blockquote{margin:6px 0 0;padding-left:12px;border-left:3px solid #cfd6e4;color:#444}
      table{max-width:100%;border-collapse:collapse}
      td,th{border:1px solid #e2e6ec;padding:3px 6px}
    </style></head><body>${bodyHtml}</body></html>`;
  }

  // Pasted content from Word, web pages, other mail: keep structure and basic styling, drop the rest.
  const PASTE_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'P', 'DIV', 'SPAN', 'UL', 'OL', 'LI', 'A', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE', 'CODE', 'SUB', 'SUP', 'FONT', 'HR']);
  function cleanPastedHtml(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === 8) { child.remove(); return; }
        if (child.nodeType !== 1) return;
        const tag = child.tagName;
        if (!PASTE_TAGS.has(tag)) {
          if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'IMG', 'SVG', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) { child.remove(); return; }
          walk(child);
          child.replaceWith(...child.childNodes); // unknown wrapper: keep its text, drop the element
          return;
        }
        const href = tag === 'A' ? child.getAttribute('href') : null;
        const keepStyle = [];
        const style = child.getAttribute('style') || '';
        const colour = style.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]*\)|[a-z]+)\s*(?:;|$)/i);
        if (colour) keepStyle.push(`color:${colour[1]}`);
        if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) keepStyle.push('font-weight:bold');
        if (/font-style\s*:\s*italic/i.test(style)) keepStyle.push('font-style:italic');
        if (/text-decoration[^;]*underline/i.test(style)) keepStyle.push('text-decoration:underline');
        [...child.attributes].forEach((a) => child.removeAttribute(a.name));
        if (keepStyle.length) child.setAttribute('style', keepStyle.join(';'));
        if (href && /^(https?:|mailto:)/i.test(href.trim())) child.setAttribute('href', href.trim());
        walk(child);
      });
    };
    walk(parsed.body);
    return parsed.body.innerHTML;
  }

  function editorBodyHtml() {
    return c.editorDoc ? c.editorDoc.body.innerHTML : '';
  }
  function editorIsEmpty() {
    if (!c.editorDoc) return true;
    const body = c.editorDoc.body;
    return !body.textContent.trim() && !body.querySelector('img, table, hr');
  }

  function loadEditor(bodyHtml) {
    const frame = $c('cmp-editor');
    c.editorDoc = null;
    c.editorReady = new Promise((resolve) => {
      frame.onload = () => {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return resolve();
        doc.designMode = 'on';
        try { doc.execCommand('styleWithCSS', false, false); } catch (err) { /* older engines */ }
        c.editorDoc = doc;
        doc.addEventListener('input', markDirty);
        doc.addEventListener('selectionchange', updateToolbarState);
        doc.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); requestClose(); }
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendNow(); }
        });
        doc.addEventListener('paste', (e) => {
          const data = e.clipboardData;
          if (!data) return;
          const pictures = [...(data.files || [])].filter((f) => f.type.startsWith('image/'));
          if (pictures.length) { e.preventDefault(); pictures.forEach(insertPicture); return; }
          const html = data.getData('text/html');
          if (html) { e.preventDefault(); doc.execCommand('insertHTML', false, cleanPastedHtml(html)); markDirty(); }
        });
        doc.addEventListener('drop', (e) => {
          const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
          if (files.length) { e.preventDefault(); addFiles(files); }
        });
        // Links in the draft shouldn't navigate the editor away.
        doc.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); });
        resolve();
      };
      frame.srcdoc = editorDocument(bodyHtml);
    });
    return c.editorReady;
  }

  function focusEditorStart() {
    const doc = c.editorDoc;
    if (!doc) return;
    $c('cmp-editor').contentWindow.focus();
    const range = doc.createRange();
    range.setStart(doc.body, 0);
    range.collapse(true);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function exec(command, value) {
    const doc = c.editorDoc;
    if (!doc || c.busy) return;
    $c('cmp-editor').contentWindow.focus();
    doc.execCommand(command, false, value);
    markDirty();
    updateToolbarState();
  }

  const TOGGLES = { bold: 'bold', italic: 'italic', underline: 'underline', insertUnorderedList: 'ul', insertOrderedList: 'ol', justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right' };
  function updateToolbarState() {
    const doc = c.editorDoc;
    if (!doc) return;
    Object.entries(TOGGLES).forEach(([cmd, id]) => {
      const btn = document.querySelector(`#cmp-toolbar [data-cmd="${cmd}"]`);
      if (!btn) return;
      let on = false;
      try { on = doc.queryCommandState(cmd); } catch (err) { on = false; }
      btn.classList.toggle('on', on);
    });
  }

  function insertPicture(file) {
    if (file.size > MAX_PICTURE_BYTES) { toast('That picture is over 5 MB — attach it as a file instead', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => exec('insertImage', String(reader.result));
    reader.readAsDataURL(file);
  }

  async function insertLink() {
    const doc = c.editorDoc;
    if (!doc) return;
    const selected = doc.getSelection().toString();
    const url = await askDialog({ title: 'Insert link', message: selected ? `Link “${selected.slice(0, 60)}” to:` : 'Web address or email:', input: { placeholder: 'https://…' }, confirmText: 'Insert' });
    if (!url) return;
    let href = url.trim();
    if (!/^(https?:|mailto:)/i.test(href)) href = EMAIL_PATTERN.test(href) ? `mailto:${href}` : `https://${href.replace(/^\/+/, '')}`;
    $c('cmp-editor').contentWindow.focus();
    if (selected) doc.execCommand('createLink', false, href);
    else doc.execCommand('insertHTML', false, `<a href="${esc(href)}">${esc(url)}</a>&nbsp;`);
    markDirty();
  }

  // ------------------------------------------------------------------ attachments

  function addFiles(files) {
    [...files].forEach((file) => {
      if (file.size > MAX_TOTAL_BYTES) { toast(`“${file.name}” is over 20 MB`, 'error'); return; }
      if (totalBytes() + file.size > MAX_TOTAL_BYTES) { toast('Attachments can total at most 20 MB', 'error'); return; }
      if (c.attachments.some((a) => a.file.name === file.name && a.size === file.size)) return;
      c.attachments.push({ file, size: file.size });
    });
    renderAttachments();
    markDirty();
  }

  function renderAttachments() {
    const box = $c('cmp-attachments');
    const chip = (kind, i, name, size) => `<span class="cmp-att" data-kind="${kind}" data-i="${i}">${ico('clip')}<span class="n">${esc(name)}</span><span class="s">${esc(fmtBytes(size))}</span><button type="button" class="x" aria-label="Remove ${esc(name)}">&times;</button></span>`;
    box.innerHTML =
      c.forwarded.map((a, i) => chip('fwd', i, a.filename, a.size)).join('') +
      c.attachments.map((a, i) => chip('new', i, a.file.name, a.size)).join('');
    box.hidden = !box.innerHTML;
    const total = totalBytes();
    $c('cmp-size').textContent = total ? `${fmtBytes(total)} of 20 MB` : '';
    $c('cmp-size').classList.toggle('warn', total > MAX_TOTAL_BYTES * 0.9);
  }

  // ------------------------------------------------------------------ state: dirty / busy

  function markDirty() {
    if (c.busy) return;
    c.dirty = true;
    revision += 1;
    if (!c.sendUncertain) c.sendAttempt = crypto.randomUUID();
    preserveRecovery().catch(()=>{});
    // Whatever the last complaint was, the person is now fixing it.
    if (built && !$c('cmp-error').hidden && !c.sending) showError('');
    scheduleAutosave();
  }

  // ------------------------------------------------------------------ drafts

  const hasContent = () => Boolean(
    c.fields.to.items.length || c.fields.cc.items.length || c.fields.bcc.items.length ||
    $c('cmp-subject').value.trim() || !editorIsEmpty() || c.attachments.length
  );

  function scheduleAutosave() {
    clearTimeout(c.saveTimer);
    if (c.sending || c.busy) return;
    c.saveTimer = setTimeout(() => { saveDraft({ quiet: true }).catch(() => { $c('cmp-status').textContent='Mailbox draft not saved — local recovery retained if available.'; }); }, 4000);
  }

  // The message exactly as the server needs it — shared by Send and Save draft.
  function buildForm({ forSend }) {
    const form = new FormData();
    form.append('mode', c.mode);
    if (forSend) form.append('sendAttempt', c.sendAttempt);
    form.append('to', JSON.stringify(c.fields.to.values()));
    form.append('cc', JSON.stringify(c.fields.cc.values()));
    form.append('bcc', JSON.stringify(c.fields.bcc.values()));
    form.append('subject', $c('cmp-subject').value.trim());
    form.append('html', editorBodyHtml());
    if (c.prep && c.mode !== 'forward') {
      form.append('inReplyTo', c.prep.inReplyTo || '');
      form.append('references', JSON.stringify(c.prep.references || []));
    }
    if (c.mode !== 'new' && c.folder && c.uid) {
      form.append('sourceFolder', c.folder);
      form.append('sourceUid', String(c.uid));
    }
    // Attachments carried over from another message: a forward's originals, or this draft's own.
    if (c.keep && c.forwarded.length) {
      form.append('keepFolder', c.keep.folder);
      form.append('keepUid', String(c.keep.uid));
      form.append('keepIndexes', JSON.stringify(c.forwarded.map((a) => a.index)));
    }
    if (forSend && c.draft) {
      form.append('draftFolder', c.draft.folder);
      form.append('draftUid', String(c.draft.uid));
    }
    if (!forSend && c.draft) form.append('replaceUid', String(c.draft.uid));
    c.attachments.forEach((a) => form.append('files', a.file, a.file.name));
    return form;
  }

  // Save what's there to the Drafts folder. Files already saved with the draft stay on the server
  // (it hands back where they are now), so only newly added ones are uploaded each time.
  function saveDraft({ quiet = false } = {}) {
    if (c.sending || c.busy) return Promise.resolve(false);
    if (c.savePromise) return c.savePromise.then(() => saveDraft({ quiet }));
    if (!hasContent()) return Promise.resolve(false);
    Object.values(c.fields).forEach((f) => f.commit());
    clearTimeout(c.saveTimer);
    const savedRevision = revision;
    const saveToken = openToken;
    const run = (async () => {
      if (!quiet) $c('cmp-status').textContent = 'Saving…';
      const saved = await mailFetch('/api/mail/draft', { method: 'POST', body: buildForm({ forSend: false }) });
      if (saveToken !== openToken) return false;
      c.draft = { folder: saved.folder, uid: saved.uid };
      c.dirty = revision !== savedRevision;
      if (revision === savedRevision && (c.attachments.length || c.forwarded.length)) {
        const fresh = await mailFetch(`/api/mail/messages/${saved.uid}/draft?folder=${encodeURIComponent(saved.folder)}`);
        if (revision !== savedRevision || saveToken !== openToken) { scheduleAutosave(); return true; }
        c.keep = { folder: saved.folder, uid: saved.uid };
        c.forwarded = fresh.attachments.map((a) => ({ index: a.index, filename: a.filename, size: a.size }));
        c.attachments = [];
        renderAttachments();
      }
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (!c.sending) $c('cmp-status').textContent = c.dirty ? 'New edits waiting to save…' : `Draft saved ${time}`;
      await preserveRecovery().catch(()=>{});
      if (c.dirty) scheduleAutosave();
      return true;
    })();
    c.savePromise = run;
    return run.finally(() => { if (c.savePromise === run) c.savePromise = null; });
  }

  function setBusy(on, label) {
    c.busy = on;
    $c('cmp-window').classList.toggle('loading', on);
    $c('cmp-status').textContent = label || '';
  }

  function setSending(on) {
    c.sending = on;
    $c('cmp-window').classList.toggle('sending', on);
    document.querySelectorAll('.cmp-send-btn').forEach((b) => { b.disabled = on; });
    $c('cmp-status').textContent = on ? 'Sending…' : '';
  }

  function showError(message) {
    const box = $c('cmp-error');
    box.textContent = message || '';
    box.hidden = !message;
    if (message) box.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ building the window

  function build() {
    if (built) return;
    built = true;
    const toolbarButtons = [
      ['undo', 'undo', 'Undo'], ['redo', 'redo', 'Redo'], '|',
      ['bold', null, 'Bold (Ctrl+B)', '<b>B</b>'], ['italic', null, 'Italic (Ctrl+I)', '<i>I</i>'], ['underline', null, 'Underline (Ctrl+U)', '<u>U</u>'], '|',
      'size', 'color', '|',
      ['insertUnorderedList', 'ul', 'Bulleted list'], ['insertOrderedList', 'ol', 'Numbered list'], ['outdent', 'outdent', 'Decrease indent'], ['indent', 'indent', 'Increase indent'], '|',
      ['justifyLeft', 'left', 'Align left'], ['justifyCenter', 'center', 'Center'], ['justifyRight', 'right', 'Align right'], '|',
      ['link', 'link', 'Insert link'], ['picture', 'image', 'Insert picture'], ['removeFormat', null, 'Clear formatting', 'T<sub>x</sub>'],
    ];
    const toolbarHtml = toolbarButtons.map((b) => {
      if (b === '|') return '<span class="cmp-sep"></span>';
      if (b === 'size') return `<select class="cmp-size-select" id="cmp-fontsize" title="Text size" aria-label="Text size"><option value="2">Small</option><option value="3" selected>Normal</option><option value="5">Large</option><option value="6">Huge</option></select>`;
      if (b === 'color') return `<label class="cmp-color" title="Text colour"><input type="color" id="cmp-color" value="#1b2430" aria-label="Text colour" /><span>A</span></label>`;
      const [cmd, icon, title, text] = b;
      return `<button type="button" class="cmp-tool" data-cmd="${cmd}" title="${esc(title)}" aria-label="${esc(title)}">${icon ? ico(icon) : text}</button>`;
    }).join('');

    const wrap = document.createElement('div');
    wrap.className = 'cmp-overlay';
    wrap.id = 'compose-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="cmp-window" id="cmp-window" role="dialog" aria-modal="true" aria-labelledby="cmp-title">
        <div class="cmp-head">
          <button type="button" class="mail-icon-btn cmp-close" id="cmp-close" aria-label="Close">${ico('close')}</button>
          <button type="button" class="mail-icon-btn cmp-back" id="cmp-back" aria-label="Close">${ico('back')}</button>
          <h3 id="cmp-title">New message</h3>
          <button type="button" class="mail-icon-btn cmp-send-icon cmp-send-btn" id="cmp-send-phone" aria-label="Send">${ico('send')}</button>
        </div>
        <div class="cmp-progress"></div>
        <div class="cmp-error" id="cmp-error" hidden></div>
        <div class="cmp-fields">
          <div class="cmp-row cmp-from-row"><label>From</label><span class="cmp-from" id="cmp-from"></span>
            <span class="cmp-toggles"><button type="button" id="cmp-show-cc">Cc</button><button type="button" id="cmp-show-bcc">Bcc</button></span></div>
          <div class="cmp-row"><label for="cmp-to-input">To</label><div class="cmp-chips" id="cmp-to"><input type="text" id="cmp-to-input" autocomplete="off" autocapitalize="off" inputmode="email" /></div><div class="cmp-suggest" hidden></div></div>
          <div class="cmp-row" id="cmp-cc-row" hidden><label for="cmp-cc-input">Cc</label><div class="cmp-chips" id="cmp-cc"><input type="text" id="cmp-cc-input" autocomplete="off" autocapitalize="off" inputmode="email" /></div><div class="cmp-suggest" hidden></div></div>
          <div class="cmp-row" id="cmp-bcc-row" hidden><label for="cmp-bcc-input">Bcc</label><div class="cmp-chips" id="cmp-bcc"><input type="text" id="cmp-bcc-input" autocomplete="off" autocapitalize="off" inputmode="email" /></div><div class="cmp-suggest" hidden></div></div>
          <div class="cmp-row"><label for="cmp-subject">Subject</label><input type="text" id="cmp-subject" class="cmp-subject" autocomplete="off" /></div>
        </div>
        <div class="cmp-toolbar" id="cmp-toolbar">${toolbarHtml}</div>
        <div class="cmp-editor-wrap"><iframe id="cmp-editor" title="Message body" sandbox="allow-same-origin"></iframe></div>
        <div class="cmp-attachments" id="cmp-attachments" hidden></div>
        <div class="cmp-foot">
          <button type="button" class="btn btn-primary cmp-send-btn" id="cmp-send">${ico('send')}<span>Send</span></button>
          <button type="button" class="btn btn-secondary" id="cmp-attach">${ico('clip')}<span>Attach</span></button>
          <span class="cmp-size" id="cmp-size"></span>
          <span class="cmp-status" id="cmp-status"></span>
          <button type="button" class="mail-icon-btn cmp-discard" id="cmp-discard" aria-label="Discard" title="Discard">${ico('trash')}</button>
        </div>
        <input type="file" id="cmp-file" multiple hidden />
        <input type="file" id="cmp-picture" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
      </div>`;
    document.body.appendChild(wrap);

    c.fields = { to: new RecipientField($c('cmp-to'), 'to'), cc: new RecipientField($c('cmp-cc'), 'cc'), bcc: new RecipientField($c('cmp-bcc'), 'bcc') };

    $c('cmp-close').addEventListener('click', requestClose);
    $c('cmp-back').addEventListener('click', discardDraft);
    $c('cmp-discard').addEventListener('click', discardDraft);
    $c('cmp-send').addEventListener('click', sendNow);
    $c('cmp-send-phone').addEventListener('click', sendNow);
    $c('cmp-attach').addEventListener('click', () => $c('cmp-file').click());
    $c('cmp-file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $c('cmp-picture').addEventListener('change', (e) => { [...e.target.files].forEach(insertPicture); e.target.value = ''; });
    $c('cmp-subject').addEventListener('input', markDirty);
    $c('cmp-show-cc').addEventListener('click', () => showExtra('cc'));
    $c('cmp-show-bcc').addEventListener('click', () => showExtra('bcc'));
    $c('cmp-attachments').addEventListener('click', (e) => {
      const x = e.target.closest('.x');
      if (!x) return;
      const chip = x.closest('.cmp-att');
      const i = Number(chip.dataset.i);
      if (chip.dataset.kind === 'fwd') c.forwarded.splice(i, 1);
      else c.attachments.splice(i, 1);
      renderAttachments();
    });

    // Toolbar: mousedown is cancelled so clicking a button doesn't steal the editor's selection.
    $c('cmp-toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('.cmp-tool')) e.preventDefault(); });
    $c('cmp-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('.cmp-tool');
      if (!btn) return;
      const cmd = btn.dataset.cmd;
      if (cmd === 'link') insertLink();
      else if (cmd === 'picture') $c('cmp-picture').click();
      else exec(cmd);
    });
    $c('cmp-fontsize').addEventListener('change', (e) => { exec('fontSize', e.target.value); });
    $c('cmp-color').addEventListener('input', (e) => { exec('foreColor', e.target.value); });

    // Drop files anywhere on the window to attach them.
    ['dragenter', 'dragover'].forEach((ev) => $c('cmp-window').addEventListener(ev, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $c('cmp-window').classList.add('dragging'); } }));
    ['dragleave', 'drop'].forEach((ev) => $c('cmp-window').addEventListener(ev, (e) => { if (ev === 'dragleave' && e.relatedTarget && $c('cmp-window').contains(e.relatedTarget)) return; $c('cmp-window').classList.remove('dragging'); }));
    $c('cmp-window').addEventListener('drop', (e) => {
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); requestClose(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendNow(); }
    });
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && !isPhone()) { /* clicking the dimmed backdrop does nothing: too easy to lose a draft */ } });
  }

  function showExtra(which) {
    $c(`cmp-${which}-row`).hidden = false;
    $c(`cmp-show-${which}`).hidden = true;
    $c(`cmp-${which}-input`).focus();
  }

  function resetForm() {
    c.recoveryId = crypto.randomUUID(); c.sendAttempt = crypto.randomUUID(); c.sendUncertain = false; revision = 0;
    Object.values(c.fields).forEach((f) => { f.items = []; f.input.value = ''; f.render(); f.hideSuggest(); });
    ['cc', 'bcc'].forEach((w) => { $c(`cmp-${w}-row`).hidden = true; $c(`cmp-show-${w}`).hidden = false; });
    $c('cmp-subject').value = '';
    c.attachments = [];
    c.forwarded = [];
    c.prep = null;
    c.dirty = false;
    c.draft = null;
    c.keep = null;
    clearTimeout(c.saveTimer);
    c.savePromise = null;
    $c('cmp-status').textContent = '';
    showError('');
    renderAttachments();
    setSending(false);
  }

  // ------------------------------------------------------------------ opening

  function quoteHtml(prep, mode) {
    const when = prep.date ? new Date(prep.date).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const person = (p) => (p ? (p.name ? `${esc(p.name)} &lt;${esc(p.address)}&gt;` : esc(p.address)) : '');
    const list = (people) => (people || []).map(person).join('; ');
    const quoted = `<blockquote style="margin:6px 0 0;padding-left:12px;border-left:3px solid #cfd6e4;color:#444">${prep.quoteHtml || ''}</blockquote>`;
    if (mode === 'forward') {
      const rows = [['From', person(prep.from)], ['Sent', esc(when)], ['To', list(prep.originalTo)], ['Cc', list(prep.originalCc)], ['Subject', esc(prep.originalSubject)]].filter(([, v]) => v);
      return `<div><br></div><div style="border-top:1px solid #cfd6e4;margin-top:14px;padding-top:8px;color:#555">${rows.map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`).join('')}</div><div><br></div>${quoted}`;
    }
    return `<div><br></div><div style="color:#555;margin-top:12px">On ${esc(when)}, ${person(prep.from) || 'someone'} wrote:</div>${quoted}`;
  }

  const TITLES = { new: 'New message', reply: 'Reply', replyall: 'Reply all', forward: 'Forward', draft: 'Draft' };

  async function open(options = {}) {
    build();
    if (c.sending) {
      toast('Still sending your previous message — one moment', 'error');
      return;
    }
    if (!$c('compose-overlay').hidden) {
      toast('Finish or discard the message you are writing first', 'error');
      return;
    }
    const token = ++openToken;
    const mode = options.mode || 'new';
    resetForm();
    c.mode = mode;
    c.folder = options.folder || null;
    c.uid = options.uid || null;
    $c('cmp-title').textContent = TITLES[mode] || 'New message';
    $c('cmp-from').textContent = user.name ? `${user.name} <${user.email}>` : user.email;
    $c('compose-overlay').hidden = false;
    document.documentElement.classList.add('cmp-open');
    trapBack();

    let bodyHtml = '<div><br></div>';
    if (mode === 'draft') {
      // Carry on editing a saved draft: recipients, subject, body and attachments all come back.
      setBusy(true, 'Loading…');
      try {
        const d = await mailFetch(`/api/mail/messages/${c.uid}/draft?folder=${encodeURIComponent(c.folder)}`);
        if (token !== openToken) return;
        c.draft = { folder: c.folder, uid: c.uid };
        c.mode = d.mode;
        c.folder = d.sourceFolder;
        c.uid = d.sourceUid;
        c.prep = { inReplyTo: d.inReplyTo, references: d.references };
        $c('cmp-title').textContent = d.mode === 'new' ? 'Draft' : (TITLES[d.mode] || 'Draft');
        c.fields.to.set(d.to);
        if (d.cc.length) { showExtra('cc'); c.fields.cc.set(d.cc); }
        if (d.bcc.length) { showExtra('bcc'); c.fields.bcc.set(d.bcc); }
        $c('cmp-subject').value = d.subject;
        c.keep = { folder: c.draft.folder, uid: c.draft.uid };
        c.forwarded = d.attachments.map((a) => ({ index: a.index, filename: a.filename, size: a.size }));
        renderAttachments();
        bodyHtml = d.html || '<div><br></div>';
      } catch (err) {
        if (token !== openToken) return;
        closeNow();
        if (err instanceof MailAuthRequired) showConnect();
        else toast(err.message || "Couldn't open this draft", 'error');
        return;
      }
    } else if (mode === 'new') {
      c.fields.to.set(options.to || []);
      (options.cc || []).length && (showExtra('cc'), c.fields.cc.set(options.cc));
      $c('cmp-subject').value = options.subject || '';
      if (options.bodyHtml) bodyHtml = options.bodyHtml;
      c.attachments = (options.files || []).map(file=>({file,size:file.size}));
    } else {
      setBusy(true, 'Loading…');
      try {
        const prep = await mailFetch(`/api/mail/messages/${c.uid}/compose?folder=${encodeURIComponent(c.folder)}&mode=${mode}`);
        if (token !== openToken) return;
        c.prep = prep;
        c.fields.to.set(prep.to);
        if (prep.cc && prep.cc.length) { showExtra('cc'); c.fields.cc.set(prep.cc); }
        $c('cmp-subject').value = prep.subject;
        c.forwarded = (prep.attachments || []).map((a) => ({ index: a.index, filename: a.filename, size: a.size }));
        if (mode === 'forward') c.keep = { folder: c.folder, uid: c.uid };
        renderAttachments();
        bodyHtml = quoteHtml(prep, mode);
      } catch (err) {
        if (token !== openToken) return;
        closeNow();
        if (err instanceof MailAuthRequired) showConnect();
        else toast(err.message || "Couldn't prepare the message", 'error');
        return;
      }
    }

    // Their signature goes just below the cursor, above any quoted history.
    if (mode !== 'draft' && !options.skipSignature) {
      const settings = await getMailSettings();
      if (token !== openToken) return;
      const wanted = mode === 'new' ? settings.useOnNew : settings.useOnReply;
      if (settings.signatureHtml && wanted) {
        const signature = `<div class="eg-signature">${settings.signatureHtml}</div>`;
        bodyHtml = bodyHtml.includes('<div><br></div>') ? bodyHtml.replace('<div><br></div>', `<div><br></div>${signature}`) : `${signature}${bodyHtml}`;
      }
    }

    await loadEditor(bodyHtml);
    if (token !== openToken) return;
    setBusy(false);
    c.dirty = false;
    renderAttachments();
    // New / forward start at the recipient; replies start in the body, ready to type.
    if (mode === 'new' || mode === 'forward' || (mode === 'draft' && !c.fields.to.items.length)) c.fields.to.input.focus();
    else focusEditorStart();
    updateToolbarState();
    if (options.files?.length || options.bodyHtml) markDirty();
  }

  // ------------------------------------------------------------------ closing / sending

  // The browser's (or phone's) Back button must not drop a message being written. While the writing window is
  // open there is one extra history entry just above the page's own; Back lands on the page's entry, the entry is put
  // back, and the "Discard this message?" question is asked instead of leaving.
  let backTrapped = false, backReleasing = false;
  function trapBack() {
    if (backTrapped) return;
    backTrapped = true;
    history.pushState({ cmp: 1 }, '', location.href);
  }
  function releaseBack() {
    if (!backTrapped) return;
    backTrapped = false;
    if (history.state && history.state.cmp) { backReleasing = true; history.back(); }
  }
  window.addEventListener('popstate', () => {
    if (backReleasing) { backReleasing = false; return; }
    if (!backTrapped || !window.composeIsOpen || !window.composeIsOpen()) return;
    history.pushState({ cmp: 1 }, '', location.href);
    discardDraft();
  });

  function closeNow() {
    openToken += 1;
    releaseBack();
    $c('compose-overlay').hidden = true;
    document.documentElement.classList.remove('cmp-open');
    c.editorDoc = null;
    $c('cmp-editor').removeAttribute('srcdoc');
    resetForm();
  }

  // After a draft is saved or removed, whatever is listing Drafts should notice.
  function draftsChanged() {
    clearThreadCache();
    loadFolders().catch(() => {});
    const current = typeof currentFolder === 'function' ? currentFolder() : null;
    if (current && current.role === 'drafts') softRefresh(true);
  }

  // Closing keeps the work as a draft (like most mail apps) — the trash button is how you discard.
  let asking = false;
  async function requestClose() {
    if (c.sending || asking) return;
    asking = true; // Escape + a click must not stack two prompts
    try {
      if (c.dirty && hasContent()) {
        try {
          await saveDraft();
          toast('Draft saved', 'success');
          draftsChanged();
        } catch (err) {
          try { await preserveRecovery(); } catch { showError('Neither mailbox nor local recovery could be saved. Keep this window open.'); return; }
          const ok = await askDialog({ title: 'Draft kept on this browser', message: 'The mailbox save failed. You can restore this message from Recovered drafts after reconnecting.', confirmText: 'Close', cancelText: 'Keep editing' });
          if (!ok) return;
        }
      }
      closeNow();
    } finally {
      asking = false;
    }
  }

  async function discardDraft() {
    if (c.sending || asking) return;
    if (hasContent() || c.draft) {
      asking = true;
      const ok = await askDialog({ title: 'Discard this message?', message: c.draft ? 'The draft will be deleted.' : 'What you have written will be lost.', confirmText: 'Discard', cancelText: 'Keep editing', danger: true });
      asking = false;
      if (!ok) return;
    }
    clearTimeout(c.saveTimer);
    if (c.savePromise) await c.savePromise.catch(() => {});
    const draft = c.draft;
    await removeRecovery().catch(()=>{});
    closeNow();
    if (draft) {
      try {
        await mailFetch(`/api/mail/messages/${draft.uid}/draft?folder=${encodeURIComponent(draft.folder)}`, { method: 'DELETE' });
        draftsChanged();
        toast('Draft discarded');
      } catch (err) {
        toast(err.message || "The draft couldn't be deleted", 'error');
      }
    }
  }

  async function sendNow() {
    if (c.sending || c.busy) return;
    showError('');
    Object.values(c.fields).forEach((f) => f.commit());

    if (c.fields.to.hasInvalid() || c.fields.cc.hasInvalid() || c.fields.bcc.hasInvalid()) {
      return showError('Some addresses are not valid (shown in red). Fix or remove them first.');
    }
    const to = c.fields.to.values();
    const cc = c.fields.cc.values();
    const bcc = c.fields.bcc.values();
    if (!to.length && !cc.length && !bcc.length) {
      showError('Add at least one recipient.');
      return c.fields.to.input.focus();
    }
    if (to.length + cc.length + bcc.length > 50) return showError('A message can have at most 50 recipients.');
    if (totalBytes() > MAX_TOTAL_BYTES) return showError('Attachments are over the 20 MB limit.');

    const subject = $c('cmp-subject').value.trim();
    if (!subject) {
      const ok = await askDialog({ title: 'Send without a subject?', message: 'This message has no subject line.', confirmText: 'Send anyway', cancelText: 'Go back' });
      if (!ok) return $c('cmp-subject').focus();
    } else if (editorIsEmpty() && !c.attachments.length && !c.forwarded.length) {
      const ok = await askDialog({ title: 'Send an empty message?', message: 'The message body is empty.', confirmText: 'Send anyway', cancelText: 'Go back' });
      if (!ok) return;
    }

    if (c.sendUncertain) {
      const checked = await askDialog({title:'Check before sending again',message:'The previous delivery is uncertain. Check Sent and with the recipient first. Only start a new attempt if you are sure another copy is needed.',confirmText:'I checked — send a new copy',cancelText:'Keep draft'});
      if (!checked) return;
      c.sendAttempt=crypto.randomUUID(); c.sendUncertain=false;
    }
    // An autosave still in flight must land first, so the draft to clean up is the right one.
    clearTimeout(c.saveTimer);
    setSending(true);
    if (c.savePromise) await c.savePromise.catch(() => {});
    await preserveRecovery().catch(()=>{});
    const form = buildForm({ forSend: true });

    // The window steps aside while the message goes out; the conversation shows it greyed out
    // ("Sending…") until the server has it. If sending fails the window comes back, nothing lost.
    const wasReply = c.mode === 'reply' || c.mode === 'replyall';
    const folder = c.folder;
    const uid = c.uid;
    const pending = {
      _pending: true,
      uid: -Date.now(),
      folder: '__pending__',
      subject,
      from: { name: user.name || '', address: user.email },
      fromSelf: true,
      to: to.map((a) => (typeof a === 'string' ? { address: a } : a)),
      cc: [], bcc: [], replyTo: [], attachments: [],
      date: new Date().toISOString(),
      received: new Date().toISOString(),
      html: editorBodyHtml(),
      snippet: 'Sending…',
      seen: true,
      threadIds: [],
    };
    if (typeof window.mailPendingAdd === 'function') window.mailPendingAdd(pending, wasReply ? { folder, uid } : null);
    $c('compose-overlay').hidden = true;
    document.documentElement.classList.remove('cmp-open');

    // A short, cancellable pause before the message really leaves (see undo-send.js).
    if (window.UndoSend && !(await window.UndoSend.wait())) {
      if (typeof window.mailPendingDone === 'function') window.mailPendingDone(pending);
      $c('compose-overlay').hidden = false;
      document.documentElement.classList.add('cmp-open');
      trapBack();
      setSending(false);
      $c('cmp-status').textContent = 'Sending cancelled — your message is back in the editor';
      toast('Sending cancelled — your message is back in the editor');
      return;
    }

    try {
      const result = await mailFetch('/api/mail/send', { method: 'POST', body: form });
      await removeRecovery().catch(()=>{});
      closeNow();
      if(result.rejected?.length) toast('Sent to accepted recipients. Rejected: '+result.rejected.join(', '),'error');
      toast(result.savedToSent === false ? 'Message sent (a copy could not be saved to Sent)' : 'Message sent', 'success');
      if (wasReply && typeof window.markMessageAnswered === 'function') window.markMessageAnswered(folder, uid);
      if (wasReply) clearThreadCache([{ folder, uid }]);
      loadFolders().catch(() => {});
      // The greyed-out copy stays until the real one has been fetched, so there is no gap.
      await Promise.all([softRefresh(true), wasReply && typeof refreshThread === 'function' ? refreshThread() : null].map((p) => Promise.resolve(p).catch(() => {})));
      if (typeof window.mailPendingDone === 'function') window.mailPendingDone(pending);
    } catch (err) {
      if (typeof window.mailPendingDone === 'function') window.mailPendingDone(pending);
      $c('compose-overlay').hidden = false;
      document.documentElement.classList.add('cmp-open');
      trapBack();
      setSending(false);
      c.sendUncertain = !err.code || ['SEND_UNKNOWN','MAIL_CONNECT'].includes(err.code);
      await preserveRecovery().catch(()=>{});
      if (err instanceof MailAuthRequired) showError('Your mailbox session has expired. Open Mail again and unlock your mailbox, then send once more — your message is still here.');
      else showError(err.message || 'The message could not be sent.');
    }
  }

  // The person's signature settings, fetched once and kept (the settings dialog refreshes it).
  let settingsPromise = null;
  function getMailSettings() {
    if (!settingsPromise) {
      settingsPromise = mailFetch('/api/mail/settings').catch(() => ({ signatureHtml: '', useOnNew: true, useOnReply: true }));
    }
    return settingsPromise;
  }
  window.mailSettingsChanged = (fresh) => { settingsPromise = Promise.resolve(fresh); };
  window.getMailSettings = getMailSettings;

  // Shared with the signature editor so both behave identically.
  window.MailEditorKit = { editorDocument, cleanPastedHtml };

  // Leaving the page with unsaved writing in the window: let the browser ask first.
  window.addEventListener('beforeunload', (e) => {
    if (built && (c.sending || (!$c('compose-overlay').hidden && c.dirty && hasContent()))) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.restoreRecoveredDraft = async record => {
    if (window.composeIsOpen?.()) { toast('Close the current message first.'); return; }
    await open({mode:'new',subject:record.subject,bodyHtml:record.html,files:record.files || [],skipSignature:true});
    c.recoveryId=record.id; c.sendAttempt=record.sendAttempt || crypto.randomUUID(); c.sendUncertain=record.sendUncertain;
    c.mode=record.mode; c.folder=record.folder; c.uid=record.uid; c.prep=record.prep; c.draft=record.draft; c.keep=record.keep; c.forwarded=record.forwarded || [];
    for(const [key,value] of Object.entries(record.fields)){ if(key!=='to' && (value.items.length || value.input))showExtra(key);c.fields[key].set(value.items);c.fields[key].input.value=value.input || ''; }
    c.dirty=true; renderAttachments();
    $c('cmp-status').textContent=record.sendUncertain?'Recovered — previous delivery uncertain. Check Sent before resending.':'Recovered from this browser';
    await preserveRecovery().catch(()=>{});
  };
  window.openCompose = open;
  window.composeIsOpen = () => built && !$c('compose-overlay').hidden;
})();

