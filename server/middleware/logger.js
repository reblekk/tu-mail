// One JSON object per line on stdout. Only fixed fields are logged: never request bodies, query strings
// (they carry folder names), cookies, passwords or mail content. People are identified by a short hash.
const crypto = require('node:crypto');

function who(email) {
  return email ? crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 12) : undefined;
}

function create({ enabled = true, sink = line => process.stdout.write(line + '\n') } = {}) {
  const log = (event, fields = {}) => {
    if (!enabled) return;
    sink(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
  };
  const requests = (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => log('request', {
      method: req.method,
      path: (req.originalUrl || req.url).split('?')[0],
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      ip: req.ip,
    }));
    next();
  };
  return { log, requests, who };
}

module.exports = { create, who };
