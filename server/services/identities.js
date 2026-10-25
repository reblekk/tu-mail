// Send-as addresses: extra "From" identities a person has saved. The message is still submitted over
// their own authenticated account (envelope sender unchanged, a Sender header names the account), and
// an address can only be used if it is on the allowed sign-in domain and saved in that person's settings.
const MAX_IDENTITIES = 5;
const ADDRESS = /^[-.\w+]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f"<>]/g, ' ').replace(/\s+/g, ' ').trim();

// Returns { identities } or throws a 400 describing the first problem.
function sanitize(list, { ownAddress, isAllowed }) {
  if (!Array.isArray(list)) throw Object.assign(new Error('Identities must be a list.'), { status: 400 });
  if (list.length > MAX_IDENTITIES) throw Object.assign(new Error('You can save up to ' + MAX_IDENTITIES + ' send-as addresses.'), { status: 400 });
  const seen = new Set([String(ownAddress).toLowerCase()]);
  const identities = [];
  for (const item of list) {
    const address = clean(item && item.address).toLowerCase();
    if (!ADDRESS.test(address)) throw Object.assign(new Error('"' + address.slice(0, 80) + '" is not a valid email address.'), { status: 400 });
    if (!isAllowed(address)) throw Object.assign(new Error(address + ' is not on a domain this service allows.'), { status: 400 });
    if (seen.has(address)) continue;
    seen.add(address);
    identities.push({ name: clean(item.name).slice(0, 80), address });
  }
  return { identities };
}

// Picks the From for a message: the account itself unless the request names a saved identity.
function resolve(saved, requested, own) {
  const wanted = clean(requested).toLowerCase();
  if (!wanted || wanted === String(own.address).toLowerCase()) return { name: own.name || '', address: own.address };
  const hit = (saved || []).find((i) => i.address === wanted);
  if (!hit) throw Object.assign(new Error('That send-as address is not saved in your settings.'), { status: 400 });
  return { name: hit.name || own.name || '', address: hit.address };
}

module.exports = { sanitize, resolve, MAX_IDENTITIES };
