# Deploying TUDa Mail on a small Linux server (Azure for Students, or any VPS)

Needs: an Ubuntu 24.04 server with a public IP, a domain name (tuda-mail.de), about 1 GB RAM.

**Order matters: create the server, test that it can reach the university mail server, and only then go on.**

1. Create the server (Azure: Virtual machine, Ubuntu Server 24.04 LTS, a small size such as B2ats_v2 (check which sizes your subscription allows), SSH key, open ports 22, 80, 443,
   auto-shutdown OFF, static public IP). Afterwards limit port 22 to your own IP in the network security group.
2. Connect: `ssh -i key.pem azureuser@SERVER_IP`
3. Test: `openssl s_client -connect imap.stud.tu-darmstadt.de:993 </dev/null` must print a certificate.
   If it hangs, stop: this server cannot reach the student mail server. Delete it and ask HRZ.
4. Install Docker: `sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git`
   then `sudo usermod -aG docker $USER`, log out and back in.
5. Get the code: `git clone https://github.com/reblekk/tu-mail.git && cd tu-mail/deploy`
6. Point DNS: an A record for tuda-mail.de at SERVER_IP. Check with `nslookup tuda-mail.de`.
7. `cp .env.example .env` (edit PUBLIC_URL if the name differs, and the name in `Caddyfile`). Set `SESSION_SECRET` to a long random value, for example `openssl rand -hex 32`.
8. Start: `docker compose up -d --build`
9. Check: open https://tuda-mail.de/api/health , expect `{"ok":true}`. Then sign in.

## Day to day
- Logs: `docker compose logs -f app` (one JSON line per event; no passwords or mail content)
- Update: `git pull && docker compose up -d --build`
- Backup of signatures, contacts and push keys (`push/vapid.json`; losing it breaks existing alert subscriptions):
  `docker run --rm -v tuda-mail_tu-mail-data:/data -v "$PWD":/backup alpine tar czf /backup/data-$(date +%F).tgz -C /data .`
- Restart: `docker compose restart app` (with `SESSION_STORE=file`, as in the example `.env`, people stay signed in)
- Keep the server updated: `sudo apt-get update && sudo apt-get -y upgrade`, and enable automatic security updates
  (`sudo apt-get install -y unattended-upgrades`).

## Before other people use it
Start with yourself only. A public service for German university accounts needs an Impressum and a privacy notice,
and the university's IT department should know about it. See docs/hrz-overview.md.
