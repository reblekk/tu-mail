const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const run = (dir, code) => spawnSync(process.execPath, ['-e', code], {
  cwd: root, encoding: 'utf8', env: { ...process.env, TU_MAIL_DATA_DIR: dir },
});

test('a file-backed sign-in survives a restart and is stored encrypted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-sessions-'));
  const first = run(dir, `
    const s = require('./server/services/mail-session');
    s.configure({ sessionStore: 'file', sessionDays: 365 });
    let cookie;
    s.create({ headers: {}, secure: true }, { cookie: (n, v) => { cookie = v; }, clearCookie() {} }, { userId: 'u1', email: 'a@stud.tu-darmstadt.de' }, 'hunter2-secret');
    setTimeout(() => { console.log(cookie); }, 2200);
  `);
  const key = first.stdout.trim();
  assert.match(key, /^[0-9a-f]{64}$/, first.stderr);
  const raw = fs.readFileSync(path.join(dir, 'sessions.enc'));
  assert.ok(!raw.includes('hunter2-secret') && !raw.includes('stud.tu-darmstadt.de'), 'file must not hold readable data');

  const second = run(dir, `
    const s = require('./server/services/mail-session');
    s.configure({ sessionStore: 'file', sessionDays: 365 });
    const req = { headers: { cookie: 'tu_mail_session=${key}' }, query: {} };
    console.log(JSON.stringify(s.listAccounts(req)), (s.getCredentials(req) || {}).password);
  `);
  assert.match(second.stdout, /u1/);
  assert.match(second.stdout, /hunter2-secret/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without the file store nothing is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-sessions-'));
  run(dir, `
    const s = require('./server/services/mail-session');
    s.configure({});
    s.create({ headers: {} }, { cookie() {}, clearCookie() {} }, { userId: 'u1' }, 'pw');
  `);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
