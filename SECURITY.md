# Security

## Supported deployments

TUDa Mail supports two ways of running:

- **Local, single user**: the default. Binds to 127.0.0.1 only.
- **Operator deployment**: one instance behind a TLS-terminating reverse proxy, configured with `PUBLIC_URL` and `TRUST_PROXY`. See "Deploying for other people" in the README.

Not supported: running several instances against the same users, exposing the Node server directly to the internet without TLS, or setting `PUBLIC_URL` to an `http://` address. The server refuses the last of these at startup.

Mailbox passwords are held in server memory while a person is signed in (until sign-out or `SESSION_DAYS` without a visit). With `SESSION_STORE=file` they are also written to disk, encrypted with AES-256-GCM; the key is `SESSION_SECRET`. They are never logged or sent anywhere except the configured university mail servers. Keep it that way in any change you propose.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"), or email fahim.haque@stud.tu-darmstadt.de. Do not open public issues for security problems. Expect an acknowledgement within a few days. Please include the version or commit, the deployment mode and steps to reproduce.

## Hardening checklist for operators

- Serve only over HTTPS and keep HSTS on (it is automatic with an `https` `PUBLIC_URL`).
- Set `TRUST_PROXY` to the true number of proxies; never trust forwarding headers from the open internet.
- Run as the unprivileged user (the Docker image does), restrict who can read the process memory, disable core dumps.
- Put `TU_MAIL_DATA_DIR` on persistent storage readable only by the service account, and set `SESSION_SECRET` (kept outside that volume) when you use `SESSION_STORE=file`.
- Limit SSH to known addresses, use key-only login and turn on automatic security updates.
- Run `npm audit` and rebuild the image regularly.
- Ship the JSON logs somewhere with a defined retention period.
