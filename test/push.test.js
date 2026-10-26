const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TU_MAIL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tumail-push-'));
const push = require('../server/services/push');

const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPk', auth: 'xyz' } };

test('push: only real browser push services are accepted as subscription addresses', () => {
  assert.deepEqual(push.validate(good), good);
  assert.ok(push.validate({ ...good, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x' }));
  assert.ok(push.validate({ ...good, endpoint: 'https://web.push.apple.com/abc' }));
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://169.254.169.254/x', 'https://fcm.googleapis.com.evil.example/x', 'nonsense', '']) {
    assert.throws(() => push.validate({ ...good, endpoint }), /not|missing/i, endpoint);
  }
  assert.throws(() => push.validate({ endpoint: good.endpoint }), /keys/);
  assert.throws(() => push.validate(null), /missing/i);
});

test('push: an alert is the sender and the subject', () => {
  assert.equal(push.describe([]), null);
  assert.deepEqual(push.describe([{ uid: 4, from: 'Alex', subject: 'Lunch?' }]), { title: 'Alex', body: 'Lunch?', uid: 4 });
  const many = push.describe([{ uid: 1, from: 'Alex', subject: 'A' }, { uid: 2, from: 'Sam', subject: 'B' }]);
  assert.equal(many.title, 'New mail');
  assert.equal(many.body, 'Sam — B\nAlex — A');
});

test('push: subscriptions are kept per person, capped, and removed at sign-out', () => {
  assert.equal(push.has('a@stud.tu-darmstadt.de'), false);
  push.add('a@stud.tu-darmstadt.de', good);
  assert.equal(push.has('A@stud.tu-darmstadt.de'), true, 'addresses compare without case');
  push.remove('a@stud.tu-darmstadt.de', good.endpoint);
  assert.equal(push.has('a@stud.tu-darmstadt.de'), false);
  for (let i = 0; i < 8; i++) push.add('b@stud.tu-darmstadt.de', { ...good, endpoint: 'https://fcm.googleapis.com/fcm/send/' + i });
  push.clear('b@stud.tu-darmstadt.de');
  assert.equal(push.has('b@stud.tu-darmstadt.de'), false);
  assert.match(push.publicKey(), /^[A-Za-z0-9_-]{80,}$/);
  const stored = fs.readFileSync(path.join(process.env.TU_MAIL_DATA_DIR, 'push', 'vapid.json'), 'utf8');
  assert.ok(stored.includes('privateKey'));
});

test('push: the watcher only looks at people who subscribed, and starts from the newest message', async () => {
  push.add('c@stud.tu-darmstadt.de', good);
  const calls = [];
  const credentials = () => [{ email: 'c@stud.tu-darmstadt.de', password: 'x' }, { email: 'nobody@stud.tu-darmstadt.de', password: 'x' }];
  const inboxCounts = async (creds, since, after) => { calls.push([creds.email, after]); return { uidNext: 11, latest: [] }; };
  await push.check({ credentials, inboxCounts });
  assert.deepEqual(calls, [['c@stud.tu-darmstadt.de', -1]], 'only the subscribed person is checked');
  await push.check({ credentials, inboxCounts });
  assert.deepEqual(calls[1], ['c@stud.tu-darmstadt.de', 10], 'the next check asks only for newer mail');
  push.clear('c@stud.tu-darmstadt.de');
});

test('push: the service worker shows alerts only when nobody is looking, and the client subscribes', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../client/sw.js'), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /visibilityState === 'visible' && p\.focused/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  const notify = fs.readFileSync(path.join(__dirname, '../client/js/notify.js'), 'utf8');
  assert.match(notify, /pushManager\.subscribe/);
  assert.match(notify, /\/api\/mail\/push\/subscribe/);
});
