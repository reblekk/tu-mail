// Web Push: an alert for new mail while the browser or phone is closed, locked or the tab is in the background.
// The browser hands the server a subscription (an address on the browser vendor's push service). A watcher on the
// server checks the Inbox of each subscribed person, using the sign-in the server already holds, and sends the
// sender and subject through the push service; the text is encrypted for that browser (RFC 8291) and the push
// service cannot read it. Subscriptions end at sign-out.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webpush = require('web-push');

const root = () => path.join(process.env.TU_MAIL_DATA_DIR || path.join(__dirname, '../../data'), 'push');
const MAX_PER_PERSON = 5;
// Only real browser push services: a person must not be able to make the server call an address of their choice.
const HOSTS = [
  /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^updates-autopush\.(stage\.)?mozaws\.net$/,
  /^[a-z0-9.-]+\.push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/,
];

const idOf = (email) => crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex');
let subs = null; // id -> { email, list: [subscription], last: newest UID already announced }
let vapid = null;

function file(name) { return path.join(root(), name); }
function write(name, value) {
  fs.mkdirSync(root(), { recursive: true });
  const tmp = file(name) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}
function load() {
  if (subs) return;
  try { subs = new Map(Object.entries(JSON.parse(fs.readFileSync(file('subscriptions.json'), 'utf8')))); } catch (e) { subs = new Map(); }
}
const save = () => write('subscriptions.json', Object.fromEntries(subs));

function keys() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else {
    try { vapid = JSON.parse(fs.readFileSync(file('vapid.json'), 'utf8')); } catch (e) { vapid = webpush.generateVAPIDKeys(); write('vapid.json', vapid); }
  }
  return vapid;
}
const publicKey = () => keys().publicKey;

function validate(sub) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!sub || typeof sub !== 'object') throw bad('Subscription missing.');
  let url;
  try { url = new URL(String(sub.endpoint)); } catch (e) { throw bad('Subscription address is not valid.'); }
  if (url.protocol !== 'https:' || String(sub.endpoint).length > 600 || !HOSTS.some((re) => re.test(url.hostname))) throw bad('This browser\'s push service is not supported.');
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 60) throw bad('Subscription keys are not valid.');
  return { endpoint: String(sub.endpoint), keys: { p256dh: k.p256dh, auth: k.auth } };
}

function add(email, subscription) {
  load();
  const sub = validate(subscription);
  const id = idOf(email);
  const entry = subs.get(id) || { email: String(email).toLowerCase(), list: [], last: -1 };
  entry.list = entry.list.filter((s) => s.endpoint !== sub.endpoint);
  entry.list.push(sub);
  if (entry.list.length > MAX_PER_PERSON) entry.list = entry.list.slice(-MAX_PER_PERSON);
  subs.set(id, entry);
  save();
}
function remove(email, endpoint) {
  load();
  const id = idOf(email), entry = subs.get(id);
  if (!entry) return;
  entry.list = entry.list.filter((s) => s.endpoint !== endpoint);
  if (!entry.list.length) subs.delete(id);
  save();
}
function clear(email) { load(); if (subs.delete(idOf(email))) save(); }
const has = (email) => { load(); return subs.has(idOf(email)); };

// What an alert says: one message, the sender and the subject; several, a heading and the newest few.
function describe(latest) {
  if (!latest || !latest.length) return null;
  const subject = (m) => m.subject || '(no subject)';
  if (latest.length === 1) return { title: latest[0].from || '?', body: subject(latest[0]), uid: latest[0].uid };
  return { title: 'New mail', body: latest.slice(-3).reverse().map((m) => (m.from || '?') + ' — ' + subject(m)).join('\n'), uid: null };
}

async function deliver(entry, payload, log) {
  webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:admin@tuda-mail.de', keys().publicKey, keys().privateKey);
  const body = JSON.stringify(payload);
  let changed = false;
  for (const sub of [...entry.list]) {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'normal', timeout: 10000 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { entry.list = entry.list.filter((s) => s.endpoint !== sub.endpoint); changed = true; }
      else if (log) log('push_failed', { status: err.statusCode || 0 });
    }
  }
  if (changed) { if (!entry.list.length) subs.delete(idOf(entry.email)); save(); }
}

let busy = false;
// One pass: for every subscribed person whose sign-in the server holds, look for mail newer than the last one announced.
async function check({ credentials, inboxCounts, log }) {
  if (busy) return;
  busy = true;
  try {
    load();
    for (const creds of credentials()) {
      const entry = subs.get(idOf(creds.email));
      if (!entry || !entry.list.length) continue;
      try {
        const res = await inboxCounts(creds, 0, entry.last);
        const newest = Math.max(0, (res.uidNext || 1) - 1);
        if (entry.last < 0) { entry.last = newest; save(); continue; }
        const message = describe(res.latest);
        entry.last = Math.max(entry.last, newest);
        if (message) {
          save();
          await deliver(entry, { title: message.title, body: message.body, url: '/mail.html#INBOX' + (message.uid ? '/' + message.uid : '') }, log);
        }
      } catch (err) { /* sign-in no longer valid or the mail server is busy: try again next time */ }
    }
  } finally { busy = false; }
}

function start({ credentials, inboxCounts, log, everyMs = 90000 }) {
  const timer = setInterval(() => check({ credentials, inboxCounts, log }), everyMs);
  timer.unref();
  return timer;
}

module.exports = { publicKey, add, remove, clear, has, check, start, describe, validate };
