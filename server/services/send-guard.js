// A retry with the same attempt ID must never submit the message twice.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const entries = new Map();
const TTL = 8 * 60 * 60 * 1000;
const root = path.join(process.env.TU_MAIL_DATA_DIR || path.join(__dirname, '../../data'), 'send-attempts');
const ready = fs.mkdir(root, {recursive:true});
const unknown = () => Object.assign(new Error('A previous send may already have been delivered. Check Sent and with the recipient before starting a new attempt.'), {status:409,code:'SEND_UNKNOWN'});
function fingerprint(message) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ ...message, attachments: undefined }));
  for (const a of message.attachments || []) { hash.update(a.filename || ''); hash.update(a.contentType || ''); hash.update(a.content); }
  return hash.digest('hex');
}
async function once(account, attempt, message, send) {
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(attempt || '')) throw Object.assign(new Error('A valid send attempt ID is required.'), { status: 400 });
  await ready;
  const key = account + ':' + attempt, signature = fingerprint(message);
  const old = entries.get(key);
  if (old) {
    if (old.signature !== signature) throw Object.assign(new Error('This send attempt belongs to a different message. Check Sent before creating a new attempt.'), { status: 409 });
    return old.promise;
  }
  const entry = { signature, expires: Date.now() + TTL };
  entries.set(key, entry);
  const file = path.join(root, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  entry.promise = Promise.resolve().then(async () => {
    try {
      const previous=JSON.parse(await fs.readFile(file,'utf8'));
      if(previous.signature !== signature) throw unknown();
      if(previous.result) return previous.result;
      throw unknown();
    } catch(e) { if(e.code !== 'ENOENT') throw e; }
    // Claim durably before SMTP. A crash leaves an uncertain attempt, never an automatic retry.
    await fs.writeFile(file,JSON.stringify({signature,state:'pending'}),{flag:'wx'});
    const result=await send();
    const temp=file+'.tmp';
    await fs.writeFile(temp,JSON.stringify({signature,state:'sent',result}));
    await fs.rename(temp,file);
    return result;
  }).catch(async error => {
    // Known pre-delivery failures can safely be retried; uncertain failures are retained.
    if (['MAIL_AUTH'].includes(error.code) || [400, 413, 422, 429].includes(error.status)) { entries.delete(key); await fs.unlink(file).catch(()=>{}); }
    throw error;
  });
  return entry.promise;
}
setInterval(() => { for (const [key, entry] of entries) if (entry.expires < Date.now()) entries.delete(key); }, 60000).unref();
module.exports = { once };
