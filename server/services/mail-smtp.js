// Sending mail from the signed-in person's own mailbox, over the same cPanel server they read
// from (SMTP auth with the same credential — see mail-session.js). Builds the message itself so
// the exact bytes that went out can also be filed in the Sent folder.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const imap = require('./mail-imap');

const MAX_RECIPIENTS = 50;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const WINDOW_MS = 60 * 60 * 1000;

class MailSendError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.code = 'MAIL_SEND';
    this.status = status;
  }
}

// The From the reader sees: the account itself, or a saved send-as identity chosen by the route.
function fromHeader(message, creds) {
  const address = message.fromAddress || creds.email;
  const name = String(message.fromName || '').replace(/[\r\n"<>]/g, ' ').trim();
  return name ? { name, address } : address;
}
// When From is not the signed-in account, say which account actually submitted the message.
function senderHeader(message, creds) {
  return message.fromAddress && message.fromAddress.toLowerCase() !== String(creds.email).toLowerCase() ? { sender: creds.email } : {};
}

function smtpOptions(creds) {
  const host = process.env.MAIL_SMTP_HOST || imap.mailHost(creds.email);
  const secure = process.env.MAIL_SMTP_SECURE !== 'false';
  const tls = { rejectUnauthorized: true };
  if (process.env.MAIL_SMTP_SERVERNAME) tls.servername = process.env.MAIL_SMTP_SERVERNAME;
  return {
    host,
    port: Number(process.env.MAIL_SMTP_PORT) || (secure ? 465 : 587),
    secure,
    auth: { user: creds.smtpUsername || creds.username || creds.email, pass: creds.password },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
    tls,
  };
}

// ---- hourly sending cap ---------------------------------------------------------------------
// Shared hosting caps outgoing mail per hour, and going over it can get the whole domain's mail
// blocked — so each person gets a soft cap well under it, counted in recipients.

const sendLog = new Map();

function hourlyLimit() {
  return Number(process.env.MAIL_SEND_LIMIT_PER_HOUR) || 100;
}

function recentRecipients(email) {
  const cutoff = Date.now() - WINDOW_MS;
  const list = (sendLog.get(email) || []).filter((entry) => entry.at > cutoff);
  sendLog.set(email, list);
  return list.reduce((sum, entry) => sum + entry.count, 0);
}

function sendingAllowance(email) {
  const used = recentRecipients(String(email).toLowerCase());
  return { limit: hourlyLimit(), used, remaining: Math.max(0, hourlyLimit() - used) };
}

// ---- helpers ------------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function cleanAddress(entry) {
  const address = String((entry && entry.address) || '').trim();
  const name = String((entry && entry.name) || '').replace(/[\r\n"<>]/g, ' ').trim();
  return { address, name };
}

function normalizeRecipients(list, label) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((entry) => {
    const person = cleanAddress(entry);
    if (!person.address) return;
    if (!EMAIL_PATTERN.test(person.address) || person.address.length > 254) {
      throw new MailSendError(`"${person.address}" in ${label} isn't a valid email address`);
    }
    out.push(person.name ? { name: person.name, address: person.address } : { address: person.address });
  });
  return out;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/gi, '&');
}

// Plain-text twin of the HTML body, for mail clients (and spam filters) that want one.
function htmlToText(html) {
  const text = String(html)
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const inner = label.replace(/<[^>]+>/g, '').trim();
      return !inner || inner === href ? href : `${inner} (${href})`;
    })
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Pictures pasted into the editor arrive as data: URIs. Mail clients routinely refuse those, so
// they're turned into proper inline (cid:) attachments.
function inlineDataImages(html) {
  const attachments = [];
  let bytes = 0;
  const converted = html.replace(/(<img\b[^>]*?\ssrc=)(["'])data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/gi, (match, before, quote, type, data) => {
    const content = Buffer.from(data.replace(/\s+/g, ''), 'base64');
    bytes += content.length;
    if (!content.length || bytes > MAX_INLINE_IMAGE_BYTES) {
      throw new MailSendError('The pictures in this message are too large (5 MB maximum in total). Attach them as files instead.', 413);
    }
    const cid = `img${attachments.length + 1}-${crypto.randomBytes(6).toString('hex')}@eg-mail`;
    const ext = type.split('/')[1].replace('jpeg', 'jpg');
    attachments.push({ filename: `image${attachments.length + 1}.${ext}`, content, contentType: type, cid, contentDisposition: 'inline' });
    return `${before}${quote}cid:${cid}${quote}`;
  });
  return { html: converted, attachments };
}

function wrapBody(html) {
  return `<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1b2430">${html}</div>`;
}

function build(mail, keepBcc) {
  return new Promise((resolve, reject) => {
    const compiled = new MailComposer(mail).compile();
    compiled.keepBcc = keepBcc;
    compiled.build((err, buffer) => (err ? reject(err) : resolve(buffer)));
  });
}

function mapSmtpError(err, creds) {
  if (err instanceof MailSendError) return err;
  if (err.code === 'EAUTH' || err.responseCode === 535) return new imap.MailAuthError();
  if (err.code === 'EENVELOPE' || (err.rejected && err.rejected.length)) {
    const rejected = (err.rejected || []).join(', ');
    return new MailSendError(rejected ? `The mail server rejected these recipients: ${rejected}` : `The mail server rejected the message: ${err.message}`, 422);
  }
  if (/ECONN|ETIMEDOUT|ESOCKET|ENOTFOUND|EAI_AGAIN|certificate|altname|self.signed|socket/i.test(`${err.code || ''} ${err.message || ''}`)) {
    let host = 'the mail server';
    try {
      host = process.env.MAIL_SMTP_HOST || imap.mailHost(creds.email);
    } catch (e) {
      // keep generic
    }
    const wrapped = new MailSendError('The connection was interrupted. Delivery is uncertain. Check Sent and ask the recipient before sending again.', 502);
    wrapped.code = 'SEND_UNKNOWN';
    return wrapped;
  }
  return new MailSendError(`The mail server refused the message${err.response ? `: ${err.response}` : `: ${err.message}`}`, 502);
}

// message: { fromName, to, cc, bcc, subject, html, attachments:[{filename,content,contentType}],
//            inReplyTo, references }
async function sendMessage(creds, message) {
  const to = normalizeRecipients(message.to, 'To');
  const cc = normalizeRecipients(message.cc, 'Cc');
  const bcc = normalizeRecipients(message.bcc, 'Bcc');
  const total = to.length + cc.length + bcc.length;
  if (!total) throw new MailSendError('Add at least one recipient');
  if (total > MAX_RECIPIENTS) throw new MailSendError(`A message can have at most ${MAX_RECIPIENTS} recipients`);

  const allowance = sendingAllowance(creds.email);
  if (total > allowance.remaining) {
    throw new MailSendError(
      allowance.remaining === 0
        ? `You've reached the hourly sending limit (${allowance.limit} recipients per hour). Please try again later.`
        : `This would go over the hourly sending limit — you can send to ${allowance.remaining} more recipient${allowance.remaining === 1 ? '' : 's'} this hour.`,
      429
    );
  }

  const attachments = (message.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }));
  const attachmentBytes = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (attachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new MailSendError('Attachments are over the 20 MB limit in total', 413);
  }

  const outgoing = imap.sanitizeOutgoingHtml(message.html || '');
  const inline = inlineDataImages(outgoing);
  const html = wrapBody(inline.html);
  const domain = String(creds.email).split('@')[1];
  const mail = {
    from: fromHeader(message, creds),
    ...senderHeader(message, creds),
    to,
    cc,
    bcc,
    subject: String(message.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 500),
    html,
    text: htmlToText(inline.html),
    attachments: [...attachments, ...inline.attachments],
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    date: new Date(),
  };
  // These come back from the browser, so strip line breaks before they can reach a header.
  const headerValue = (v) => String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, 998);
  if (message.inReplyTo) mail.inReplyTo = headerValue(message.inReplyTo);
  if (message.references && message.references.length) mail.references = message.references.slice(-20).map(headerValue);

  const recipients = [...to, ...cc, ...bcc].map((p) => p.address);
  let raw;
  let sentCopy;
  try {
    raw = await build(mail, false);
    sentCopy = await build(mail, true);
  } catch (err) {
    throw new MailSendError(`Could not prepare the message: ${err.message}`, 400);
  }

  let delivery;
  const transporter = nodemailer.createTransport(smtpOptions(creds));
  try { delivery = await transporter.sendMail({ envelope: { from: creds.email, to: recipients }, raw }); }
  catch (err) { throw mapSmtpError(err, creds); }
  finally { transporter.close(); }

  const list = sendLog.get(creds.email.toLowerCase()) || [];
  list.push({ at: Date.now(), count: total });
  sendLog.set(creds.email.toLowerCase(), list);

  // The message is already out. Filing a copy is best-effort — failing to must never look like the
  // send itself failed (that would invite a duplicate).
  let savedToSent = false;
  try {
    savedToSent = (await imap.appendToSent(creds, sentCopy)).saved;
  } catch (err) {
    savedToSent = false;
  }

  return { messageId: mail.messageId, savedToSent, rejected: delivery?.rejected || [], allowance: sendingAllowance(creds.email) };
}

// Saves what has been written so far, exactly as it is — unlike sending it never insists on
// recipients, and addresses that aren't (yet) valid are simply left out rather than refused.
async function saveDraft(creds, message, { replaceUid } = {}) {
  const lenient = (list) => {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((entry) => {
      const person = cleanAddress(entry);
      if (person.address && EMAIL_PATTERN.test(person.address)) out.push(person.name ? { name: person.name, address: person.address } : { address: person.address });
    });
    return out;
  };

  const attachments = (message.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }));
  if (attachments.reduce((sum, a) => sum + a.content.length, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new MailSendError('Attachments are over the 20 MB limit in total', 413);
  }

  const inline = inlineDataImages(imap.sanitizeOutgoingHtml(message.html || ''));
  const domain = String(creds.email).split('@')[1];
  const oneLine = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 998);
  const mail = {
    from: fromHeader(message, creds),
    ...senderHeader(message, creds),
    to: lenient(message.to),
    cc: lenient(message.cc),
    bcc: lenient(message.bcc),
    subject: oneLine(message.subject).slice(0, 500),
    html: inline.html || '<div></div>',
    text: htmlToText(inline.html),
    attachments: [...attachments, ...inline.attachments],
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    date: new Date(),
    headers: {
      'X-EG-Mode': ['reply', 'replyall', 'forward'].includes(message.mode) ? message.mode : 'new',
      ...(message.sourceFolder && message.sourceUid ? { 'X-EG-Source': oneLine(`${message.sourceFolder}|${message.sourceUid}`) } : {}),
    },
  };
  if (message.inReplyTo) mail.inReplyTo = oneLine(message.inReplyTo);
  if (message.references && message.references.length) mail.references = message.references.slice(-20).map(oneLine);

  let raw;
  try {
    raw = await build(mail, true);
  } catch (err) {
    throw new MailSendError(`Could not prepare the draft: ${err.message}`, 400);
  }
  return imap.appendDraft(creds, raw, { replaceUid });
}

module.exports = { sendMessage, saveDraft, sendingAllowance, MailSendError, htmlToText, inlineDataImages, EMAIL_PATTERN, fromHeader, senderHeader };
