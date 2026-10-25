// Only HRZ-documented destinations are allowed; clients cannot supply arbitrary hosts.
// Set by the operator, never by clients: MAIL_PROFILES (JSON, same shape as below) replaces the
// defaults, and MAIL_EMAIL_DOMAIN restricts which addresses may sign in.
const DEFAULT_PROFILES = {
  student: { host: 'imap.stud.tu-darmstadt.de', label: 'Student' },
};
const PROFILES = process.env.MAIL_PROFILES ? JSON.parse(process.env.MAIL_PROFILES) : DEFAULT_PROFILES;
const EMAIL_DOMAIN = (process.env.MAIL_EMAIL_DOMAIN || 'tu-darmstadt.de').toLowerCase();
function allowedEmail(email) {
  const match = /^[-.\w+]+@([a-z0-9.-]+)$/i.exec(email);
  const domain = match && match[1].toLowerCase();
  return Boolean(domain) && (domain === EMAIL_DOMAIN || domain.endsWith('.' + EMAIL_DOMAIN));
}
const DEFAULT_PROFILE = 'student' in PROFILES ? 'student' : Object.keys(PROFILES)[0];
function accountProfile({ username, profile = DEFAULT_PROFILE }) {
  const selected = Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : null;
  if (!selected) throw Object.assign(new Error('Choose a supported mailbox type.'), { status: 400 });
  return { profile, imapHost: selected.host, imapUsername: username, smtpUsername: username };
}
module.exports = { accountProfile, allowedEmail, PROFILES };
