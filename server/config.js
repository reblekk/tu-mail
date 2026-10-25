// Deployment settings, all from the environment. Without PUBLIC_URL the server runs in local mode:
// it binds to 127.0.0.1 and only answers requests addressed to localhost.
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') throw new Error('TRUST_PROXY=true would trust any client-supplied forwarding header. Use a hop count (for example 1) or an IP/CIDR list.');
  return /^\d+$/.test(value) ? Number(value) : value;
}

function load(env = process.env) {
  let publicUrl = null;
  if (env.PUBLIC_URL) {
    publicUrl = new URL(env.PUBLIC_URL);
    if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      throw new Error('PUBLIC_URL must be a bare origin such as https://mail.example.edu');
    }
    if (publicUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) {
      throw new Error('PUBLIC_URL must use https unless it points at localhost.');
    }
  }
  const port = Number(env.PORT) || 3210;
  if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 16) throw new Error('METRICS_TOKEN must be at least 16 characters.');
  return {
    brand: require('./services/brand').load(env),
    translate: require('./services/translate').fromEnv(env),
    metricsToken: env.METRICS_TOKEN || null,
    publicUrl,
    port,
    bindHost: env.BIND_HOST || (publicUrl ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    secureCookies: publicUrl ? publicUrl.protocol === 'https:' : false,
    hsts: publicUrl ? publicUrl.protocol === 'https:' : false,
    maxSessions: Number(env.MAX_SESSIONS) || 2000,
    sessionDays: Number(env.SESSION_DAYS) || 365,
    sessionStore: env.SESSION_STORE === 'file' ? 'file' : 'memory',
    sessionSecret: env.SESSION_SECRET || '',
    loginLimits: {
      ipPerMinute: Number(env.LOGIN_IP_PER_MINUTE) || 10,
      accountFailures: Number(env.LOGIN_ACCOUNT_FAILURES) || 5,
      accountWindowMs: (Number(env.LOGIN_ACCOUNT_WINDOW_MINUTES) || 15) * 60 * 1000,
    },
    logRequests: env.TU_MAIL_LOG !== 'off',
  };
}

// The Host header the server will answer to, and the Origin a state-changing request must carry.
function hostAllowed(config, host) {
  if (config.publicUrl) return host === config.publicUrl.host;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '');
}
function expectedOrigin(config, host) {
  return config.publicUrl ? config.publicUrl.origin : 'http://' + host;
}

module.exports = { load, hostAllowed, expectedOrigin };
