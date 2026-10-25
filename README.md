# TUDa Mail

Open-source webmail client for TU Darmstadt mailboxes (MIT). It talks to the university's IMAP and SMTP servers on the user's behalf. It can run on one machine for one person, or be deployed by an operator (for example the HRZ) for many users.

Features: folders, search, threads, compose/reply/forward, attachments, drafts, move/archive/delete, calendar invitations, contacts and signatures. Mail actions operate on the real mailbox after sign-in. Background push notifications are not included.

Calendar: a month and agenda view at `/calendar.html` with events you create or add from an invitation ("Add to calendar" in the invitation dialog; reading an invitation never adds it). Repeating events are expanded, a cancellation removes the event, and the whole calendar downloads as one `.ics` file. Notifications: optional desktop notifications for new mail while a Mail tab is open (off by default; "count only" or "sender and subject"), chosen per browser.

Mail tools: search filters (sender, recipient, subject, date range, attachment, flagged) with saved searches, undo send (a cancellable pause of 0 to 30 seconds before a message is submitted), reminders for messages, phishing hints (look-alike sender domains, mismatched or disguised links, display-name tricks, different reply-to), send-as addresses, export of a message as `.eml`, and translation of a message to English. Saved searches, reminders and the undo delay are stored in the browser, per account; nothing about them is kept on the server.

Interface: English and German (follows the browser language, switchable in the account menu or on the sign-in page), keyboard shortcuts (press `?` for the list), print view for the open message, skip link, labelled landmarks and visible keyboard focus, installable as an app (offline shell only; mail is never cached), and operator branding.

## Quick start (local, one user)

Requires Node.js 20 or later.

```bash
npm install
npm start
```

Open http://127.0.0.1:3210 and sign in with your full email address, TU-ID (not the email) and password. In this mode the server binds to 127.0.0.1 only and refuses requests addressed to any other host.

## Deploying for other people (operator guide)

TUDa Mail is built to run as **one instance** behind a TLS-terminating reverse proxy.

### Settings

All settings are environment variables (or a `.env` file; never put passwords in it). See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public origin, for example `https://mail.example.edu`. Setting it switches on deployment mode: the server answers only to this host, requires this exact `Origin` on state-changing requests, marks the session cookie `Secure` and sends HSTS. Must be `https` (except for localhost). |
| `TRUST_PROXY` | Number of reverse proxies in front of the server (usually `1`), or an IP/CIDR list. Needed so per-client login limits see real client addresses. `true` is rejected on purpose. |
| `BIND_HOST`, `PORT` | Listen address and port. Defaults: `0.0.0.0` when `PUBLIC_URL` is set, otherwise `127.0.0.1`; port `3210`. |
| `MAIL_EMAIL_DOMAIN` | Only addresses on this domain (and subdomains) may sign in. Default `tu-darmstadt.de`. |
| `MAIL_PROFILES` | JSON replacing the built-in student mailbox (`imap.stud.tu-darmstadt.de`) with other IMAP hosts. The first entry, or `student`, is used. |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_*_SECURE` | Mail servers. Defaults point at TU Darmstadt student mail; both connections verify TLS certificates. |
| `TU_MAIL_DATA_DIR` | Directory for signatures, contacts and send-attempt records. Default `./data`. |
| `LOGIN_IP_PER_MINUTE` | Login requests allowed per client address per minute. Default 10. |
| `LOGIN_ACCOUNT_FAILURES`, `LOGIN_ACCOUNT_WINDOW_MINUTES` | Failed sign-ins allowed per mailbox inside the window. Defaults 5 and 15. |
| `MAX_SESSIONS` | Upper bound on concurrent sessions. Default 2000. Further sign-ins get a "busy" response. |
| `TU_MAIL_LOG=off` | Disable the JSON log (mainly for tests). |
| `BRAND_NAME`, `BRAND_PRIMARY_COLOR`, `BRAND_HELP_URL`, `BRAND_FOOTER` | Name (max 40 characters), colour (`#rrggbb`), https help link and footer text shown on the pages and in the install manifest. Invalid values stop the server at startup. |
| `BRAND_LOGO` | File name of a logo (`.svg`, `.png`, `.jpg`, `.webp`, max 512 KB) placed in `<TU_MAIL_DATA_DIR>/brand/`. |
| `TRANSLATE_URL` | Address of a [LibreTranslate](https://libretranslate.com)-compatible server, for example your own installation. Without it the server never sends message text anywhere. Must be `https` (or localhost; `TRANSLATE_ALLOW_HTTP=true` permits a trusted internal `http` address). Optional: `TRANSLATE_API_KEY`, `TRANSLATE_TIMEOUT_SECONDS` (default 20). |
| `METRICS_TOKEN` | At least 16 characters. Turns on `GET /metrics` (Prometheus text format), which then requires `Authorization: Bearer <token>`. Without it the endpoint answers 404. The request must carry the public host name in its `Host` header. Metrics hold counts only: no addresses, paths or user data. |

### Docker

```bash
docker build -t tu-mail .
docker run -d --name tu-mail --restart unless-stopped \
  -e PUBLIC_URL=https://mail.example.edu -e TRUST_PROXY=1 \
  -v tu-mail-data:/data -p 127.0.0.1:3210:3210 tu-mail
```

The image runs as an unprivileged user, keeps its data in `/data`, and has a health check on `/api/health`.

### Reverse proxy

Terminate TLS in front of the container and forward the original `Host` header. Example for nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name mail.example.edu;
  client_max_body_size 30m;           # messages with attachments, up to 20 MB of files
  location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Run exactly one instance

Sessions are kept in the memory of the server process, together with the mailbox password of each signed-in user. This is deliberate: nothing secret is written to disk or to a shared store such as Redis. The consequences are that all traffic must reach the same process (no load balancing across instances, no sticky-session workaround), and a restart signs everyone out. Users simply sign in again. Shutdown on `SIGTERM` is graceful.

### Monitoring and logs

`GET /api/health` returns `{"ok":true}` and nothing else. The server writes one JSON object per line to stdout: requests (method, path without query string, status, duration, client address), sign-in successes, failures and throttling, and server errors. Users are identified by a 12-character hash of their address. Passwords, cookies, request bodies, query strings, folder names and mail content are never logged. Collect the output with your usual log pipeline and set your own retention.

## Threat model and privacy

**What the server holds.** For each signed-in user: the mailbox password and profile, in process memory, for at most eight hours, removed on sign-out, expiry or restart. On disk, under `TU_MAIL_DATA_DIR`: the user's signature, contacts, send-as addresses and calendar events (events the person created, plus invitations they chose to add, kept as iCalendar text in plain files; the data directory therefore needs the same protection as the mail itself), and short records that stop a retried send from submitting a message twice (a hash of the message and the delivery result, not the message itself). Mailbox content is fetched live from the university servers and is not stored by TUDa Mail; the browser keeps what it displays in page memory.

**Translation and privacy.** The Translate button appears only if the browser can translate on the device (the text then never leaves the machine) or the operator configured `TRANSLATE_URL`. In the second case the text of the message being translated, and nothing else, is sent from the server to that translation server, so choose one you trust and run it inside your own network. The server limits each request (300 parts, 30,000 characters) and each person to 40 requests per 10 minutes, and does not log or keep the text.

**Send-as addresses.** A person may save up to five additional addresses on the allowed domain. The message is still submitted through their own authenticated account and carries a `Sender` header naming that account; the server refuses any address that is not saved in that person's settings. Whether the university's mail server accepts a different `From` address is up to its own policy.

**What it defends against.** Cross-site requests (strict `SameSite` cookie, exact `Origin` check on every state-changing request), host-header tricks (single allowed host), clickjacking (`frame-ancestors 'none'`), script injection (a CSP with `script-src 'self'`, no inline scripts, sanitised HTML mail rendered in a sandboxed frame), password guessing (per-address and per-account throttling) and resource exhaustion at sign-in (session cap, 1 MB JSON limit, attachment limits). Remote images in mail are loaded only after the reader asks.

**What it does not defend against.** Anyone who can read the server's memory (a root compromise, a core dump, a debugger) can read the passwords of signed-in users; protect the host accordingly and disable core dumps. A malicious reverse proxy sees credentials, as TLS ends there. Per-account throttling means someone can deliberately lock out a known address for the window; the lock covers sign-in through this service only, not the mailbox itself. The login throttles are in memory, so a restart resets them.

**Data protection.** The operator is the controller for the processing described above. Document it in your records of processing, inform users, and set a log retention period. The software contains no analytics, trackers or third-party requests.

## Development

```bash
npm test
```

Tests never contact a real mailbox or send mail. `server/demo.cjs` runs the interface against fake data without any mail server.

## License

MIT. See LICENSE. Report vulnerabilities as described in SECURITY.md.
