# Before going public: checklist

Tick these off in order. The first block can stop the project; the rest is housekeeping.

## 1. Permission and law (do first)
- [ ] Write to the university IT department (HRZ): `docs/hrz-email.md`. Wait for the answer.
- [ ] Logo and name: the sign-in page shows the TU Darmstadt logo and "TUDa". Get permission, or replace `client/assets/tu-logo.svg` and the name (`BRAND_NAME`).
- [ ] Fill in the yellow `[[...]]` parts in `client/impressum.html`, `client/datenschutz.html` and `client/terms.html`. Check that none are left:
  `grep -rn "\[\[" client/*.html`
- [ ] Have the three pages checked (student legal advice, or a lawyer).
- [ ] Confirm the Microsoft data-processing terms for Azure (included in the standard online terms; keep a copy).
- [ ] Decide how long logs are kept and set it up (the privacy page says so).

## 2. Server hardening
- [x] Automatic security updates (done; restarts at 03:30 if needed).
- [ ] Limit SSH (port 22) to your own IP in the Azure network security group `tuda-mail-nsg`.
- [ ] Back up `tuda-mail_key.pem` (password manager or encrypted USB) and delete the copy in Downloads.
- [ ] Back up the data folder now and then (see `deploy/README.md`), including `push/vapid.json`.
- [x] Public IP is Static.
- [x] Azure monthly budget of 15 USD with alerts at 80% and 100%.
- [ ] Set up an uptime check on `https://tuda-mail.de/api/health` (UptimeRobot or similar) with an email alert.

## 3. Capacity and cost
- [ ] The VM (B2ats_v2, 1 GB RAM) fits a few dozen active users. Re-run `tools/load-test.js` and watch memory (`docker stats`) as people join; move to a bigger size before it swaps.
- [ ] Azure for Students credits run for 12 months and renew only while you are a student. Plan what happens afterwards (a small paid VM is about 8 to 15 EUR a month).

## 4. Running it
- [ ] Update the app and `npm audit` every month or so.
- [ ] A way for people to reach you (the imprint address) and a way to remove someone (stop their sign-in; they can also sign out themselves).
- [ ] Decide what you do if the university blocks the server's IP address.
- [ ] Tell people not to reuse their university password anywhere else, and to sign out on shared computers.
