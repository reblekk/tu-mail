// Only HRZ-documented destinations are allowed; clients cannot supply arbitrary hosts.
const PROFILES = {
  student: { host: 'imap.stud.tu-darmstadt.de', label: 'Student' },
  staff: { host: 'mail.tu-darmstadt.de', label: 'Staff / Groupware' },
  linux: { host: 'mailbox.tu-darmstadt.de', label: 'Staff / Linux mailbox' },
};
function accountProfile({ email, username, profile = 'student' }) {
  const selected = PROFILES[profile];
  if (!selected) throw Object.assign(new Error('Choose a supported mailbox type.'), { status: 400 });
  const domain = email.split('@')[1];
  const imapUsername = profile === 'staff' ? `ADS\\${username}` : profile === 'linux' ? `${username}@${domain}` : username;
  return { profile, imapHost: selected.host, imapUsername, smtpUsername: username };
}
module.exports = { accountProfile, PROFILES };
