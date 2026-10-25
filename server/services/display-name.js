// The name recipients see next to the sender's address. The sign-in name is the TU-ID (something like
// "fh97fijo"), which looks like noise to a reader and to spam filters, so outgoing mail uses a proper
// name: the one the person chose, or one read from an address of the form first.last@...
const NAME_PART = /^[a-zA-ZÀ-ÖØ-öø-ÿ]{2,30}$/;
const clean = (value, max = 80) => String(value ?? '').replace(/[\u0000-\u001f\u007f"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// "fahim.haque@stud.tu-darmstadt.de" -> "Fahim Haque". Anything that does not look like words
// separated by dots, dashes or underscores (an ID, initials plus digits) gives "", meaning "no name".
function fromEmail(email) {
  const local = String(email || '').split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || !parts.every((p) => NAME_PART.test(p))) return '';
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

// The person's own choice wins; otherwise the name read from the address; otherwise none.
function forPerson(email, chosen) {
  return clean(chosen) || fromEmail(email);
}

module.exports = { fromEmail, forPerson, clean };
