const crypto = require('node:crypto');
const sessions = new Map();
const TTL = 8 * 60 * 60 * 1000;
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
// Sessions, and the mailbox passwords inside them, live only in this process: nothing is written to
// disk or shared storage, and a restart signs everyone out. That is why one instance must serve all
// traffic. Set by server.js from the deployment config.
const settings = { secureCookies: false, maxSessions: 2000 };
function configure(options) { Object.assign(settings, options); }
function count() { return sessions.size; }
function sweep() { for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key); }

function create(req, res, user, password) {
  let session = lookup(req);
  if (!session) {
    if (sessions.size >= settings.maxSessions) sweep();
    if (sessions.size >= settings.maxSessions) throw Object.assign(new Error('The service is busy. Try again later.'), { status: 503 });
    session = { accounts: new Map() };
  }
  session.accounts.set(user.userId, { user, password });
  session.active = user.userId;
  session.expires = Date.now() + TTL;
  // Rotate the cookie when adding or authenticating an account.
  sessions.delete(id(req));
  const key = crypto.randomBytes(32).toString('hex');
  sessions.set(key, session);
  res.cookie('tu_mail_session', key, { httpOnly: true, sameSite: 'strict', secure: settings.secureCookies || req.secure, path: '/', maxAge: TTL });
}
function verifyToken(req, res, next) {
  const session = lookup(req), account = selected(req, session);
  if (!account) return res.status(401).json({ error: 'Please sign in to this account again.' });
  req.user = account.user; res.locals.session = account; next();
}
function getCredentials(req) {
  const account = selected(req, lookup(req));
  return account?.password ? { ...account.user, password: account.password } : null;
}
function setCredentials(req, res, { password }) { const account = selected(req, lookup(req)); if (account) account.password = password; }
function clearCredentials(res) { if (res.locals.session) res.locals.session.password = null; }
function listAccounts(req) { return [...(lookup(req)?.accounts.values() || [])].map(a => a.user); }
function logout(req, res) { sessions.delete(id(req)); res.clearCookie('tu_mail_session', { path: '/' }); }
setInterval(sweep, 60000).unref();
module.exports = { configure, count, create, verifyToken, getCredentials, setCredentials, clearCredentials, listAccounts, logout };
