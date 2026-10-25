// Prometheus text metrics. Counters only count; they never carry addresses, paths or user data.
// The endpoint exists only when METRICS_TOKEN is set, and then needs "Authorization: Bearer <token>".
const crypto = require('node:crypto');

function create({ token, sessions, limiter }) {
  const requests = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const events = {};
  const started = Date.now();

  // `label` is an optional [name, value] pair, restricted to safe characters so nothing user-supplied can reach the output.
  const count = (event, label) => {
    const safe = (s) => String(s).replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
    const key = label ? event + '{' + safe(label[0]) + '="' + safe(label[1]) + '"}' : event;
    events[key] = (events[key] || 0) + 1;
  };
  const observe = (req, res, next) => {
    res.on('finish', () => { requests[Math.floor(res.statusCode / 100) + 'xx'] = (requests[Math.floor(res.statusCode / 100) + 'xx'] || 0) + 1; });
    next();
  };

  const authorised = (header) => {
    if (!token) return false;
    const given = Buffer.from(String(header || '').replace(/^Bearer /, ''));
    const want = Buffer.from(token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  const render = () => {
    const lines = [];
    const metric = (name, help, type, rows) => {
      lines.push('# HELP ' + name + ' ' + help, '# TYPE ' + name + ' ' + type);
      for (const [labels, value] of rows) lines.push(name + labels + ' ' + value);
    };
    metric('tu_mail_http_requests_total', 'HTTP responses by status class.', 'counter', Object.entries(requests).map(([c, v]) => ['{class="' + c + '"}', v]));
    const byEvent = (prefix) => Object.entries(events).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length).replace(/^\{/, '{') || '', v]);
    metric('tu_mail_login_ok_total', 'Successful sign-ins.', 'counter', [['', events.login_ok || 0]]);
    metric('tu_mail_login_failed_total', 'Failed sign-ins by reason.', 'counter', byEvent('login_failed').length ? byEvent('login_failed') : [['', 0]]);
    metric('tu_mail_login_throttled_total', 'Sign-ins refused by rate limiting, by scope.', 'counter', byEvent('login_throttled').length ? byEvent('login_throttled') : [['', 0]]);
    metric('tu_mail_sessions', 'Signed-in sessions held in memory.', 'gauge', [['', sessions.count()]]);
    const sizes = limiter.size();
    metric('tu_mail_rate_limit_entries', 'Tracked rate-limit keys.', 'gauge', [['{kind="ip"}', sizes.ips], ['{kind="account"}', sizes.accounts]]);
    metric('tu_mail_uptime_seconds', 'Seconds since the server started.', 'gauge', [['', Math.round((Date.now() - started) / 1000)]]);
    metric('tu_mail_heap_bytes', 'Node.js heap in use.', 'gauge', [['', process.memoryUsage().heapUsed]]);
    return lines.join('\n') + '\n';
  };

  const handler = (req, res) => {
    if (!token) return res.status(404).json({ error: 'Not found' });
    if (!authorised(req.headers.authorization)) { res.set('WWW-Authenticate', 'Bearer'); return res.status(401).json({ error: 'Unauthorized' }); }
    res.type('text/plain; version=0.0.4; charset=utf-8').send(render());
  };

  return { count, observe, handler };
}

module.exports = { create };
