const express = require('express');
const multer = require('multer');
const mailSession = require('../services/mail-session');
const push = require('../services/push');
const imap = require('../services/mail-imap');
const smtp = require('../services/mail-smtp');
const mailSettings = require('../services/mail-settings');
const { verifyToken } = require('../middleware/auth');
const { parseFilters } = require('../services/search-query');
const translateService = require('../services/translate');
const displayName = require('../services/display-name');
const folderNames = require('../services/folder-names');

const router = express.Router();
const sendGuard = require('../services/send-guard');
const contacts = require('../services/contacts');
const invitations = require('../services/invitations');

// The whole message — body (which can carry pasted pictures as base64) plus attachments — arrives
// as one multipart upload held in memory; the limits keep a single request from hogging a shared
// host's RAM. smtp.sendMessage enforces the 20 MB attachment total on top of these.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20, fields: 40, fieldSize: 12 * 1024 * 1024 },
});

// The session must belong to a mailbox user. The mailbox credential comes from the httpOnly
// session cookie, never from the URL.
function requireMailUser(req, res, next) {
  if (!req.user || !req.user.userId || !req.user.email) return res.status(403).json({ error: 'Forbidden' });
  return next();
}

function sendError(res, err) {
  if (err.code === 'MAIL_AUTH') return res.status(409).json({ code: 'MAIL_AUTH', error: err.message });
  if (err.code === 'MAIL_CONNECT') return res.status(502).json({ code: 'MAIL_CONNECT', error: err.message });
  if (err.code === 'MAIL_NOT_FOUND') return res.status(404).json({ error: err.message });
  if (err.status) return res.status(err.status).json({ code: err.code, error: err.message });
  console.error('[mail]', err.message);
  return res.status(500).json({ error: err.message || 'Mail request failed' });
}

// Wraps a handler so it only runs with a usable mailbox credential, and so every failure maps
// to the same JSON shape the Mail page understands (MAIL_AUTH = ask for the mailbox password).
// MAIL_AUTH deliberately isn't a 401 — the shared apiFetch treats 401 as "session expired"
// and would log the user out.
function withMailbox(handler) {
  return async (req, res) => {
    const creds = mailSession.getCredentials(req);
    if (!creds) return res.status(409).json({ code: 'MAIL_AUTH', error: 'Mailbox sign-in required' });
    try {
      return res.json(await handler(req, creds));
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function folderParam(value) {
  const folder = String(value || '');
  if (!folder || folder.length > 255) {
    const err = new Error('A valid folder is required');
    err.status = 400;
    throw err;
  }
  return folder;
}

function uidParam(value) {
  const uid = Number(value);
  if (!Number.isInteger(uid) || uid < 1) {
    const err = new Error('A valid message id is required');
    err.status = 400;
    throw err;
  }
  return uid;
}

// What may be shown inside the app instead of downloaded. The sender controls both the filename and
// the declared type, so neither is trusted: the file's own first bytes decide (a "PDF" that isn't
// one, or a script renamed .png, is only ever offered as a download). SVG and HTML are never shown.
const MAX_TEXT_PREVIEW_BYTES = 500 * 1024;

function sniffPreviewType(file) {
  const b = file.content;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 1024).includes('%PDF-')) return 'application/pdf';
  const declared = String(file.contentType || '').toLowerCase().split(';')[0].trim();
  const name = String(file.filename || '').toLowerCase();
  if ((declared === 'text/plain' || declared === 'text/csv') && /\.(txt|csv|log)$/.test(name) && b.length <= MAX_TEXT_PREVIEW_BYTES && !b.includes(0)) return 'text/plain';
  return null;
}

// Filenames come from strangers' emails, so: printable-ASCII fallback with quotes/backslashes
// removed (this also strips CR/LF, so no header injection) plus the percent-encoded UTF-8 form
// (RFC 5987) that browsers use to show non-English names like "বিবরণ.txt" correctly.
function dispositionHeader(filename, type) {
  const name = String(filename || 'attachment');
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Everything below (except the attachment download, registered first) needs a signed-in session.
router.get('/messages/:uid/attachments/:index', verifyToken, requireMailUser, async (req, res) => {
  const creds = mailSession.getCredentials(req);
  if (!creds) return res.status(409).json({ code: 'MAIL_AUTH', error: 'Mailbox sign-in required' });
  try {
    const file = await imap.readAttachment(creds, {
      folder: folderParam(req.query.folder),
      uid: uidParam(req.params.uid),
      index: Number(req.params.index),
    });
    const previewType = req.query.inline === '1' ? sniffPreviewType(file) : null;
    res.set('Content-Type', previewType ? (previewType === 'text/plain' ? 'text/plain; charset=utf-8' : previewType) : 'application/octet-stream');
    res.set('Content-Disposition', dispositionHeader(file.filename, previewType ? 'inline' : 'attachment'));
    res.set('X-Content-Type-Options', 'nosniff');
    // Pictures and text have no business running anything; a PDF is left to the browser's own viewer.
    if (previewType && previewType !== 'application/pdf') res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    res.set('Cache-Control', 'private, no-store');
    return res.send(file.content);
  } catch (err) {
    return sendError(res, err);
  }
});

router.use(verifyToken, requireMailUser);

// The mailbox password normally rides along from login. This is the fallback for when the
// session has lost it: the person types the mailbox password once and it's remembered for the
// rest of the session.
router.post('/connect', async (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (!password) return res.status(400).json({ error: 'Password is required' });
  const creds = { ...req.user, password };
  try {
    imap.forget(creds.email);
    await imap.verifyCredentials(creds);
    mailSession.setCredentials(req, res, { userId: req.user.userId, email: creds.email, password });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/disconnect', (req, res) => {
  imap.forget(req.user.email);
  mailSession.clearCredentials(res);
  res.json({ ok: true });
});

router.get('/folders', withMailbox(async (req, creds) => folderNames.tidy(await imap.listFolders(creds))));

// Alerts while the browser is closed: the browser's push subscription is kept on the server (services/push.js).
router.get('/push/key', (req, res) => res.json({ key: push.publicKey() }));
router.post('/push/subscribe', (req, res) => {
  try { push.add(req.user.email, (req.body || {}).subscription); res.json({ ok: true }); } catch (err) { sendError(res, err); }
});
router.post('/push/unsubscribe', (req, res) => {
  try { push.remove(req.user.email, String((req.body || {}).endpoint || '')); res.json({ ok: true }); } catch (err) { sendError(res, err); }
});
router.get('/unread', withMailbox((req, creds) => imap.inboxCounts(creds, Math.max(0, parseInt(req.query.since, 10) || 0), (req.query.after === undefined ? -1 : Math.max(0, parseInt(req.query.after, 10) || 0)))));

router.get('/messages', withMailbox((req, creds) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 40));
  return imap.listMessages(creds, {
    folder: folderParam(req.query.folder),
    page,
    pageSize,
    q: String(req.query.q || '').trim().slice(0, 200),
    scope: req.query.scope === 'all' ? 'all' : 'headers',
    unreadOnly: req.query.unread === '1',
    filters: parseFilters(req.query),
  });
}));

router.post('/previews', withMailbox((req, creds) => {
  const uids = Array.isArray(req.body.uids) ? req.body.uids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!uids.length) return {};
  return imap.previews(creds, { folder: folderParam(req.body.folder), uids });
}));

router.put('/messages/flags', withMailbox(async (req, creds) => {
  const uids = Array.isArray(req.body.uids) ? req.body.uids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  await imap.setFlags(creds, { folder: folderParam(req.body.folder), uids, action: String(req.body.action || '') });
  return { ok: true };
}));

function uidsBody(value) {
  const uids = Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!uids.length) {
    const err = new Error('No messages selected');
    err.status = 400;
    throw err;
  }
  return uids.slice(0, 500);
}

const MOVE_ROLES = new Set(['inbox', 'archive', 'junk', 'trash']);

// The whole conversation around one message, oldest to newest, as full cards.
router.get('/thread', withMailbox((req, creds) => imap.getThread(creds, {
  folder: folderParam(req.query.folder),
  uid: uidParam(req.query.uid),
  markRead: req.query.peek !== '1',
})));

router.post('/messages/move', withMailbox((req, creds) => {
  const body = req.body || {};
  const toRole = MOVE_ROLES.has(body.toRole) ? body.toRole : null;
  if (!toRole && !body.to) {
    const err = new Error('Choose where to move the messages');
    err.status = 400;
    throw err;
  }
  return imap.moveMessages(creds, { folder: folderParam(body.folder), uids: uidsBody(body.uids), to: toRole ? null : folderParam(body.to), toRole });
}));

router.post('/messages/delete', withMailbox((req, creds) => imap.deleteMessages(creds, {
  folder: folderParam((req.body || {}).folder),
  uids: uidsBody((req.body || {}).uids),
})));

router.post('/folders', withMailbox((req, creds) => imap.createFolder(creds, {
  name: (req.body || {}).name,
  parent: (req.body || {}).parent ? folderParam(req.body.parent) : null,
})));
router.put('/folders', withMailbox((req, creds) => imap.renameFolder(creds, { path: folderParam((req.body || {}).path), name: (req.body || {}).name })));
router.delete('/folders', withMailbox((req, creds) => imap.deleteFolder(creds, { path: folderParam((req.body || {}).path) })));
router.post('/folders/empty', withMailbox((req, creds) => imap.emptyFolder(creds, { path: folderParam((req.body || {}).path) })));

const COMPOSE_MODES = new Set(['reply', 'replyall', 'forward']);

router.get('/messages/:uid/compose', withMailbox((req, creds) => {
  const mode = String(req.query.mode || '');
  if (!COMPOSE_MODES.has(mode)) {
    const err = new Error('Unknown compose mode');
    err.status = 400;
    throw err;
  }
  return imap.prepareCompose(creds, { folder: folderParam(req.query.folder), uid: uidParam(req.params.uid), mode });
}));

function jsonField(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

// multer reads filenames as latin1; mail clients (and people) use UTF-8 ones like "বিবরণ.pdf".
function utf8Filename(name) {
  const raw = String(name || 'attachment');
  const decoded = /[^\x00-\xff]/.test(raw) ? raw : Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'attachment';
}

// Shared by /send and /draft: the message arrives as one multipart upload.
function receiveMessage(req, res, next) {
  // Refuse an oversized upload from its declared size, before multer starts holding it in memory
  // (20 MB of attachments + the body, with headroom for multipart overhead).
  if (Number(req.headers['content-length']) > 36 * 1024 * 1024) {
    return res.status(413).json({ error: 'This message is too large to send (20 MB of attachments maximum).' });
  }
  return upload.array('files', 20)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'A file is larger than the 20 MB limit' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'You can attach at most 20 files' });
    return res.status(400).json({ error: 'The message could not be read' });
  });
}

// Files uploaded with the message, plus any the person chose to keep from an existing message —
// the original's attachments when forwarding, or a saved draft's own attachments when resuming it.
async function gatherAttachments(req, creds) {
  const body = req.body || {};
  const attachments = (req.files || []).map((f) => ({
    filename: utf8Filename(f.originalname),
    contentType: f.mimetype || 'application/octet-stream',
    content: f.buffer,
  }));
  if (body.keepFolder && body.keepUid) {
    const indexes = jsonField(body.keepIndexes, []).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
    if (indexes.length) {
      const kept = await imap.readAttachments(creds, { folder: folderParam(body.keepFolder), uid: uidParam(body.keepUid), indexes });
      attachments.push(...kept);
    }
  }
  return attachments;
}

router.post('/send', receiveMessage, async (req, res) => {
  const creds = mailSession.getCredentials(req);
  if (!creds) return res.status(409).json({ code: 'MAIL_AUTH', error: 'Mailbox sign-in required' });
  try {
    const body = req.body || {};
    const mode = ['reply', 'replyall', 'forward'].includes(body.mode) ? body.mode : 'new';
    const attachments = await gatherAttachments(req, creds);

    const settings = await mailSettings.getSettings(req.user.email);
    const from = { name: displayName.forPerson(req.user.email, settings.displayName), address: req.user.email };
    const outgoing = {
      fromName: from.name,
      fromAddress: from.address,
      to: jsonField(body.to, []),
      cc: jsonField(body.cc, []),
      bcc: jsonField(body.bcc, []),
      subject: body.subject,
      html: body.html,
      attachments,
      inReplyTo: body.inReplyTo,
      references: jsonField(body.references, []),
    };
    const result = await sendGuard.once(req.user.userId, body.sendAttempt, outgoing, () => smtp.sendMessage(creds, outgoing));

    let marked = true;
    if (mode !== 'new' && body.sourceFolder && body.sourceUid) {
      try {
        await imap.markReplied(creds, { folder: folderParam(body.sourceFolder), uid: uidParam(body.sourceUid), forwarded: mode === 'forward' });
      } catch (err) {
        marked = false; // the mail is already sent — a missing "answered" arrow isn't worth an error
      }
    }

    // A draft that has just been sent shouldn't linger in Drafts.
    if (body.draftFolder && body.draftUid) {
      try {
        await imap.purgeMessages(creds, { folder: folderParam(body.draftFolder), uids: [uidParam(body.draftUid)] });
      } catch (err) {
        // harmless leftover; the person can delete it
      }
    }
    return res.json({ ok: true, ...result, markedReplied: marked });
  } catch (err) {
    return sendError(res, err);
  }
});

// Save (or re-save) a draft. `replaceUid` is the previous version, which is removed.
router.post('/draft', receiveMessage, async (req, res) => {
  const creds = mailSession.getCredentials(req);
  if (!creds) return res.status(409).json({ code: 'MAIL_AUTH', error: 'Mailbox sign-in required' });
  try {
    const body = req.body || {};
    const attachments = await gatherAttachments(req, creds);
    const settings = await mailSettings.getSettings(req.user.email);
    const from = { name: displayName.forPerson(req.user.email, settings.displayName), address: req.user.email };
    const saved = await smtp.saveDraft(creds, {
      fromName: from.name,
      fromAddress: from.address,
      mode: body.mode,
      sourceFolder: body.sourceFolder,
      sourceUid: body.sourceUid,
      to: jsonField(body.to, []),
      cc: jsonField(body.cc, []),
      bcc: jsonField(body.bcc, []),
      subject: body.subject,
      html: body.html,
      attachments,
      inReplyTo: body.inReplyTo,
      references: jsonField(body.references, []),
    }, { replaceUid: body.replaceUid ? uidParam(body.replaceUid) : null });
    return res.json({ ok: true, ...saved });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/messages/:uid/draft', withMailbox((req, creds) => imap.openDraft(creds, {
  folder: folderParam(req.query.folder),
  uid: uidParam(req.params.uid),
})));

router.delete('/messages/:uid/draft', withMailbox(async (req, creds) => {
  await imap.purgeMessages(creds, { folder: folderParam(req.query.folder), uids: [uidParam(req.params.uid)] });
  return { ok: true };
}));

// The person's signature. Not tied to the mailbox login — it's their own preference.
// Notifications while the app is closed (see services/mail-watch.js). Switching on stores this
// person's mailbox password, encrypted, on the server; switching off deletes it.
router.get('/contacts', async (req,res) => { try { res.json(await contacts.list(req.user.userId)); } catch(e) { sendError(res,e); } });
router.post('/contacts', async (req,res) => { try { res.json(await contacts.save(req.user.userId,req.body || {})); } catch(e) { sendError(res,e); } });
router.delete('/contacts/:id', async (req,res) => { try { res.json(await contacts.remove(req.user.userId,req.params.id)); } catch(e) { sendError(res,e); } });
router.get('/messages/:uid/invitation/:index', withMailbox(async (req,creds) => {
 const file=await imap.readAttachment(creds,{folder:folderParam(req.query.folder),uid:uidParam(req.params.uid),index:Number(req.params.index)});
 return invitations.inspect(file.content,req.user.email);
}));
router.post('/messages/:uid/invitation/:index/reply', withMailbox(async (req,creds) => {
 const file=await imap.readAttachment(creds,{folder:folderParam(req.body.folder),uid:uidParam(req.params.uid),index:Number(req.params.index)});
 return invitations.reply(file.content,req.user.email,req.body.response);
}));

router.get('/settings', async (req, res) => {
  try { res.json(await mailSettings.getSettings(req.user.email)); } catch (err) { sendError(res, err); }
});

router.put('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await mailSettings.saveSettings(req.user.email, {
      signatureHtml: imap.sanitizeOutgoingHtml(String(body.signatureHtml || '')),
      useOnNew: body.useOnNew !== false,
      useOnReply: body.useOnReply !== false,
    });
    res.json(saved);
  } catch (err) {
    sendError(res, err);
  }
});

// Translate message text to English through the operator's translation server, if there is one.
const translateUse = new Map();
router.post('/translate', async (req, res) => {
  const config = req.app.get('translate');
  if (!config) return res.status(501).json({ error: 'Translation is not set up on this server.' });
  const now = Date.now();
  const recent = (translateUse.get(req.user.userId) || []).filter((t) => t > now - 600000);
  if (recent.length >= 40) return res.status(429).json({ error: 'Too many translation requests. Try again in a few minutes.' });
  recent.push(now);
  translateUse.set(req.user.userId, recent);
  if (translateUse.size > 5000) translateUse.delete(translateUse.keys().next().value);
  try {
    res.json(await translateService.translateTexts(config, (req.body || {}).texts));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/send-allowance', (req, res) => res.json(smtp.sendingAllowance(req.user.email)));

// Download the message as an .eml file.
router.get('/messages/:uid/export', async (req, res) => {
  const creds = mailSession.getCredentials(req);
  if (!creds) return res.status(409).json({ code: 'MAIL_AUTH', error: 'Mailbox sign-in required' });
  try {
    const file = await imap.exportMessage(creds, { folder: folderParam(req.query.folder), uid: uidParam(req.params.uid) });
    res.set('Content-Type', 'message/rfc822');
    res.set('Content-Disposition', dispositionHeader(file.filename, 'attachment'));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    return res.send(file.content);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/messages/:uid', withMailbox((req, creds) => imap.readMessage(creds, {
  folder: folderParam(req.query.folder),
  uid: uidParam(req.params.uid),
  markRead: req.query.peek !== '1',
})));

module.exports = router;
