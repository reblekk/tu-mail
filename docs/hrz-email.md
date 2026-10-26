# Email to the university IT department (HRZ)

Send this before inviting many people. Fill in the yellow parts. German first, English below.

**To:** the HRZ contact for e-mail / IT security (see hrz.tu-darmstadt.de; ask the service desk who handles mail clients and IT security)
**Subject:** Anfrage: privater Webmail-Client "TUDa Mail" für Studierende, Zugriff auf imap.stud.tu-darmstadt.de

Guten Tag,

ich bin Student der TU Darmstadt und habe einen freien (Open-Source-)Webmail-Client namens **TUDa Mail** entwickelt. Er läuft unter https://tuda-mail.de und ermöglicht es Studierenden, ihr Postfach im Browser mit modernerer Oberfläche zu nutzen, auch auf dem Smartphone, mit Benachrichtigungen bei neuer Post.

So funktioniert es technisch:
- Beim Anmelden verbindet sich der Server mit `imap.stud.tu-darmstadt.de:993` (IMAP) und `smtp.tu-darmstadt.de:465/587` (SMTP) mit den Zugangsdaten der Person. Nachrichten werden nur live abgerufen und nicht gespeichert.
- Das Passwort liegt nur für die Dauer der Sitzung im Arbeitsspeicher und verschlüsselt (AES-256-GCM) auf dem Server und wird beim Abmelden gelöscht, spätestens nach 30 Tagen ohne Nutzung.
- Alle Verbindungen zu den Mailservern kommen von **einer festen IP-Adresse: 20.91.240.241** (Microsoft Azure, Schweden). Ich möchte nicht, dass diese Adresse durch Schutzmechanismen (Rate-Limits, Sperren bei vielen Anmeldungen) blockiert wird.
- Schutzmaßnahmen: HTTPS, Begrenzung der Anmeldeversuche pro Adresse und Konto, keine Protokollierung von Passwörtern oder Nachrichteninhalten.

Meine Fragen:
1. Ist der Betrieb eines solchen Dienstes, der sich mit Studierenden-Zugangsdaten bei den Mailservern anmeldet, mit den IT-Regeln der Universität vereinbar? Gibt es Auflagen?
2. Kann die IP-Adresse 20.91.240.241 als bekannter Dienst vermerkt (z. B. für Rate-Limits/Sperren freigegeben) werden? Wie viele Anmeldungen pro Minute sind unbedenklich?
3. Gibt es eine bessere Anbindung, z. B. OAuth/Token statt Passwort, oder einen Ansprechpartner für Sicherheitsfragen?
4. Darf ich den Namen "TUDa" und das Logo der Universität verwenden? Ich ersetze sie sonst durch eigene Gestaltung.

Gern zeige ich den Quellcode und beantworte Rückfragen. Ich möchte den Dienst nur mit Ihrem Einverständnis öffentlich bewerben.

Mit freundlichen Grüßen
FAHIM UL HAQUE

---

## English

Hello,

I am a TU Darmstadt student and I built a free, open-source webmail client called **TUDa Mail** (https://tuda-mail.de). Students sign in with their own mailbox credentials; the server connects to `imap.stud.tu-darmstadt.de:993` and `smtp.tu-darmstadt.de:465/587` on their behalf. Messages are fetched live and not stored. The password is kept in memory and encrypted on disk while the person is signed in, deleted at sign-out or after 30 days without use. All connections to your servers come from one fixed IP, **20.91.240.241** (Azure, Sweden).

Questions: (1) Is running a service like this compatible with the university's IT rules, and are there conditions? (2) Can 20.91.240.241 be noted as a known service so it is not blocked by rate limits, and what login rate is acceptable? (3) Is there a better integration (token/OAuth instead of passwords) or a security contact? (4) May I use the name "TUDa" and the logo? Otherwise I will replace them.

I am happy to share the source code and answer questions.

Kind regards,
FAHIM UL HAQUE
