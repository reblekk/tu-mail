// Operator branding from the environment. Everything is validated here, because the values end up in
// CSS variables, link targets and image sources of every user's page.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  name: 'TU Mail',
  color: '#b90f22',
  helpUrl: 'https://www.hrz.tu-darmstadt.de/support_und_anleitungen/hrz_anleitungen/linux_mailbox/e_mail_einrichten/index.en.jsp',
  footer: 'Independent local mail client · Not an official TU Darmstadt service',
};
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_LOGO_BYTES = 512 * 1024;

function mix(hex, target, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (target - c) * amount));
  return '#' + channels.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function load(env = process.env) {
  const problems = [];
  const text = (value, fallback, max) => {
    const v = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return v && v.length <= max ? v : fallback;
  };
  const name = text(env.BRAND_NAME, DEFAULTS.name, 40);
  const footer = env.BRAND_FOOTER === undefined ? DEFAULTS.footer : text(env.BRAND_FOOTER, DEFAULTS.footer, 200);

  let color = DEFAULTS.color;
  if (env.BRAND_PRIMARY_COLOR) {
    if (/^#[0-9a-f]{6}$/i.test(env.BRAND_PRIMARY_COLOR)) color = env.BRAND_PRIMARY_COLOR.toLowerCase();
    else problems.push('BRAND_PRIMARY_COLOR must look like #b90f22.');
  }

  let helpUrl = DEFAULTS.helpUrl;
  if (env.BRAND_HELP_URL) {
    try {
      const u = new URL(env.BRAND_HELP_URL);
      if (u.protocol === 'https:') helpUrl = u.href; else problems.push('BRAND_HELP_URL must be an https URL.');
    } catch { problems.push('BRAND_HELP_URL is not a valid URL.'); }
  }

  let logo = null;
  if (env.BRAND_LOGO) {
    const dir = path.resolve(env.TU_MAIL_DATA_DIR || path.join(__dirname, '../../data'), 'brand');
    const file = path.resolve(dir, env.BRAND_LOGO);
    const type = LOGO_TYPES[path.extname(file).toLowerCase()];
    if (path.dirname(file) !== dir) problems.push('BRAND_LOGO must be a file name inside the brand folder of the data directory.');
    else if (!type) problems.push('BRAND_LOGO must be .svg, .png, .jpg or .webp.');
    else if (!fs.existsSync(file)) problems.push('BRAND_LOGO file not found in the brand folder of the data directory.');
    else if (fs.statSync(file).size > MAX_LOGO_BYTES) problems.push('BRAND_LOGO is larger than 512 KB.');
    else logo = { file, type };
  }
  if (problems.length) throw new Error(problems.join(' '));

  return {
    name, footer, color, helpUrl, logo,
    colorDark: mix(color, 0, 0.3),
    colorTint: mix(color, 255, 0.92),
  };
}

function publicView(brand) {
  return {
    name: brand.name, footer: brand.footer, helpUrl: brand.helpUrl,
    color: brand.color, colorDark: brand.colorDark, colorTint: brand.colorTint,
    logoUrl: brand.logo ? '/brand/logo' : null,
  };
}

function manifest(brand) {
  return {
    name: brand.name,
    short_name: brand.name.length > 12 ? brand.name.slice(0, 12) : brand.name,
    description: 'Webmail',
    start_url: '/mail.html',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: brand.color,
    icons: [
      { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/assets/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}

module.exports = { load, publicView, manifest, DEFAULTS };
