// Turns the list request into an IMAP SEARCH. Kept apart from the IMAP code so the rules are easy to test.
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
}
function day(value) {
  const v = String(value ?? '').trim();
  if (!DATE.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

// Reads the filter fields of a request (strings from the query string) into a clean object.
function parseFilters(source = {}) {
  const filters = {};
  for (const key of ['from', 'to', 'subject']) { const v = text(source[key]); if (v) filters[key] = v; }
  const since = day(source.since), before = day(source.before);
  if (since) filters.since = since;
  if (before) filters.before = before;
  if (source.flagged === '1' || source.flagged === true) filters.flagged = true;
  if (source.attach === '1' || source.attach === true) filters.attach = true;
  return filters;
}

function hasFilters(filters = {}) {
  return Object.keys(filters).length > 0;
}

// Returns an imapflow search object, or null when nothing narrows the folder.
function buildQuery({ q = '', scope = 'headers', unreadOnly = false, filters = {} } = {}) {
  const query = {};
  if (unreadOnly) query.seen = false;
  if (q) {
    const terms = [{ from: q }, { to: q }, { subject: q }];
    if (scope === 'all') terms.push({ body: q });
    query.or = terms;
  }
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (filters.subject) query.subject = filters.subject;
  if (filters.since) query.since = filters.since;
  // IMAP BEFORE is exclusive; "before" in the form means "up to and including that day".
  if (filters.before) query.before = new Date(filters.before.getTime() + 86400000);
  if (filters.flagged) query.flagged = true;
  // IMAP cannot ask "has an attachment"; mail with files is almost always multipart/mixed.
  if (filters.attach) query.header = { 'content-type': 'multipart/mixed' };
  return Object.keys(query).length ? query : null;
}

module.exports = { buildQuery, parseFilters, hasFilters };
