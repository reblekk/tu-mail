const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
process.env.MAIL_IMAP_HOST ||= 'imap.stud.tu-darmstadt.de';
process.env.MAIL_SMTP_HOST ||= 'smtp.tu-darmstadt.de';
const express = require('express');
const configModule = require('./config');
const session = require('./services/mail-session');
const imap = require('./services/mail-imap');
const { accountProfile, allowedEmail } = require('./services/account-profiles');
const { securityMiddleware } = require('./middleware/security');
const { createLoginLimiter } = require('./middleware/rate-limit');
const logger = require('./middleware/logger');
const metricsModule = require('./middleware/metrics');
const brandModule = require('./services/brand');

function createApp(config = configModule.load()) {
  const app = express();
  const { log: writeLog, requests, who } = logger.create({ enabled: config.logRequests });
  const limiter = createLoginLimiter(config.loginLimits);
  setInterval(() => limiter.sweep(), 60000).unref();
  session.configure({ secureCookies: config.secureCookies, maxSessions: config.maxSessions });
  const metrics = metricsModule.create({ token: config.metricsToken, sessions: session, limiter });
  // One call per notable event: it goes to the log and to the counters.
  const log = (event, fields = {}, label) => { writeLog(event, fields); metrics.count(event, label); };

  app.set('translate', config.translate);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(metrics.observe);
  app.use(requests);
  app.use(securityMiddleware(config));
  app.use(express.json({ limit: '1mb' }));

  // Liveness only: no account, mailbox or configuration detail.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/metrics', metrics.handler);

  // Branding is public: the sign-in page needs it before anyone has signed in.
  app.get('/api/brand', (req, res) => res.json({ ...brandModule.publicView(config.brand), features: { translate: Boolean(config.translate) } }));
  app.get('/brand/logo', (req, res) => {
    const logo = config.brand.logo;
    if (!logo) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', logo.type);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.set('Cache-Control', 'no-cache');
    res.sendFile(logo.file);
  });
  app.get('/manifest.webmanifest', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json').send(JSON.stringify(brandModule.manifest(config.brand)));
  });

  app.post('/api/auth/login', async (req, res) => {
    const wait = limiter.checkIp(req.ip);
    if (wait) { log('login_throttled', { scope: 'ip', ip: req.ip }, ['scope', 'ip']); return tooMany(res, wait); }
    const { email, username, password, profile } = req.body || {};
    if (typeof email !== 'string' || !allowedEmail(email) || typeof username !== 'string' || !/^[a-z0-9_-]{3,64}$/i.test(username)
      || typeof password !== 'string' || !password || password.length > 1024) {
      return res.status(400).json({ error: 'Enter your TU email address, TU-ID and password.' });
    }
    const address = email.toLowerCase();
    const accountWait = limiter.checkAccount(address);
    if (accountWait) { log('login_throttled', { scope: 'account', who: who(address), ip: req.ip }, ['scope', 'account']); return tooMany(res, accountWait); }
    try {
      const settings = accountProfile({ email: address, username, profile });
      await imap.verifyCredentials({ email: address, username, password, ...settings });
      const user = { userId: settings.profile + ':' + address, email: address, username, name: username, role: 'mail', ...settings };
      session.create(req, res, user, password);
      limiter.recordSuccess(address);
      log('login_ok', { who: who(address), ip: req.ip });
      res.json({ user });
    } catch (e) {
      if (e.code === 'MAIL_AUTH') limiter.recordFailure(address);
      const reason = e.code === 'MAIL_AUTH' ? 'rejected' : e.status === 400 ? 'invalid' : e.status === 503 ? 'busy' : 'upstream';
      log('login_failed', { who: who(address), ip: req.ip, reason }, ['reason', reason]);
      const message = e.status === 400 || e.status === 503 ? e.message
        : e.code === 'MAIL_AUTH' ? 'The mailbox rejected your TU-ID or password.'
        : 'Unable to connect to the mail server. Check your connection and server settings.';
      res.status(e.status || (e.code === 'MAIL_AUTH' ? 401 : 502)).json({ error: message });
    }
  });
  app.get('/api/auth/me', session.verifyToken, (req, res) => res.json({ user: req.user }));
  app.get('/api/auth/accounts', session.verifyToken, (req, res) => res.json({ accounts: session.listAccounts(req) }));
  app.post('/api/auth/logout', session.verifyToken, (req, res) => {
    for (const account of session.listAccounts(req)) imap.forget(account.email);
    session.logout(req, res);
    res.json({ ok: true });
  });
  app.use('/api/mail', require('./routes/mail'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // The service worker file must never be served stale, or a release could not replace it.
  app.use(express.static(path.join(__dirname, '../client'), { setHeaders: (res, file) => { if (path.basename(file) === 'sw.js') res.set('Cache-Control', 'no-cache'); } }));
  app.use((err, req, res, next) => {
    if (!err.status || err.status >= 500) log('error', { path: req.path, status: err.status || 500, name: err.name, code: err.code });
    res.status(err.status || 500).json({ error: err.status ? err.message : 'The request could not be completed.' });
  });
  app.limiter = limiter;
  return app;
}

function tooMany(res, seconds) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: 'Too many attempts. Try again in ' + Math.ceil(seconds / 60) + ' minute(s).' });
}

const app = createApp();
app.createApp = createApp;
if (require.main === module) {
  const config = configModule.load();
  if (config.publicUrl && !config.trustProxy) {
    console.warn('Warning: PUBLIC_URL is set but TRUST_PROXY is not. Behind a reverse proxy every user will share one login rate limit. Set TRUST_PROXY to the number of proxies in front of this server.');
  }
  const server = app.listen(config.port, config.bindHost, () => {
    const where = config.publicUrl ? config.publicUrl.origin : 'http://127.0.0.1:' + config.port;
    console.log('TU Mail: ' + where + ' (listening on ' + config.bindHost + ':' + config.port + ')');
  });
  // Finish in-flight requests, then exit; sessions are memory-only so nothing else needs saving.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
module.exports = app;
