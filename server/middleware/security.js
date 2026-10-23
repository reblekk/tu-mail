const { hostAllowed, expectedOrigin } = require('../config');

// Scripts, connections and frames come only from this origin. The inline-style allowance and the
// remote-image allowance are for the message viewer: it renders sanitised mail in a frame that inherits
// this policy, and shows remote images only after the reader asks for them. Scripts stay locked down.
const csp = config => [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  config.hsts ? "img-src 'self' data: blob: https:" : "img-src 'self' data: blob: https: http:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityMiddleware(config) {
  const policy = csp(config);
  return (req, res, next) => {
    res.set('Content-Security-Policy', policy);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (config.hsts) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    const host = req.headers.host || '';
    if (!hostAllowed(config, host)) return res.status(403).json({ error: config.publicUrl ? 'Unknown host' : 'Local access only' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== expectedOrigin(config, host)) {
      return res.status(403).json({ error: 'Request origin rejected' });
    }
    next();
  };
}

module.exports = { securityMiddleware, csp };
