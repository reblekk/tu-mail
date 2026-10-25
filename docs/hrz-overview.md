# TUDa Mail: overview for HRZ

TUDa Mail is an open-source (MIT) web interface for TU Darmstadt mailboxes. It does not replace any HRZ service: it connects to the existing IMAP and SMTP servers with the user's own TU-ID and password, the same way any mail client does. Source: https://github.com/reblekk/tu-mail

## What users get

Folders, search, conversation threads, compose, reply and forward, attachments, drafts, move, archive and delete, calendar-invitation replies, contacts and signatures, in a responsive browser interface.

## How it runs

One Node.js process (or the supplied Docker image) behind the university's reverse proxy with TLS. No database. No dependency on other HRZ systems beyond IMAP and SMTP. Configuration is by environment variables (public URL, proxy trust, mail hosts, login limits); see the README.

Resource needs are small: the server holds only a session record per signed-in user and fetches mail on demand. Mail is not copied or indexed.

## What it stores

| Data | Where | How long |
| --- | --- | --- |
| Mailbox password and profile | Server memory only | Up to 8 hours; removed on sign-out, expiry or restart |
| Signature, contacts, send-as addresses | Data directory, per user | Until the user deletes them |
| Calendar events (created by the user, or invitations they chose to add) | Data directory, per user, as iCalendar text | Until the user deletes them |
| Send-attempt records (message hash and delivery result, to prevent double sends) | Data directory | Small files; can be cleared by the operator |
| Logs: time, method, path, status, duration, client address, hashed user identifier | Standard output | Operator's retention policy |

Never stored or logged: passwords on disk, cookies, request bodies, query strings, folder names, message content. No analytics, tracking or third-party requests.

## Optional features that touch data

- **Translation to English** is off unless HRZ configures a translation server. Browsers that translate on the device never contact it. If configured, only the text of the message being translated goes from the server to that server.
- **Send-as addresses** let a person write from other addresses on the university domain they have saved. Messages are still submitted through their own account.
- **Calendar** keeps only what the person adds. Reading an invitation does not add it.
- **Desktop notifications** work only while a Mail tab is open; the server keeps no credentials in the background. They are offered after sign-in, and the person chooses whether they show only a count or also the sender and subject.
- **Search filters, saved searches, reminders and the undo-send delay** are stored in the user's browser only.

## Security measures

- TLS only in deployment mode (HSTS, `Secure`, `HttpOnly`, `SameSite=Strict` cookie).
- Single allowed host; exact `Origin` check on every state-changing request.
- Content-Security-Policy with `script-src 'self'` and no inline scripts; mail HTML is sanitised and shown in a script-less sandboxed frame; remote pictures are shown by default (each person can switch that off), so a sender can tell that a message was opened.
- Login throttling per client address and per mailbox; capped session count; request size limits.
- Server certificate verification on both IMAP and SMTP connections.
- Automated tests cover the security behaviour; CI also runs a dependency audit and a container build.

## Known limits (stated plainly)

- One instance only. Sessions live in process memory by design, so a restart signs everyone out.
- Anyone with access to the server's memory can read the passwords of currently signed-in users. This is inherent to any webmail that logs in with the user's password; protect the host and disable core dumps.
- Sign-in uses the TU-ID and password directly; there is no SSO or Shibboleth integration. IMAP password authentication would still need the password even with SSO in front.
- Not yet tested against a production HRZ setup, and no independent security review has been done. HRZ's own review would be welcome.

## Questions for HRZ

1. Is a webmail alternative of this kind something HRZ would consider hosting?
2. What does HRZ need for a security and data-protection review (documentation, a data-processing description, a penetration test)?
3. Preferred hosting form (container, VM), reverse proxy setup and log handling?
4. Any requirements on branding, accessibility, languages or supported mailbox types?
5. Who would own updates after deployment: HRZ, the author, or both?

## Contact

Fahim Ul Haque, fahimulczs@gmail.com
