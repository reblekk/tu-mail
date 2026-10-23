const ICAL = require('ical.js');
const addressOf = value => String(value || '').replace(/^mailto:/i, '');
const error = message => Object.assign(new Error(message), { status: 400 });
function parse(content, email) {
  if (content.length > 512 * 1024) throw error('This invitation is too large to preview.');
  let calendar;
  try { calendar = new ICAL.Component(ICAL.parse(content.toString('utf8'))); } catch { throw error('This attachment is not a valid calendar invitation.'); }
  if (calendar.name !== 'vcalendar') throw error('No calendar found.');
  const events = calendar.getAllSubcomponents('vevent');
  if (events.length !== 1) throw error('This file contains multiple events. Download it to open in your calendar.');
  const event = events[0];
  const organizer = addressOf(event.getFirstPropertyValue('organizer'));
  const attendee = event.getAllProperties('attendee').find(p => addressOf(p.getFirstValue()).toLowerCase() === email.toLowerCase());
  const when = name => { const prop = event.getFirstProperty(name), value = prop?.getFirstValue(); return value ? { value: value.toString(), timezone: prop.getParameter('tzid') || (value.isDate ? 'All day' : value.zone?.tzid === 'UTC' ? 'UTC' : 'Local time as supplied') } : null; };
  const method = String(calendar.getFirstPropertyValue('method') || '').toUpperCase();
  const summary = { title: String(event.getFirstPropertyValue('summary') || 'Meeting'), location: String(event.getFirstPropertyValue('location') || ''), description: String(event.getFirstPropertyValue('description') || '').slice(0, 10000), start: when('dtstart'), end: when('dtend'), organizer, method, recurring: Boolean(event.getFirstProperty('rrule')), canRespond: method === 'REQUEST' && Boolean(attendee) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(organizer) && Boolean(event.getFirstPropertyValue('uid')) };
  return { calendar, event, attendee, summary };
}
function inspect(content, email) { return parse(content, email).summary; }
function reply(content, email, status) {
  if (!['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(status)) throw error('Choose a valid meeting response.');
  const { calendar, event, attendee, summary } = parse(content, email);
  if (!summary.canRespond) throw error('This invitation cannot be answered for the current account.');
  const result = new ICAL.Component(['vcalendar', [], []]);
  result.updatePropertyWithValue('version', '2.0'); result.updatePropertyWithValue('prodid', '-//TU Mail//Meeting reply//EN'); result.updatePropertyWithValue('method', 'REPLY');
  const clone = p => new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON())));
  const response = new ICAL.Component(['vevent', [], []]);
  for (const name of ['uid', 'sequence', 'recurrence-id', 'dtstart', 'dtend', 'summary', 'organizer']) { const p = event.getFirstProperty(name); if (p) response.addProperty(clone(p)); }
  response.updatePropertyWithValue('dtstamp', ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone));
  const attending = clone(attendee); attending.setParameter('partstat', status); attending.setParameter('rsvp', 'FALSE'); response.addProperty(attending);
  for (const zone of calendar.getAllSubcomponents('vtimezone')) result.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(zone.toJSON()))));
  result.addSubcomponent(response);
  return { to: summary.organizer, subject: `${status === 'ACCEPTED' ? 'Accepted' : status === 'DECLINED' ? 'Declined' : 'Tentative'}: ${summary.title}`, text: `Meeting response: ${status.toLowerCase()}.`, filename: 'meeting-response.ics', content: result.toString() };
}
module.exports = { inspect, reply };
