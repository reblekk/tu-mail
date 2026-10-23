# TU Mail

Standalone local webmail client for TU Darmstadt mailboxes. Open source under the MIT license (see LICENSE and SECURITY.md).

## Run

Requires Node.js 20 or later. Run `npm install`, then `npm start` from this directory. Open http://127.0.0.1:3210. Optional settings: copy `.env.example` to `.env`. Never put passwords in that file.

## Account setup

Default profile is a TU Darmstadt student mailbox. Enter your full email address, TU-ID (not email) and password in the local sign-in page. IMAP: imap.stud.tu-darmstadt.de:993; SMTP: smtp.tu-darmstadt.de:465. Both use TLS with certificate verification. Official source: https://www.hrz.tu-darmstadt.de/support_und_anleitungen/hrz_anleitungen/linux_mailbox/e_mail_einrichten/index.en.jsp (checked 2026-10-22). Other university mailbox types may need different server settings; confirm them with HRZ first.

## Included

Folders, search, threads, compose/reply/forward, attachments, drafts, move/archive/delete, signatures. Mail actions operate on the real mailbox after login. Signatures are stored under data/settings; mailbox contents are cached only in page memory. Passwords are held in server memory in an eight-hour session and removed on logout, expiry or restart. Background push notifications are not included.

## Boundaries

Binds to 127.0.0.1 only. This is a local personal client, not a public hosting deployment. Restarting requires sign-in again. SMTP and live mailbox operations require account verification by the user; automated tests never contact a real mailbox or send mail.

## Validation

Run `npm test` for the automated tests (login/session/logout and origin rejection). They never contact a real mailbox or send mail. Launch with `Start TU Mail.cmd` or `npm start`, and do not run a second copy at the same time.

## License

MIT. See LICENSE.
