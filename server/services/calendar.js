// A small personal calendar. Events are kept as iCalendar text per person (so recurrences, time zones
// and later changes from the organizer keep working) and expanded into occurrences when a range is
// asked for. Nothing here talks to the mailbox: events come from invitations the person chooses to add
// or from events they create.
const ICAL = require('ical.js');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_EVENTS = 2000;
const MAX_ICS_BYTES = 512 * 1024;
const MAX_RANGE_DAYS = 100;
const MAX_OCCURRENCES_PER_EVENT = 400;
const dir = () => path.join(process.env.TU_MAIL_DATA_DIR || path.join(__dirname, '../../data'), 'calendar');
const fileFor = (email) => path.join(dir(), crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex') + '.json');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---- storage: one JSON file per person, writes queued so two requests cannot overwrite each other
const queues = new Map();
async function read(email) {
  try { const v = JSON.parse(await fs.readFile(fileFor(email), 'utf8')); return Array.isArray(v.events) ? v : { events: [] }; }
  catch (e) { if (e.code === 'ENOENT') return { events: [] }; throw e; }
}
function update(email, change) {
  const key = String(email).toLowerCase();
  const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const data = await read(email);
    const result = await change(data);
    await fs.mkdir(dir(), { recursive: true });
    const target = fileFor(email), tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, target);
    return result;
  });
  queues.set(key, run);
  return run;
}

// ---- reading an event
function parseIcs(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  if (Buffer.byteLength(text) > MAX_ICS_BYTES) throw bad('This calendar file is too large.');
  let calendar;
  try { calendar = new ICAL.Component(ICAL.parse(text)); } catch { throw bad('This is not a valid calendar file.'); }
  if (calendar.name !== 'vcalendar') throw bad('No calendar found.');
  const vevents = calendar.getAllSubcomponents('vevent');
  if (!vevents.length) throw bad('There is no event in this file.');
  return { calendar, vevents, method: String(calendar.getFirstPropertyValue('method') || '').toUpperCase() };
}

const iso = (t) => (t.isDate ? t.toString() : t.toJSDate().toISOString());
function summaryOf(vevent) {
  const event = new ICAL.Event(vevent);
  if (!event.startDate) throw bad('The event has no start time.');
  const status = String(vevent.getFirstPropertyValue('status') || '').toUpperCase();
  return {
    uid: String(event.uid || ''),
    recurrenceId: vevent.getFirstPropertyValue('recurrence-id') ? vevent.getFirstPropertyValue('recurrence-id').toString() : '',
    title: String(event.summary || 'Event').slice(0, 300),
    location: String(event.location || '').slice(0, 300),
    description: String(event.description || '').slice(0, 5000),
    allDay: event.startDate.isDate,
    status: status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    recurring: event.isRecurring(),
  };
}
const idFor = (uid, recurrenceId) => crypto.createHash('sha256').update(uid + '\n' + recurrenceId).digest('hex').slice(0, 24);

// Everything one stored entry shows between from (inclusive) and to (exclusive), as JS dates.
function occurrences(entry, from, to) {
  let parsed;
  try { parsed = parseIcs(entry.ics); } catch { return []; }
  const found = [];
  const master = parsed.vevents.find((v) => !v.hasProperty('recurrence-id')) || parsed.vevents[0];
  const event = new ICAL.Event(master);
  const push = (startDate, endDate) => {
    const start = startDate.toJSDate(), end = endDate ? endDate.toJSDate() : start;
    if (end < from && start < from) return;
    if (start >= to) return;
    found.push({
      id: entry.id, title: entry.title, location: entry.location, status: entry.status, source: entry.source,
      allDay: startDate.isDate, start: iso(startDate), end: iso(endDate || startDate),
    });
  };
  if (event.isRecurring()) {
    const it = event.iterator();
    let next, count = 0;
    while ((next = it.next()) && count < MAX_OCCURRENCES_PER_EVENT) {
      count += 1;
      if (next.toJSDate() >= to) break;
      const detail = event.getOccurrenceDetails(next);
      push(detail.startDate, detail.endDate);
    }
  } else {
    push(event.startDate, event.endDate);
  }
  return found;
}

function entryFrom(vevent, ics, source) {
  const s = summaryOf(vevent);
  if (!s.uid) throw bad('The event has no identifier.');
  return { id: idFor(s.uid, s.recurrenceId), uid: s.uid, title: s.title, location: s.location, description: s.description, status: s.status, allDay: s.allDay, recurring: s.recurring, source, ics, addedAt: Date.now() };
}

// Wraps one VEVENT (plus the time zones it uses) back into a calendar file.
function singleEventIcs(calendar, vevent) {
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.updatePropertyWithValue('version', '2.0');
  out.updatePropertyWithValue('prodid', '-//TU Mail//Calendar//EN');
  const clone = (c) => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));
  for (const zone of calendar.getAllSubcomponents('vtimezone')) out.addSubcomponent(clone(zone));
  out.addSubcomponent(clone(vevent));
  return out.toString();
}

// ---- operations
// Adds the event(s) of an invitation. A cancellation removes the event instead.
async function addInvitation(email, content) {
  const { calendar, vevents, method } = parseIcs(content);
  return update(email, (data) => {
    const result = { added: 0, updated: 0, removed: 0, id: null };
    for (const vevent of vevents) {
      const probe = summaryOf(vevent);
      const entry = entryFrom(vevent, singleEventIcs(calendar, vevent), 'invitation');
      const index = data.events.findIndex((e) => e.id === entry.id);
      if (method === 'CANCEL' || probe.status === 'cancelled') {
        if (index >= 0) { data.events.splice(index, 1); result.removed += 1; }
        continue;
      }
      if (index >= 0) { entry.addedAt = data.events[index].addedAt; data.events[index] = entry; result.updated += 1; }
      else { if (data.events.length >= MAX_EVENTS) throw bad('The calendar is full. Delete some events first.'); data.events.push(entry); result.added += 1; }
      result.id = entry.id;
    }
    return result;
  });
}

function validDate(value, allDay) {
  const v = String(value ?? '');
  if (allDay) {
    // Round-trip, so a date that does not exist (30 February) is refused instead of rolling into March.
    const d = new Date(v + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('Enter a valid date.');
    return v;
  }
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(d.getTime())) throw bad('Enter a valid date and time.');
  return d;
}
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// A new event typed in by the person. start/end are ISO strings (or YYYY-MM-DD for all-day events).
async function create(email, fields) {
  const title = oneLine(fields.title, 300);
  if (!title) throw bad('Give the event a title.');
  const allDay = fields.allDay === true;
  const start = validDate(fields.start, allDay);
  const end = fields.end ? validDate(fields.end, allDay) : null;
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('version', '2.0');
  vcal.updatePropertyWithValue('prodid', '-//TU Mail//Calendar//EN');
  const vevent = new ICAL.Component('vevent');
  const uid = crypto.randomUUID() + '@tu-mail';
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  vevent.updatePropertyWithValue('summary', title);
  if (allDay) {
    const s = ICAL.Time.fromDateString(start);
    const e = end ? ICAL.Time.fromDateString(end) : s.clone();
    if (e.compare(s) < 0) throw bad('The event cannot end before it starts.');
    e.adjust(1, 0, 0, 0); // DTEND is exclusive for all-day events
    vevent.updatePropertyWithValue('dtstart', s);
    vevent.updatePropertyWithValue('dtend', e);
  } else {
    const endDate = end || new Date(start.getTime() + 3600000);
    if (endDate < start) throw bad('The event cannot end before it starts.');
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(start, true));
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(endDate, true));
  }
  const location = oneLine(fields.location, 300), description = String(fields.description ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 5000);
  if (location) vevent.updatePropertyWithValue('location', location);
  if (description) vevent.updatePropertyWithValue('description', description);
  vcal.addSubcomponent(vevent);
  const ics = vcal.toString();
  const entry = entryFrom(vevent, ics, 'manual');
  return update(email, (data) => {
    if (data.events.length >= MAX_EVENTS) throw bad('The calendar is full. Delete some events first.');
    data.events.push(entry);
    return { id: entry.id };
  });
}

async function remove(email, id) {
  return update(email, (data) => {
    const index = data.events.findIndex((e) => e.id === id);
    if (index < 0) throw bad('Event not found.', 404);
    data.events.splice(index, 1);
    return { ok: true };
  });
}

// Occurrences between two dates (YYYY-MM-DD, "to" exclusive), sorted by start.
async function list(email, fromDay, toDay) {
  const from = new Date(fromDay + 'T00:00:00Z'), to = new Date(toDay + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw bad('Give from and to as YYYY-MM-DD.');
  if (to <= from) throw bad('"to" must be after "from".');
  if ((to - from) / 86400000 > MAX_RANGE_DAYS) throw bad('Ask for at most ' + MAX_RANGE_DAYS + ' days at a time.');
  const data = await read(email);
  // Pad by a day so events near the edge are not lost to time zone differences; the browser trims.
  const lo = new Date(from.getTime() - 86400000), hi = new Date(to.getTime() + 86400000);
  const out = [];
  for (const entry of data.events) out.push(...occurrences(entry, lo, hi));
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

async function details(email, id) {
  const entry = (await read(email)).events.find((e) => e.id === id);
  if (!entry) throw bad('Event not found.', 404);
  return { id: entry.id, title: entry.title, location: entry.location, description: entry.description, status: entry.status, allDay: entry.allDay, recurring: entry.recurring, source: entry.source };
}

// Every event as one calendar file, for importing elsewhere.
async function exportIcs(email) {
  const data = await read(email);
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.updatePropertyWithValue('version', '2.0');
  out.updatePropertyWithValue('prodid', '-//TU Mail//Calendar//EN');
  out.updatePropertyWithValue('calscale', 'GREGORIAN');
  const zones = new Set();
  const clone = (c) => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));
  for (const entry of data.events) {
    let parsed;
    try { parsed = parseIcs(entry.ics); } catch { continue; }
    for (const zone of parsed.calendar.getAllSubcomponents('vtimezone')) {
      const id = String(zone.getFirstPropertyValue('tzid'));
      if (!zones.has(id)) { zones.add(id); out.addSubcomponent(clone(zone)); }
    }
    for (const vevent of parsed.vevents) out.addSubcomponent(clone(vevent));
  }
  return out.toString();
}

module.exports = { addInvitation, create, remove, list, details, exportIcs, parseIcs, MAX_EVENTS, MAX_RANGE_DAYS };
