const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const root = process.env.TU_MAIL_DATA_DIR || path.join(__dirname, '../../data');
const file = account => path.join(root, 'contacts', crypto.createHash('sha256').update(account).digest('hex') + '.json');
const queues = new Map();
async function list(account) {
  try { return JSON.parse(await fs.readFile(file(account), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function modify(account, operation) {
  const next = (queues.get(account) || Promise.resolve()).catch(() => {}).then(async () => {
    const contacts = await list(account), result = operation(contacts);
    await fs.mkdir(path.dirname(file(account)), { recursive: true });
    const temporary = file(account) + '.' + crypto.randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(contacts));
    await fs.rename(temporary, file(account)); return result;
  });
  queues.set(account, next); next.finally(() => { if (queues.get(account) === next) queues.delete(account); }).catch(() => {}); return next;
}
function save(account, data) {
  const address = String(data.address || '').trim().toLowerCase(), name = String(data.name || '').trim().slice(0, 160);
  if (!/^[^\s@<>;,\r\n]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(address) || address.length > 254) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  return modify(account, contacts => {
    let entry = contacts.find(c => c.address === address);
    if (!entry) { if (contacts.length >= 2000) throw Object.assign(new Error('Contact limit reached.'), { status: 400 }); entry = { id: crypto.randomUUID(), address }; contacts.push(entry); }
    entry.name = name; return entry;
  });
}
function remove(account, id) { return modify(account, contacts => { const index = contacts.findIndex(c => c.id === id); if (index >= 0) contacts.splice(index, 1); return { ok: true }; }); }
module.exports = { list, save, remove };
