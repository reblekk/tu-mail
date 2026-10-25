const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sessions = new Map();
const DAY = 24 * 60 * 60 * 1000;
function id(req) { return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tu_mail_session='))?.slice(16); }
function lookup(req) {
  const key = id(req), session = sessions.get(key);
  if (session && session.expires > Date.now()) return session;
  sessions.delete(key); return null;
}
function selected(req, session) {
  const requested = req.headers['x-mail-account'] || req.query.account;
  return session?.accounts.get(requested || session.active);
}
// Sessions, and the mailbox passwords inside them, live in this process. With sessionStore 'file' they are
// also written encrypted to the data volume so a restart does not sign everyone out. Either way one
// instance must serve all traffic. Set by server.js from the deployment config.
const settings = { secureCookies: false, maxSessions: 2000, sessionDays: 365, sessionStore: 'memory', secret: '' };
const ttl = () => settings.sessionDays * DAY;
function configure(options) {
  Object.assign(settings, options);
  if (settings.sessionStore === 'file') load();
}
function count() { return sessions.size; }
function sweep() { for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key); }

// Encrypted file store. The key is SESSION_SECRET when set, otherwise a random key kept beside the data.
const file = () => path.join(process.env.TU_MAIL_DATA_DIR || path.join(__dirname, '../../data'), 'sessions.enc');
function storeKey() {
  if (settings.secret) return crypto.createHash('sha256').update(settings.secret).digest();
  const keyFile = path.join(path.dirname(file()), 'sessions.key');
  try { return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); } catch (e) { /* first run */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}
let dirty = null;
function persist() {
  if (settings.sessionStore !== 'file' || dirty) return;
  dirty = setTimeout(() => {
    dirty = null;
    try {
      const plain = JSON.stringify([...sessions].map(([key, s]) => [key, { active: s.active, expires: s.expires, accounts: [...s.accounts] }]));
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', storeKey(), iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const out = Buffer.concat([iv, cipher.getAuthTag(), body]);
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file() + '.tmp', out, { mode: 0o600 });
      fs.renameSync(file() + '.tmp', file());
    } catch (e) { /* the sessions stay in memory; the next change tries again */ }
  }, 1500);
  dirty.unref();
}
function load() {
  try {
    const raw = fs.readFileSync(file());
    const decipher = crypto.createDecipheriv('aes-256-gcm', storeKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    for (const [key, s] of JSON.parse(plain)) if (s.expires > Date.now()) sessions.set(key, { active: s.active, expires: s.expires, accounts: new Map(s.accounts) });
  } catch (e) { /* no file yet, or it cannot be read with this key: start empty */ }
}

function cookie(res, req, key) {
  res.cookie('tu_mail_session', key, { httpOnly: true, sameSite: 'strict', secure: settings.secureCookies || req.secure, path: '/', maxAge: ttl() });
}
function create(req, res, user, password) {
  let session = lookup(req);
  if (!session) {
    if (sessions.size >= settings.maxSessions) sweep();
    if (sessions.size >= settings.maxSessions) throw Object.assign(new Error('The service is busy. Try again later.'), { status: 503 });
    session = { accounts: new Map() };
  }
  session.accounts.set(user.userId, { user, password });
  session.active = user.userId;
  session.expires = Date.now() + ttl();
  // Rotate the cookie when adding or authenticating an account.
  sessions.delete(id(req));
  const key = crypto.randomBytes(32).toString('hex');
  sessions.set(key, session);
  cookie(res, req, key);
  persist();
}
// Sign-ins slide: each day of use pushes the expiry out again, so an account in regular use stays signed in.
function verifyToken(req, res, next) {
  const session = lookup(req), account = selected(req, session);
  if (!account) return res.status(401).json({ error: 'Please sign in to this account again.' });
  if (session.expires - Date.now() < ttl() - DAY) {
    session.expires = Date.now() + ttl();
    cookie(res, req, id(req));
    persist();
  }
  req.user = account.user; res.locals.session = account; next();
}
function getCredentials(req) {
  const account = selected(req, lookup(req));
  return account?.password ? { ...account.user, password: account.password } : null;
}
function setCredentials(req, res, { password }) { const account = selected(req, lookup(req)); if (account) { account.password = password; persist(); } }
function clearCredentials(res) { if (res.locals.session) { res.locals.session.password = null; persist(); } }
function listAccounts(req) { return [...(lookup(req)?.accounts.values() || [])].map(a => a.user); }
function logout(req, res) { sessions.delete(id(req)); res.clearCookie('tu_mail_session', { path: '/' }); persist(); }
setInterval(sweep, 60000).unref();
module.exports = { configure, count, create, verifyToken, getCredentials, setCredentials, clearCredentials, listAccounts, logout };
