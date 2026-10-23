// IMAP access to the logged-in user's cPanel mailbox (see mail-session.js for how the credential
// reaches us). Everything the Mail page needs lives here: folders, message lists, search, reading
// a message (with its HTML made safe), attachments, and read/star flags.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');

class MailAuthError extends Error {
  constructor(message) {
    super(message || 'The mailbox rejected this password');
    this.code = 'MAIL_AUTH';
  }
}
class MailConnectError extends Error {
  constructor(message) {
    super(message || 'Could not reach the mail server');
    this.code = 'MAIL_CONNECT';
  }
}
class MailNotFoundError extends Error {
  constructor(message) {
    super(message || 'Not found');
    this.code = 'MAIL_NOT_FOUND';
  }
}

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
// Conversation views read at most this much of each message; the full text loads when a card is opened.
const PARTIAL_BYTES = 256 * 1024;
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

function domainOf(address) {
  return String(address || '').split('@')[1] || '';
}

// Where to connect. Normally the MAIL_IMAP_HOST setting. Without it we fall back to the
// company's bare mail domain (cPanel hosts answer IMAP there with the domain's own certificate;
// a mail.<domain> name often doesn't exist in DNS) — but only for the company's own domain,
// taken from the SMTP account the app already sends from, because the user's password is sent to
// this host. An account whose email is on some other domain must never cause us to hand its
// password to that domain's server.
function mailHost() { return process.env.MAIL_IMAP_HOST || 'imap.stud.tu-darmstadt.de'; }

function imapOptions(creds) {
  const host = creds.imapHost || mailHost(creds.email);
  const tls = { rejectUnauthorized: true };
  if (process.env.MAIL_IMAP_SERVERNAME) tls.servername = process.env.MAIL_IMAP_SERVERNAME;
  return {
    host,
    port: Number(process.env.MAIL_IMAP_PORT) || 993,
    secure: process.env.MAIL_IMAP_SECURE !== 'false',
    auth: { user: creds.imapUsername || creds.username || creds.email, pass: creds.password },
    logger: false,
    // We open a connection per burst of activity and close it after a minute idle — holding an
    // IDLE session open per user isn't reliable on shared hosting, and the page polls instead.
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 90000,
    tls,
  };
}

function normalizeError(err, creds) {
  if (!err) return err;
  if (err instanceof MailAuthError || err instanceof MailConnectError || err instanceof MailNotFoundError) return err;
  if (err.authenticationFailed) return new MailAuthError();
  if (err.serverResponseCode === 'NONEXISTENT' || err.mailboxMissing) return new MailNotFoundError('Folder not found');
  const text = `${err.code || ''} ${err.message || ''}`;
  if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ETIMEOUT|EHOSTUNREACH|NoConnection|certificate|altname|self.signed|greeting|socket/i.test(text)) {
    let host = 'the mail server';
    try {
      if (creds) host = mailHost(creds.email);
    } catch (e) {
      // keep the generic wording
    }
    return new MailConnectError(`Could not reach ${host}: ${err.message}`);
  }
  return err;
}

// ---- connection pool: one live connection per mailbox, reused across requests ----------------

const pool = new Map();

function disposeEntry(key) {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  clearTimeout(entry.timer);
  entry.ready
    .then((client) => client.logout().catch(() => client.close()))
    .catch(() => {});
}

function acquire(creds) {
  const key = [creds.email.toLowerCase(), creds.imapHost || mailHost(creds.email), creds.imapUsername || creds.username || creds.email].join('|');
  let entry = pool.get(key);
  if (entry && entry.password !== creds.password) {
    disposeEntry(key);
    entry = null;
  }
  if (!entry) {
    const client = new ImapFlow(imapOptions(creds));
    entry = { client, password: creds.password, timer: null, inFlight: 0 };
    // An unhandled 'error' event would crash the process; the failing command already rejects.
    client.on('error', () => {
      if (pool.get(key) === entry) disposeEntry(key);
    });
    client.on('close', () => {
      if (pool.get(key) === entry) {
        pool.delete(key);
        clearTimeout(entry.timer);
      }
    });
    entry.ready = client.connect().then(() => client);
    entry.ready.catch(() => {
      if (pool.get(key) === entry) pool.delete(key);
    });
    pool.set(key, entry);
  }
  return { key, entry };
}

async function withClient(creds, fn) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { key, entry } = acquire(creds);
    clearTimeout(entry.timer);
    entry.inFlight += 1;
    try {
      const client = await entry.ready;
      if (!client.usable) {
        disposeEntry(key);
        continue;
      }
      return await fn(client);
    } catch (err) {
      lastError = err;
      const normalized = normalizeError(err, creds);
      // A dead socket mid-command is worth exactly one retry on a fresh connection.
      if (attempt === 0 && /^(?:NOOP|SELECT|EXAMINE|FETCH|UID FETCH|LIST|STATUS|SEARCH)$/i.test(String(err.command || '')) && !(normalized instanceof MailAuthError) && /ECONNRESET|socket|closed|NoConnection/i.test(`${err.code} ${err.message}`) && !(normalized instanceof MailNotFoundError)) {
        disposeEntry(key);
        continue;
      }
      if (normalized instanceof MailAuthError || normalized instanceof MailConnectError) disposeEntry(key);
      throw normalized;
    } finally {
      entry.inFlight -= 1;
      if (pool.get(key) === entry && entry.inFlight === 0) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => disposeEntry(key), IDLE_CLOSE_MS);
        if (entry.timer.unref) entry.timer.unref();
      }
    }
  }
  throw normalizeError(lastError, creds) || new MailConnectError();
}

async function verifyCredentials(creds) {
  await withClient(creds, async (client) => client.noop());
}

function forget(email) {
  for (const key of pool.keys()) if (key.startsWith(String(email).toLowerCase() + '|')) disposeEntry(key);
}

// ---- folders -----------------------------------------------------------------------------------

const ROLE_BY_SPECIAL_USE = {
  '\\inbox': 'inbox',
  '\\drafts': 'drafts',
  '\\sent': 'sent',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
};
const ROLE_BY_NAME = [
  [/^inbox$/i, 'inbox'],
  [/^drafts?$/i, 'drafts'],
  [/^sent( items| mail| messages)?$/i, 'sent'],
  [/^(trash|deleted( items| messages)?|bin)$/i, 'trash'],
  [/^(junk|spam)( e-?mail)?$/i, 'junk'],
  [/^archives?$/i, 'archive'],
];
const ROLE_LABEL = {
  inbox: 'Inbox',
  drafts: 'Drafts',
  sent: 'Sent Items',
  trash: 'Deleted Items',
  junk: 'Junk Email',
  archive: 'Archive',
};
const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

function folderRole(folder) {
  if (folder.path.toUpperCase() === 'INBOX') return 'inbox';
  const special = ROLE_BY_SPECIAL_USE[String(folder.specialUse || '').toLowerCase()];
  if (special) return special;
  for (const [pattern, role] of ROLE_BY_NAME) {
    if (pattern.test(folder.name)) return role;
  }
  return 'other';
}

async function listFolders(creds) {
  return withClient(creds, async (client) => {
    const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
    const mapped = folders
      .filter((f) => !f.flags.has('\\NonExistent'))
      .map((f) => {
        const role = folderRole(f);
        const parts = f.path.split(f.delimiter || '/');
        // cPanel/Dovecot keeps everything under an "INBOX." prefix (INBOX.Sent, INBOX.Projects.Alpha).
        // That prefix is just a namespace, not a real parent folder to indent under.
        const depth = parts.length > 1 && parts[0].toUpperCase() === 'INBOX' ? parts.length - 2 : parts.length - 1;
        return {
          path: f.path,
          name: ROLE_LABEL[role] || f.name,
          role,
          selectable: !f.flags.has('\\Noselect'),
          depth,
          unseen: f.status ? f.status.unseen || 0 : 0,
          total: f.status ? f.status.messages || 0 : 0,
        };
      });
    // INBOX always exists (RFC 3501), even if a server leaves it out of LIST.
    if (!mapped.some((f) => f.role === 'inbox')) {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      mapped.push({ path: 'INBOX', name: ROLE_LABEL.inbox, role: 'inbox', selectable: true, depth: 0, unseen: status.unseen || 0, total: status.messages || 0 });
    }
    mapped.sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role);
      const bi = ROLE_ORDER.indexOf(b.role);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.path.localeCompare(b.path);
    });
    return mapped;
  });
}

// Powers the nav badge. `fresh` is how many still-unread messages arrived at or after `since`
// (a UID the page remembers from the last time the person looked at Mail) — so the badge counts
// new mail, and resets when they open Mail rather than when they read each message.
// since: the badge baseline (count unread mail from this uid on). after: the newest uid the person
// has already been notified about — unread mail beyond it is returned (up to 3, newest last) so the
// browser can announce who it is from (after < 0 means "don't look").
async function inboxCounts(creds, since, after = -1) {
  return withClient(creds, async (client) => {
    const status = await client.status('INBOX', { unseen: true, uidNext: true });
    const unseen = status.unseen || 0;
    const uidNext = status.uidNext || 0;
    let fresh = 0;
    let latest = [];
    const starts = [since > 0 ? since : null, after >= 0 ? after + 1 : null].filter((n) => n !== null);
    const from = starts.length ? Math.min(...starts) : Infinity;
    if (unseen > 0 && uidNext > from) {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        // "N:*" always includes the newest message even when it is older than N, so filter.
        const found = (await client.search({ seen: false, uid: `${from}:*` }, { uid: true })) || [];
        if (since > 0) fresh = found.filter((uid) => uid >= since).length;
        const wanted = found.filter((uid) => after >= 0 && uid > after).sort((a, b) => a - b).slice(-3);
        if (wanted.length) {
          for await (const m of client.fetch(wanted.join(','), { uid: true, envelope: true }, { uid: true })) {
            const env = m.envelope || {};
            const sender = (env.from || [])[0] || {};
            latest.push({ uid: m.uid, from: sender.name || sender.address || '', subject: env.subject || '' });
          }
          latest.sort((a, b) => a.uid - b.uid);
        }
      } finally {
        lock.release();
      }
    }
    return { unseen, uidNext, fresh, latest };
  });
}

// ---- message lists -----------------------------------------------------------------------------

function address(a) {
  return a ? { name: a.name || '', address: a.address || '' } : null;
}

// Pictures that belong to the message body (signature logos, pasted screenshots) don't count:
// they carry a Content-ID or sit inside multipart/related, even when a client labels them "attachment".
function hasAttachment(node, parentType = '') {
  if (!node) return false;
  const type = String(node.type || '').toLowerCase();
  if (node.childNodes && node.childNodes.length) return node.childNodes.some((child) => hasAttachment(child, type));
  if (type.startsWith('image/') && (node.id || parentType === 'multipart/related' || node.disposition === 'inline')) return false;
  if (node.disposition === 'attachment') return true;
  if (node.disposition === 'inline') return false;
  return type.startsWith('application/') && type !== 'application/pgp-signature' && type !== 'application/pkcs7-signature';
}

function summarize(m) {
  const env = m.envelope || {};
  const flags = m.flags || new Set();
  const date = env.date || m.internalDate;
  return {
    uid: m.uid,
    subject: env.subject || '',
    from: address((env.from || [])[0]),
    to: (env.to || []).map(address),
    date: date ? new Date(date).toISOString() : null,
    received: m.internalDate ? new Date(m.internalDate).toISOString() : null,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    hasAttachment: hasAttachment(m.bodyStructure),
    size: m.size || 0,
    // Message-ID links, so the list can fold one conversation into one row.
    threadIds: threadIdsOf(env, m.headers),
  };
}

function threadIdsOf(env, headers) {
  const ids = [];
  if (env.messageId) ids.push(env.messageId);
  if (env.inReplyTo) ids.push(env.inReplyTo);
  if (headers) {
    const text = Buffer.isBuffer(headers) ? headers.toString('latin1') : String(headers);
    const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
    const match = unfolded.match(/^references:\s*(.*)$/im);
    if (match) ids.push(...(match[1].match(/<[^<>\s]+>/g) || []));
  }
  return [...new Set(ids.map((i) => i.trim()))].slice(0, 12);
}

async function listFolderMessages(creds, { folder, page = 1, pageSize = 40, q = '', scope = 'headers', unreadOnly = false }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      let total;
      let range;
      let byUid = false;

      if (q || unreadOnly) {
        const query = {};
        if (unreadOnly) query.seen = false;
        if (q) {
          const terms = [{ from: q }, { to: q }, { subject: q }];
          if (scope === 'all') terms.push({ body: q });
          query.or = terms;
        }
        const found = (await client.search(query, { uid: true })) || [];
        const uids = found.slice().sort((a, b) => b - a);
        total = uids.length;
        range = uids.slice((page - 1) * pageSize, page * pageSize);
        byUid = true;
        if (!range.length) return { total, page, pageSize, messages: [] };
      } else {
        total = client.mailbox.exists;
        const end = total - (page - 1) * pageSize;
        if (end < 1) return { total, page, pageSize, messages: [] };
        range = `${Math.max(1, end - pageSize + 1)}:${end}`;
      }

      const messages = [];
      for await (const m of client.fetch(
        range,
        { uid: true, flags: true, envelope: true, bodyStructure: true, size: true, internalDate: true, headers: ['references'] },
        { uid: byUid }
      )) {
        messages.push(summarize(m));
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { total, page, pageSize, messages };
    } finally {
      lock.release();
    }
  });
}

// The list for a folder. For the Inbox and Sent we also send the recent headers of the other one, so
// a chain's row can show its newest message even when that's your reply (or their answer).
async function listMessages(creds, options) {
  const result = await listFolderMessages(creds, options);
  if (options.q || options.unreadOnly || (options.page || 1) !== 1) return result;
  try {
    const related = await withClient(creds, async (client) => {
      const all = await cachedFolderList(creds, client);
      const here = all.find((f) => f.path === options.folder);
      const mine = here ? folderRole(here) : '';
      let other = null;
      if (mine === 'inbox') other = all.find((f) => folderRole(f) === 'sent');
      else if (mine === 'sent') other = all.find((f) => f.path === 'INBOX');
      if (!other) return [];
      const lock = await client.getMailboxLock(other.path, { readOnly: true });
      try {
        const total = client.mailbox.exists;
        if (!total) return [];
        const out = [];
        for await (const m of client.fetch(`${Math.max(1, total - RELATED_COUNT + 1)}:${total}`, { uid: true, flags: true, envelope: true, internalDate: true, headers: ['references'] })) {
          out.push({ ...summarize(m), folder: other.path });
        }
        return out;
      } finally {
        lock.release();
      }
    });
    warmIndexes(creds); // so the first conversation you open is quick
    return { ...result, related };
  } catch (err) {
    return result; // the chain rows just fall back to this folder's own messages
  }
}
const RELATED_COUNT = 150;

// ---- previews (the grey one-liner under each subject) -----------------------------------------
//
// Fetched separately and lazily so the list itself appears immediately: for each message we read
// just the first few hundred bytes of its text part, never the whole message.

function pickPreviewPart(node) {
  let plain = null;
  let html = null;
  (function walk(n) {
    if (!n) return;
    if (n.childNodes && n.childNodes.length) {
      n.childNodes.forEach(walk);
      return;
    }
    if (n.disposition === 'attachment') return;
    const type = String(n.type || '').toLowerCase();
    if (type === 'text/plain' && !plain) plain = n;
    else if (type === 'text/html' && !html) html = n;
  })(node);
  return plain || html;
}

function decodeQuotedPrintable(str) {
  const joined = str.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = Buffer.from(ch, 'utf8');
      for (const b of code) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

function decodePart(buffer, node) {
  const encoding = String(node.encoding || '').toLowerCase();
  let bytes = buffer;
  if (encoding === 'base64') bytes = Buffer.from(buffer.toString('ascii').replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  else if (encoding === 'quoted-printable') bytes = decodeQuotedPrintable(buffer.toString('latin1'));
  const charset = String((node.parameters && node.parameters.charset) || 'utf-8').toLowerCase();
  try {
    const iconv = require('iconv-lite');
    if (iconv.encodingExists(charset)) return iconv.decode(bytes, charset);
  } catch (err) {
    // fall through to utf8
  }
  return bytes.toString('utf8');
}

// Soft hyphen, combining grapheme joiner, zero-width / bidi marks, line+paragraph separators,
// word joiners, Braille blank, Hangul fillers, variation selectors, BOM. Built from code points
// (not typed in) so no invisible character ever has to live in this source file.
const INVISIBLE_CHARS = new RegExp(
  `[${[0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x2800, 0x3164, 0xfeff]
    .map((c) => `\\u${c.toString(16).padStart(4, '0')}`)
    .join('')}\\u200b-\\u200f\\u2028-\\u202f\\u205f-\\u206f\\ufe00-\\ufe0f]`,
  'g'
);

function previewText(text, isHtml) {
  let out = text;
  if (isHtml) {
    out = out
      .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
      .replace(/<(style|script|head|title)[\s\S]*?(<\/\1>|$)/gi, ' ')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
      .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
      .replace(/&[a-z]+;/gi, ' ');
  }
  out = out
    // Marketing mail pads its hidden preview text with invisible characters.
    .replace(INVISIBLE_CHARS, " ")
    .replace(/-->|<!--|\]>|<!\[endif\]/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > 140 ? `${out.slice(0, 140)}…` : out;
}

async function previews(creds, { folder, uids }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const wanted = uids.slice(0, 100);
      const chosen = new Map();
      for await (const m of client.fetch(wanted, { uid: true, bodyStructure: true }, { uid: true })) {
        const node = pickPreviewPart(m.bodyStructure);
        if (node) chosen.set(m.uid, { node, key: node.part || '1' });
      }

      const byKey = new Map();
      chosen.forEach((value, uid) => {
        if (!byKey.has(value.key)) byKey.set(value.key, []);
        byKey.get(value.key).push(uid);
      });

      const result = {};
      for (const [key, groupUids] of byKey) {
        const html = chosen.get(groupUids[0]).node.type === 'text/html';
        const maxLength = html ? 14000 : 900;
        for await (const m of client.fetch(groupUids, { uid: true, bodyParts: [{ key, start: 0, maxLength }] }, { uid: true })) {
          const buf = m.bodyParts && m.bodyParts.get(key);
          if (!buf) continue;
          const info = chosen.get(m.uid);
          result[m.uid] = previewText(decodePart(buf, info.node), String(info.node.type).toLowerCase() === 'text/html');
        }
      }
      return result;
    } finally {
      lock.release();
    }
  });
}

// ---- reading a message ----------------------------------------------------------------------

const ALLOWED_TAGS = [
  'a', 'abbr', 'acronym', 'address', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'dfn', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong',
  'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var',
];
const COMMON_ATTRS = [
  'style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'lang', 'title', 'border',
  'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'nowrap', 'face', 'size', 'start', 'type', 'span',
];

function scrubCss(css) {
  return String(css)
    .replace(/@import[^;{}]*;?/gi, '')
    .replace(/url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, 'none')
    .replace(/expression\s*\((?:[^()]|\([^()]*\))*\)/gi, 'none')
    .replace(/(behavior|-moz-binding)\s*:[^;}]*/gi, '');
}

// Makes an email's HTML safe to show. The result is a fragment, rendered by the page inside a
// sandboxed iframe with its own CSP — this is the first of three layers, not the only one.
//   - scripts, iframes, forms, objects, link/meta/base tags are removed outright
//   - links get target=_blank + rel=noopener, only http/https/mailto/tel are kept
//   - remote images are parked in data-blocked-src until the reader asks to load them
//   - any CSS that could fetch something (url(), @import) is neutralised
function sanitizeEmailHtml(html) {
  let remoteImages = 0;
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      // `id` is kept for reading only: Outlook marks where its quoted history starts with
      // id="divRplyFwdMsg", which the reading pane uses to fold it. (The frame is sandboxed, so an
      // id can't reach the app's own page.)
      '*': [...COMMON_ATTRS, 'id'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style', 'class', 'align', 'border', 'data-blocked-src'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    allowVulnerableTags: true,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title'],
    transformTags: {
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if (next.style) next.style = scrubCss(next.style);
        if (tagName === 'a') {
          next.target = '_blank';
          next.rel = 'noopener noreferrer';
        }
        if (tagName === 'img' && next.src) {
          if (/^https?:\/\//i.test(next.src)) {
            next['data-blocked-src'] = next.src;
            delete next.src;
            remoteImages += 1;
          } else if (!/^(cid:|data:image\/)/i.test(next.src)) {
            // Relative or odd-scheme URLs would resolve against our own origin from inside the frame.
            delete next.src;
          }
        }
        return { tagName, attribs: next };
      },
    },
  });
  // <style> bodies are raw text to the sanitizer (it can't parse CSS), so neutralise url()/@import
  // here, on the finished output.
  const scrubbed = clean.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, body, close) => `${open}${scrubCss(body)}${close}`);
  return { html: scrubbed, remoteImages };
}

function flatAddresses(field) {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((entry) => (entry.value || []).map(address)).filter(Boolean);
}

function toIso(date) {
  return date ? new Date(date).toISOString() : null;
}

// A picture that is part of the message body (sent as multipart/related, or marked inline) rather
// than a file somebody attached. The parser has often already swapped its cid: link for the
// picture itself by the time we look, so the flags — not a search of the HTML — are the truth.
function isInlineImage(a, html) {
  if (!a.cid) return false;
  // Outlook/Apple Mail sometimes label body pictures "attachment" but still give them a Content-ID.
  if (String(a.contentType || '').toLowerCase().startsWith('image/') && a.related !== false) return true;
  if (a.related || String(a.contentDisposition || '').toLowerCase() === 'inline') return true;
  return Boolean(html && html.includes(`cid:${a.cid}`));
}

function describeAttachments(parsed, html) {
  return parsed.attachments.map((a, index) => ({
    index,
    filename: a.filename || `attachment-${index + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size || (a.content ? a.content.length : 0),
    inline: isInlineImage(a, html),
  }));
}

async function fetchSource(client, uid) {
  const meta = await client.fetchOne(String(uid), { uid: true, flags: true, size: true }, { uid: true });
  if (!meta) throw new MailNotFoundError('Message not found');
  if (meta.size > MAX_MESSAGE_BYTES) {
    const err = new Error('This message is too large to open here. Use webmail for it.');
    err.status = 413;
    throw err;
  }
  const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!full || !full.source) throw new MailNotFoundError('Message not found');
  return { source: full.source, flags: meta.flags || new Set() };
}

async function readMessage(creds, { folder, uid, markRead = true }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const uv = String(client.mailbox.uidValidity);
      const key = cacheKey(creds, folder, uv, uid);
      let cached = cacheGet(key);
      if (cached && cached.partial) cached = null; // the conversation view only read the start of it
      let display;
      let flags;
      if (cached) {
        const meta = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
        if (!meta) throw new MailNotFoundError('Message not found');
        flags = meta.flags || new Set();
        display = cached;
      } else {
        const fetched = await fetchSource(client, uid);
        flags = fetched.flags;
        const parsed = await simpleParser(fetched.source);
        display = buildDisplay(parsed, { folder, uid, flags: new Set(), seen: false, selfEmail: creds.email });
        display.partial = false;
        const meta = await client.fetchOne(String(uid), { uid: true, internalDate: true }, { uid: true });
        display.received = meta && meta.internalDate ? new Date(meta.internalDate).toISOString() : display.date;
        cachePut(key, display);
      }
      const wasSeen = flags.has('\\Seen');
      if (!wasSeen && markRead) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
      return withFlags(display, flags, wasSeen || markRead);
    } finally {
      lock.release();
    }
  });
}

// ---- plain-text mail: keep the new words, fold the quoted history -------------------------------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function linkifyEscaped(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (url) => `<a href="${url}">${url}</a>`);
}

const ATTRIBUTION = /^\s*(on\s.+wrote:|.+\swrote:|-{2,}\s*original message\s*-{2,}|-{2,}\s*forwarded message\s*-{2,}|_{5,}|from:\s.+)\s*$/i;

// Turns a text/plain body into HTML where each run of "> quoted" lines (with its "On ... wrote:"
// lead-in) becomes a <blockquote>, which the reading pane then folds behind a "•••" toggle.
function textToHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = (chunk) => {
    const trimmed = chunk.slice();
    while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
    return trimmed.length ? `<div>${trimmed.map((l) => linkifyEscaped(escapeHtml(l))).join('<br>')}</div>` : '';
  };
  let buffer = [];
  const flush = () => { out.push(para(buffer)); buffer = []; };

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*>/.test(line)) {
      // a lead-in line directly above the quote belongs to the quote
      let lead = '';
      if (buffer.length && ATTRIBUTION.test(buffer[buffer.length - 1])) lead = buffer.pop();
      flush();
      const quoted = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (lines[i].trim() === '' && i + 1 < lines.length && /^\s*>/.test(lines[i + 1])))) {
        quoted.push(lines[i].replace(/^\s*>+\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${lead ? `<div>${linkifyEscaped(escapeHtml(lead))}</div>` : ''}${para(quoted)}</blockquote>`);
      continue;
    }
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(line)) {
      flush();
      out.push(`<blockquote>${para(lines.slice(i))}</blockquote>`);
      i = lines.length;
      break;
    }
    buffer.push(line);
    i += 1;
  }
  flush();
  return out.join('');
}

// First words of the new content (quotes ignored) — shown on a collapsed conversation card.
function snippetOf(text) {
  const kept = String(text || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line));
  const joined = kept.join(' ');
  const cut = joined.search(/\s(on\s.{5,80}wrote:|-{2,}\s*original message)/i);
  const clean = (cut > 0 ? joined.slice(0, cut) : joined).replace(/\s+/g, ' ').trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

// Everything the reading pane shows for one message, from its parsed source.
function buildDisplay(parsed, { folder, uid, flags, seen, selfEmail }) {
  let html = null;
  let remoteImages = 0;
  const rawHtml = parsed.html || (parsed.text ? textToHtml(parsed.text) : '');
  if (rawHtml) {
    const result = sanitizeEmailHtml(rawHtml);
    html = result.html;
    remoteImages = result.remoteImages;
  }

  const attachments = describeAttachments(parsed, rawHtml);
  if (html) {
    let budget = 6 * 1024 * 1024;
    parsed.attachments.forEach((a) => {
      if (!a.cid || !a.content || a.content.length > MAX_INLINE_IMAGE_BYTES || budget < a.content.length) return;
      if (!html.includes(`cid:${a.cid}`)) return;
      budget -= a.content.length;
      const dataUri = `data:${a.contentType || 'application/octet-stream'};base64,${a.content.toString('base64')}`;
      html = html.split(`cid:${a.cid}`).join(dataUri);
    });
  }

  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const from = flatAddresses(parsed.from)[0] || null;
  return {
    uid: Number(uid),
    folder,
    subject: parsed.subject || '',
    from,
    fromSelf: Boolean(from && selfEmail && from.address.toLowerCase() === String(selfEmail).toLowerCase()),
    to: flatAddresses(parsed.to),
    cc: flatAddresses(parsed.cc),
    bcc: flatAddresses(parsed.bcc),
    replyTo: flatAddresses(parsed.replyTo),
    date: toIso(parsed.date),
    messageId: parsed.messageId || '',
    inReplyTo: parsed.inReplyTo || '',
    references,
    seen,
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    html,
    text: (parsed.text || '').slice(0, 200000),
    snippet: snippetOf(parsed.text || ''),
    remoteImages,
    attachments: attachments.filter((a) => !a.inline),
  };
}

// ---- conversations ------------------------------------------------------------------------------
//
// A conversation is every message linked by Message-ID / In-Reply-To / References — across the
// folders where related mail normally lives (the one being read, Inbox, Sent, Archive), so your
// own replies appear between the other person's.

const THREAD_MAX = 20;

function normalizeId(id) {
  return String(id || '').trim();
}

// ---- caches ---------------------------------------------------------------------------------------
//
// A message never changes once it has arrived, so its parsed, sanitized form is kept in memory
// (bounded) and only its flags are asked of the mail server again. Per folder we also keep a small
// index of Message-ID links, topped up with just the newest mail each time, so finding a
// conversation costs no searching on the mail server at all.

const MESSAGE_CACHE_CHARS = 60 * 1000 * 1000; // roughly 100 MB of text across everyone
const messageCache = new Map(); // key -> { display, chars } — insertion order doubles as recency
let messageCacheChars = 0;

function cacheKey(creds, folder, uidValidity, uid) {
  return `${String(creds.email).toLowerCase()}|${folder}|${uidValidity}|${uid}`;
}

function cacheGet(key) {
  const hit = messageCache.get(key);
  if (!hit) return null;
  messageCache.delete(key);
  messageCache.set(key, hit); // most recently used goes last
  return hit.display;
}

function cachePut(key, display) {
  const old = messageCache.get(key);
  if (old) { messageCacheChars -= old.chars; messageCache.delete(key); }
  const chars = (display.html ? display.html.length : 0) + (display.text ? display.text.length : 0) + 2000;
  messageCache.set(key, { display, chars });
  messageCacheChars += chars;
  while (messageCacheChars > MESSAGE_CACHE_CHARS && messageCache.size) {
    const oldest = messageCache.keys().next().value;
    messageCacheChars -= messageCache.get(oldest).chars;
    messageCache.delete(oldest);
  }
}

// What a message looks like regardless of who is looking at it right now (flags are added per call).
function withFlags(display, flags, seen) {
  return { ...display, flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered'), seen };
}

const INDEX_MAX = 3000; // newest messages per folder kept in the link index
const INDEX_FRESH_MS = 8000;
const headerIndex = new Map(); // `${email}|${folder}` -> { uv, items: Map(uid -> info), lastUid, syncedAt }

function headerInfo(m) {
  const env = m.envelope || {};
  let refs = [];
  if (m.headers) {
    const text = Buffer.isBuffer(m.headers) ? m.headers.toString('latin1') : String(m.headers);
    const match = text.replace(/\r?\n[ \t]+/g, ' ').match(/^references:\s*(.*)$/im);
    if (match) refs = (match[1].match(/<[^<>\s]+>/g) || []).map(normalizeId);
  }
  return {
    uid: m.uid,
    messageId: normalizeId(env.messageId),
    inReplyTo: normalizeId(env.inReplyTo),
    refs,
    at: new Date(m.internalDate || env.date || 0).getTime(),
  };
}

// Caller holds the mailbox lock. Brings the folder's index up to date and returns it.
async function syncIndex(client, creds, folder) {
  const key = `${String(creds.email).toLowerCase()}|${folder}`;
  const uv = String(client.mailbox.uidValidity);
  let idx = headerIndex.get(key);
  if (!idx || idx.uv !== uv) {
    idx = { uv, items: new Map(), lastUid: 0, syncedAt: 0 };
    headerIndex.set(key, idx);
  }
  if (Date.now() - idx.syncedAt < INDEX_FRESH_MS) return idx;
  const total = client.mailbox.exists;
  if (!total) {
    idx.items.clear();
    idx.lastUid = 0;
  } else {
    const byUid = idx.lastUid > 0;
    const range = byUid ? `${idx.lastUid + 1}:*` : `${Math.max(1, total - INDEX_MAX + 1)}:*`;
    for await (const m of client.fetch(range, { uid: true, envelope: true, internalDate: true, headers: ['references'] }, { uid: byUid })) {
      if (m.uid <= idx.lastUid) continue; // "n:*" always yields the last message, even when nothing is new
      idx.items.set(m.uid, headerInfo(m));
      idx.lastUid = Math.max(idx.lastUid, m.uid);
    }
    if (idx.items.size > INDEX_MAX + 500) {
      const keep = [...idx.items.keys()].sort((a, b) => b - a).slice(0, INDEX_MAX);
      const next = new Map();
      keep.forEach((u) => next.set(u, idx.items.get(u)));
      idx.items = next;
    }
  }
  idx.syncedAt = Date.now();
  return idx;
}

// Display objects for some messages of the open folder: cached ones cost one flags lookup, the rest
// are downloaded (the start of them — see PARTIAL_BYTES) and cached. Caller holds the mailbox lock.
async function loadMembers(client, creds, folder, uids, { markRead }) {
  const uv = String(client.mailbox.uidValidity);
  const out = [];
  if (!uids.length) return out;
  const range = uids.join(',');
  const flagsOf = new Map();
  for (const msg of await client.fetchAll(range, { uid: true, flags: true, internalDate: true, size: true }, { uid: true })) {
    flagsOf.set(msg.uid, msg);
  }
  const missing = uids.filter((u) => flagsOf.has(u) && !cacheGet(cacheKey(creds, folder, uv, u)));
  if (missing.length) {
    for (const msg of await client.fetchAll(missing.join(','), { uid: true, source: { start: 0, maxLength: PARTIAL_BYTES } }, { uid: true })) {
      if (!msg.source) continue;
      try {
        const meta = flagsOf.get(msg.uid);
        const parsed = await simpleParser(msg.source);
        const display = buildDisplay(parsed, { folder, uid: msg.uid, flags: new Set(), seen: false, selfEmail: creds.email });
        display.partial = meta.size > PARTIAL_BYTES;
        display.received = meta.internalDate ? new Date(meta.internalDate).toISOString() : display.date;
        cachePut(cacheKey(creds, folder, uv, msg.uid), display);
      } catch (err) {
        // a message that can't be read just isn't shown
      }
    }
  }
  const toMark = [];
  for (const u of uids) {
    const meta = flagsOf.get(u);
    const display = cacheGet(cacheKey(creds, folder, uv, u));
    if (!meta || !display) continue;
    const flags = meta.flags || new Set();
    const wasSeen = flags.has('\\Seen');
    if (!wasSeen && markRead) toMark.push(u);
    const shown = withFlags(display, flags, wasSeen || markRead);
    shown.wasUnread = !wasSeen;
    out.push(shown);
  }
  if (toMark.length) await client.messageFlagsAdd(toMark.join(','), ['\\Seen'], { uid: true });
  return out;
}

// Folder structure rarely changes; one list call per minute per person is plenty for threading.
const folderListCache = new Map();
async function cachedFolderList(creds, client) {
  const key = String(creds.email).toLowerCase();
  const hit = folderListCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.list;
  const list = await client.list();
  folderListCache.set(key, { at: Date.now(), list });
  return list;
}

// Builds the link index for Inbox/Sent/Archive in the background (cheap once it exists).
const warming = new Set();
function warmIndexes(creds) {
  const who = String(creds.email).toLowerCase();
  if (warming.has(who)) return;
  warming.add(who);
  withClient(creds, async (client) => {
    const all = await cachedFolderList(creds, client);
    const paths = all.filter((f) => ['inbox', 'sent', 'archive'].includes(folderRole(f))).map((f) => f.path);
    for (const path of paths) {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try { await syncIndex(client, creds, path); } finally { lock.release(); }
    }
  }).catch(() => {}).finally(() => warming.delete(who));
}

async function getThread(creds, { folder, uid, markRead = true }) {
  return withClient(creds, async (client) => {
    const all = await cachedFolderList(creds, client);
    const wanted = [folder];
    if (folder !== 'INBOX') wanted.push('INBOX');
    all.forEach((f) => {
      const role = folderRole(f);
      if ((role === 'sent' || role === 'archive') && !wanted.includes(f.path)) wanted.push(f.path);
    });

    // 1. The start message: its place in the folder's index tells us which ids make up the conversation.
    let info = null;
    {
      const lock = await client.getMailboxLock(folder);
      try {
        const idx = await syncIndex(client, creds, folder);
        info = idx.items.get(Number(uid));
        if (!info) {
          for await (const m of client.fetch(String(uid), { uid: true, envelope: true, internalDate: true, headers: ['references'] }, { uid: true })) info = headerInfo(m);
          if (!info) throw new MailNotFoundError('Message not found');
          idx.items.set(info.uid, info);
        }
      } finally {
        lock.release();
      }
    }
    const known = new Set([info.messageId, info.inReplyTo, ...info.refs].filter(Boolean));
    const rootId = info.refs[0] || info.inReplyTo || info.messageId;

    // 2. In each folder, the members come straight from the index; only flags (and any message
    // we haven't seen before) are fetched.
    const shown = [];
    for (const path of wanted) {
      if (!all.some((f) => f.path === path)) continue;
      const lock = await client.getMailboxLock(path);
      try {
        const idx = await syncIndex(client, creds, path);
        let members = [...idx.items.values()].filter((e) => {
          if (path === folder && e.uid === Number(uid)) return true;
          return (e.messageId && known.has(e.messageId)) || e.refs.some((r) => known.has(r) || r === rootId) || known.has(e.inReplyTo) || (e.messageId && info.messageId && e.refs.includes(info.messageId));
        });
        members.sort((a, b) => b.at - a.at);
        members = members.slice(0, THREAD_MAX);
        const loaded = await loadMembers(client, creds, path, members.map((e) => e.uid), { markRead });
        const present = new Set(loaded.map((d) => d.uid));
        members.forEach((e) => { if (!present.has(e.uid)) idx.items.delete(e.uid); }); // gone from the server
        shown.push(...loaded);
      } finally {
        lock.release();
      }
    }

    // 3. One entry per distinct message (the same one can be filed in two folders), oldest -> newest.
    const seenIds = new Set();
    const messages = [];
    for (const d of shown) {
      const id = normalizeId(d.messageId) || `${d.folder}/${d.uid}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      messages.push(d);
    }
    messages.sort((a, b) => new Date(a.received || a.date || 0) - new Date(b.received || b.date || 0));
    const startMsg = messages.find((m) => m.folder === folder && m.uid === Number(uid)) || messages[0];
    return { subject: (startMsg && startMsg.subject) || '', messages, truncated: false };
  });
}

async function readAttachment(creds, { folder, uid, index }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const { source } = await fetchSource(client, uid);
      const parsed = await simpleParser(source);
      const attachment = parsed.attachments[index];
      if (!attachment) throw new MailNotFoundError('Attachment not found');
      return {
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.contentType || 'application/octet-stream',
        content: attachment.content,
      };
    } finally {
      lock.release();
    }
  });
}

// ---- flags ---------------------------------------------------------------------------------

// ---- organizing: move, delete, archive, spam, folders -----------------------------------------

const SYSTEM_NAMES = { archive: 'Archive', junk: 'Junk', trash: 'Trash', sent: 'Sent', drafts: 'Drafts' };

function delimiterOf(folders) {
  const withDelim = folders.find((f) => f.delimiter);
  return (withDelim && withDelim.delimiter) || '/';
}

// Where new top-level folders live. On cPanel/Dovecot everything sits under "INBOX." (so Sent is
// "INBOX.Sent"); elsewhere it's the root. Copy whatever the existing system folders do.
function topLevelPrefix(folders) {
  const sibling = folders.find((f) => ['sent', 'drafts', 'trash', 'junk'].includes(folderRole(f)) && f.path.includes(f.delimiter || '/'));
  if (!sibling) return '';
  const delim = sibling.delimiter || '/';
  const parts = sibling.path.split(delim);
  parts.pop();
  return parts.length ? `${parts.join(delim)}${delim}` : '';
}

async function ensureRoleFolder(client, role) {
  if (role === 'inbox') return 'INBOX';
  const all = await client.list();
  const existing = all.find((f) => !f.flags.has('\\Noselect') && folderRole(f) === role);
  if (existing) return existing.path;
  const name = SYSTEM_NAMES[role];
  if (!name) throw new Error('Unknown folder type');
  const path = `${topLevelPrefix(all)}${name}`;
  await client.mailboxCreate(path);
  return path;
}

async function roleOfPath(client, path) {
  if (String(path).toUpperCase() === 'INBOX') return 'inbox';
  const all = await client.list();
  const found = all.find((f) => f.path === path);
  return found ? folderRole(found) : 'other';
}

function uidList(uids) {
  return (uids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

async function moveMessages(creds, { folder, uids, to, toRole }) {
  return withClient(creds, async (client) => {
    const range = uidList(uids);
    if (!range.length) return { moved: 0, destination: folder, uidMap: {} };
    const destination = to || (await ensureRoleFolder(client, toRole));
    if (destination === folder) return { moved: 0, destination, uidMap: {} };
    const lock = await client.getMailboxLock(folder);
    try {
      const result = await client.messageMove(range, destination, { uid: true });
      const uidMap = {};
      if (result && result.uidMap) result.uidMap.forEach((value, key) => { uidMap[key] = value; });
      return { moved: range.length, destination, uidMap };
    } finally {
      lock.release();
    }
  });
}

// Delete = move to Deleted Items; from Deleted Items it is gone for good.
async function deleteMessages(creds, { folder, uids }) {
  return withClient(creds, async (client) => {
    const range = uidList(uids);
    if (!range.length) return { deleted: 0, permanent: false };
    const role = await roleOfPath(client, folder);
    if (role === 'trash') {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete(range, { uid: true });
      } finally {
        lock.release();
      }
      return { deleted: range.length, permanent: true, destination: null, uidMap: {} };
    }
    const destination = await ensureRoleFolder(client, 'trash');
    const lock = await client.getMailboxLock(folder);
    try {
      const result = await client.messageMove(range, destination, { uid: true });
      const uidMap = {};
      if (result && result.uidMap) result.uidMap.forEach((value, key) => { uidMap[key] = value; });
      return { deleted: range.length, permanent: false, destination, uidMap };
    } finally {
      lock.release();
    }
  });
}

const FOLDER_NAME_BAD = /[\\/.\x00-\x1f"*%#&]/;

function checkFolderName(name) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 80 || FOLDER_NAME_BAD.test(clean)) {
    const err = new Error('Folder names can\'t be empty or contain / \\ . " * % # & characters');
    err.status = 400;
    throw err;
  }
  return clean;
}

async function createFolder(creds, { name, parent }) {
  const clean = checkFolderName(name);
  return withClient(creds, async (client) => {
    const all = await client.list();
    const delim = delimiterOf(all);
    let path;
    if (parent) {
      if (!all.some((f) => f.path === parent)) throw new MailNotFoundError('Parent folder not found');
      path = `${parent}${delim}${clean}`;
    } else {
      path = `${topLevelPrefix(all)}${clean}`;
    }
    if (all.some((f) => f.path.toLowerCase() === path.toLowerCase())) {
      const err = new Error('A folder with that name already exists');
      err.status = 409;
      throw err;
    }
    await client.mailboxCreate(path);
    return { path };
  });
}

async function renameFolder(creds, { path, name }) {
  const clean = checkFolderName(name);
  return withClient(creds, async (client) => {
    const all = await client.list();
    const target = all.find((f) => f.path === path);
    if (!target) throw new MailNotFoundError('Folder not found');
    if (folderRole(target) !== 'other') {
      const err = new Error("System folders can't be renamed");
      err.status = 400;
      throw err;
    }
    const delim = target.delimiter || '/';
    const parts = path.split(delim);
    parts.pop();
    const newPath = [...parts, clean].join(delim);
    if (all.some((f) => f.path.toLowerCase() === newPath.toLowerCase() && f.path !== path)) {
      const err = new Error('A folder with that name already exists');
      err.status = 409;
      throw err;
    }
    await client.mailboxRename(path, newPath);
    return { path: newPath };
  });
}

async function deleteFolder(creds, { path }) {
  return withClient(creds, async (client) => {
    const all = await client.list();
    const target = all.find((f) => f.path === path);
    if (!target) throw new MailNotFoundError('Folder not found');
    if (folderRole(target) !== 'other') {
      const err = new Error("System folders can't be deleted");
      err.status = 400;
      throw err;
    }
    // Servers differ on what happens to children when a parent goes, so remove them first,
    // deepest first, then the folder itself.
    const delim = target.delimiter || '/';
    const children = all.filter((f) => f.path.startsWith(`${path}${delim}`)).sort((a, b) => b.path.length - a.path.length);
    for (const child of children) await client.mailboxDelete(child.path);
    await client.mailboxDelete(path);
    return { ok: true, removedSubfolders: children.length };
  });
}

// "Empty folder" — only for Deleted Items and Junk, where it is the expected thing to do.
async function emptyFolder(creds, { path }) {
  return withClient(creds, async (client) => {
    const role = await roleOfPath(client, path);
    if (role !== 'trash' && role !== 'junk') {
      const err = new Error('Only Deleted Items and Junk can be emptied');
      err.status = 400;
      throw err;
    }
    const lock = await client.getMailboxLock(path);
    try {
      if (client.mailbox.exists > 0) await client.messageDelete('1:*');
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

// ---- compose: replies, forwards, Sent copy ------------------------------------------------------

// What goes INTO the editor when replying to / forwarding someone's email. The editor lives in the
// app's own page, so this is far stricter than what's shown for reading: no styles, no images, no
// classes — just structure and links. (The editor itself also sits in a script-less sandbox.)
const QUOTE_TAGS = [
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'blockquote', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'pre', 'code', 'hr', 'sub', 'sup',
  'center', 'font', 'small', 'big',
];
const MAX_QUOTE_CHARS = 400000;

function sanitizeQuoteHtml(html) {
  if (!html) return '';
  if (html.length > MAX_QUOTE_CHARS) return '<p><i>[The original message is too long to quote here.]</i></p>';
  return sanitizeHtml(html, {
    allowedTags: QUOTE_TAGS,
    allowedAttributes: { a: ['href'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title'],
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { href: attribs.href } }) },
  });
}

// The person's own message on its way out. Their formatting (colours, sizes, lists, links) is
// kept; anything that could run or phone home is not.
function sanitizeOutgoingHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS.filter((t) => t !== 'style'),
    allowedAttributes: {
      '*': COMMON_ATTRS.filter((a) => a !== 'class'),
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style', 'align', 'border'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title'],
    transformTags: {
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if (next.style) next.style = scrubCss(next.style);
        if (tagName === 'a') {
          next.target = '_blank';
          next.rel = 'noopener noreferrer';
        }
        return { tagName, attribs: next };
      },
    },
  });
}

function stripSubjectPrefix(subject) {
  return String(subject || '').replace(/^\s*((re|fwd?|aw|sv)(\[\d+\])?\s*:\s*)+/i, '').trim();
}

function dedupePeople(list, exclude) {
  const seen = new Set((exclude || []).map((a) => String(a).toLowerCase()));
  const out = [];
  list.forEach((p) => {
    const key = String((p && p.address) || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: p.name || '', address: p.address });
  });
  return out;
}

async function prepareCompose(creds, { folder, uid, mode }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const { source } = await fetchSource(client, uid);
      const parsed = await simpleParser(source);
      const self = creds.email.toLowerCase();
      const from = flatAddresses(parsed.from)[0] || null;
      const replyTo = flatAddresses(parsed.replyTo);
      const originalTo = flatAddresses(parsed.to);
      const originalCc = flatAddresses(parsed.cc);
      const sentByMe = from && from.address.toLowerCase() === self;
      const subjectBase = stripSubjectPrefix(parsed.subject);

      const prepared = {
        mode,
        to: [],
        cc: [],
        subject: '',
        inReplyTo: '',
        references: [],
        from,
        date: toIso(parsed.date),
        originalSubject: parsed.subject || '',
        originalTo,
        originalCc,
        quoteHtml: sanitizeQuoteHtml(parsed.html || parsed.textAsHtml || ''),
        attachments: [],
      };

      if (mode === 'forward') {
        prepared.subject = `Fwd: ${subjectBase}`;
        prepared.attachments = parsed.attachments
          .map((a, index) => ({ index, filename: a.filename || `attachment-${index + 1}`, size: a.size || (a.content ? a.content.length : 0), inline: isInlineImage(a, parsed.html) }))
          .filter((a) => !a.inline);
      } else {
        prepared.subject = `Re: ${subjectBase}`;
        const primary = replyTo.length ? replyTo : from ? [from] : [];
        // Replying to something you sent yourself means writing to whoever you sent it to.
        prepared.to = dedupePeople(sentByMe ? originalTo : primary, [self]);
        if (mode === 'replyall') {
          prepared.cc = dedupePeople([...originalTo, ...originalCc], [self, ...prepared.to.map((p) => p.address)]);
          if (sentByMe) prepared.to = dedupePeople(originalTo, [self]);
        }
        prepared.inReplyTo = parsed.messageId || '';
        const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        prepared.references = [...refs, parsed.messageId].filter(Boolean);
      }
      return prepared;
    } finally {
      lock.release();
    }
  });
}

// Full content of the chosen attachments of one message (for Forward). Parsed once.
async function readAttachments(creds, { folder, uid, indexes }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const { source } = await fetchSource(client, uid);
      const parsed = await simpleParser(source);
      return indexes
        .map((i) => parsed.attachments[i])
        .filter(Boolean)
        .map((a, n) => ({ filename: a.filename || `attachment-${n + 1}`, contentType: a.contentType || 'application/octet-stream', content: a.content }));
    } finally {
      lock.release();
    }
  });
}

// ---- drafts -------------------------------------------------------------------------------------

// Files a draft in Drafts (flagged \Draft) and removes the version it replaces, so editing one
// draft never leaves a trail of copies. Returns the new draft's UID for the next save.
async function appendDraft(creds, raw, { replaceUid } = {}) {
  return withClient(creds, async (client) => {
    const path = await ensureRoleFolder(client, 'drafts');
    const result = await client.append(path, raw, ['\\Draft', '\\Seen'], new Date());
    if (replaceUid) {
      const lock = await client.getMailboxLock(path);
      try {
        await client.messageDelete([Number(replaceUid)], { uid: true });
      } catch (err) {
        // the older copy may already be gone — not worth failing the save
      } finally {
        lock.release();
      }
    }
    return { folder: path, uid: result && result.uid ? Number(result.uid) : null };
  });
}

// Permanently remove messages (a draft that has been sent, or abandoned).
async function purgeMessages(creds, { folder, uids }) {
  return withClient(creds, async (client) => {
    const range = uidList(uids);
    if (!range.length) return { purged: 0 };
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageDelete(range, { uid: true });
      return { purged: range.length };
    } finally {
      lock.release();
    }
  });
}

// Everything the compose window needs to carry on editing a saved draft.
async function openDraft(creds, { folder, uid }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const { source } = await fetchSource(client, uid);
      const parsed = await simpleParser(source);
      const header = (name) => {
        const value = parsed.headers.get(name);
        return typeof value === 'string' ? value : '';
      };
      const [sourceFolder, sourceUid] = header('x-eg-source').split('|');
      const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
      return {
        mode: ['reply', 'replyall', 'forward'].includes(header('x-eg-mode')) ? header('x-eg-mode') : 'new',
        sourceFolder: sourceFolder || null,
        sourceUid: Number(sourceUid) || null,
        to: flatAddresses(parsed.to),
        cc: flatAddresses(parsed.cc),
        bcc: flatAddresses(parsed.bcc),
        subject: parsed.subject || '',
        html: sanitizeOutgoingHtml(parsed.html || (parsed.text ? textToHtml(parsed.text) : '')),
        inReplyTo: parsed.inReplyTo || '',
        references: refs,
        attachments: parsed.attachments
          .map((a, index) => ({ index, filename: a.filename || `attachment-${index + 1}`, size: a.size || (a.content ? a.content.length : 0), inline: isInlineImage(a, parsed.html) }))
          .filter((a) => !a.inline),
      };
    } finally {
      lock.release();
    }
  });
}

async function appendToSent(creds, raw) {
  return withClient(creds, async (client) => {
    const folders = await client.list();
    const target = folders.find((f) => !f.flags.has('\\Noselect') && folderRole(f) === 'sent');
    if (!target) return { saved: false };
    await client.append(target.path, raw, ['\\Seen'], new Date());
    return { saved: true, path: target.path };
  });
}

// \Answered for a reply, $Forwarded for a forward — so the list can show it later. Best effort.
async function markReplied(creds, { folder, uid, forwarded }) {
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(String(uid), [forwarded ? '$Forwarded' : '\\Answered'], { uid: true });
    } finally {
      lock.release();
    }
  });
}

const FLAG_ACTIONS = {
  read: { add: true, flag: '\\Seen' },
  unread: { add: false, flag: '\\Seen' },
  star: { add: true, flag: '\\Flagged' },
  unstar: { add: false, flag: '\\Flagged' },
};

async function setFlags(creds, { folder, uids, action }) {
  const spec = FLAG_ACTIONS[action];
  if (!spec) throw new Error('Unknown action');
  return withClient(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const range = uids.map(Number).filter(Number.isFinite);
      if (!range.length) return;
      if (spec.add) await client.messageFlagsAdd(range, [spec.flag], { uid: true });
      else await client.messageFlagsRemove(range, [spec.flag], { uid: true });
    } finally {
      lock.release();
    }
  });
}

// After anything that adds or removes mail, the link index must be topped up on next use.
function touchIndexes(creds) {
  const prefix = `${String(creds.email).toLowerCase()}|`;
  for (const [key, idx] of headerIndex) if (key.startsWith(prefix)) idx.syncedAt = 0;
}
function mutating(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      touchIndexes(args[0]);
    }
  };
}

module.exports = {
  MailAuthError,
  MailConnectError,
  MailNotFoundError,
  mailHost,
  getThread,
  moveMessages: mutating(moveMessages),
  deleteMessages: mutating(deleteMessages),
  createFolder,
  renameFolder,
  deleteFolder,
  emptyFolder,
  textToHtml,
  prepareCompose,
  readAttachments,
  appendDraft: mutating(appendDraft),
  purgeMessages: mutating(purgeMessages),
  openDraft,
  appendToSent: mutating(appendToSent),
  markReplied,
  sanitizeOutgoingHtml,
  verifyCredentials,
  forget,
  listFolders,
  inboxCounts,
  listMessages,
  previews,
  readMessage,
  readAttachment,
  setFlags,
  sanitizeEmailHtml,
};
