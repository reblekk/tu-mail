#!/usr/bin/env node
// Load test for TUDa Mail. The real server (sessions, routes, sign-in limits, logging, per-person settings
// files) runs in its own process against a FAKE mail backend; this process plays a crowd of students.
// The fake backend waits like a real mail server would and does the real work of parsing a 200 KB message
// and cleaning its HTML, so CPU use is realistic. What it cannot show is how the university's mail servers
// react to many logins from one address: that is HRZ's call, not something to test from here.
//
//   node tools/load-test.js                       # ladder: 25, 100, 250, 500, 1000 users, 20 s each
//   node tools/load-test.js --users 300 --seconds 30
//   node tools/load-test.js --storm 300           # everyone signs in at once with the default limits
//   LOADTEST_PROFILE_DIR=./prof node tools/load-test.js --users 100   # also write a CPU profile of the server
//
// Nothing here talks to a real mailbox or sends mail.
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.argv[2] === '--server') return runServer(JSON.parse(process.argv[3]));

// =========================================================================== the server side
function runServer(opts) {
  process.env.TU_MAIL_DATA_DIR = opts.dataDir;
  const root = path.join(__dirname, '..');
  const configModule = require(path.join(root, 'server/config'));
  const base = require(path.join(root, 'server/server'));
  const imap = require(path.join(root, 'server/services/mail-imap'));
  const session = require(path.join(root, 'server/services/mail-session'));
  const { simpleParser } = require('mailparser');
  const MailComposer = require('nodemailer/lib/mail-composer');
  const { monitorEventLoopDelay } = require('node:perf_hooks');

  // Mail servers take time; jitter keeps requests from lining up.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6)));
  const error = (code) => Object.assign(new Error('rejected'), { code });

  // One realistic message: ~40 KB of styled HTML with links and images, plus a ~150 KB attachment.
  const paragraph = '<p style="margin:0 0 8px;color:#333;font-size:14px">Dear student, the seminar <a href="https://example.edu/a?x=1">schedule</a> changed. <b>Please</b> read <i>carefully</i> and reply by Friday. <img src="https://example.edu/p.png" width="40" height="20" alt="logo"></p>';
  const html = '<table width="100%"><tr><td>' + paragraph.repeat(150) + '</td></tr></table>';
  const rawMessage = new Promise((resolve, reject) => {
    new MailComposer({
      from: 'Prof Example <prof@stud.tu-darmstadt.de>', to: 'student@stud.tu-darmstadt.de', subject: 'Seminar schedule', html, text: html.replace(/<[^>]+>/g, ''),
      attachments: [{ filename: 'slides.pdf', content: Buffer.alloc(150 * 1024, 7), contentType: 'application/pdf' }],
    }).compile().build((e, b) => (e ? reject(e) : resolve(b)));
  });

  async function realisticMessage(uid) {
    await wait(opts.latency.read);
    const parsed = await simpleParser(await rawMessage); // real parsing work, every time
    const clean = imap.sanitizeEmailHtml(parsed.html);    // real sanitising work, every time
    return {
      uid: Number(uid), folder: 'INBOX', subject: parsed.subject, from: { name: 'Prof Example', address: 'prof@stud.tu-darmstadt.de' },
      to: [{ name: '', address: 'student@stud.tu-darmstadt.de' }], cc: [], bcc: [], replyTo: [], date: new Date().toISOString(), messageId: '<m' + uid + '@x>', references: [], threadIds: [],
      seen: true, flagged: false, answered: false, html: clean.html, remoteImages: clean.remoteImages, text: parsed.text.slice(0, 2000),
      attachments: parsed.attachments.map((a, index) => ({ index, filename: a.filename, contentType: a.contentType, size: a.size, inline: false })),
    };
  }
  const summaries = Array.from({ length: 400 }, (_, i) => ({
    uid: 400 - i, folder: 'INBOX', subject: 'Message number ' + (400 - i), from: { name: 'Sender ' + i, address: 'sender' + i + '@example.edu' }, to: [], date: new Date(Date.now() - i * 3600000).toISOString(),
    seen: i > 5, flagged: false, answered: false, hasAttachment: i % 4 === 0, size: 20000, threadIds: ['t' + i],
  }));
  const folders = ['Inbox', 'Drafts', 'Sent Items', 'Archive', 'Trash'].map((name, i) => ({ path: i ? name : 'INBOX', name, role: ['inbox', 'drafts', 'sent', 'archive', 'trash'][i], depth: 0, selectable: true, unseen: i ? 0 : 3 }));

  imap.verifyCredentials = async (c) => { await wait(opts.latency.login); if (c.password !== 'load-test-password') throw error('MAIL_AUTH'); };
  imap.forget = () => {};
  imap.listFolders = async () => { await wait(30); return folders; };
  imap.inboxCounts = async () => { await wait(20); return { unseen: 3, uidNext: 1000, fresh: 0, latest: [] }; };
  imap.listMessages = async (c, o) => { await wait(60); const start = (o.page - 1) * o.pageSize; return { total: 400, page: o.page, pageSize: o.pageSize, messages: summaries.slice(start, start + o.pageSize), related: [] }; };
  imap.previews = async (c, { uids }) => { await wait(80); return Object.fromEntries(uids.map((u) => [u, 'Preview of message ' + u])); };
  imap.readMessage = async (c, o) => realisticMessage(o.uid);
  imap.getThread = async (c, o) => { const m = await realisticMessage(o.uid); return { subject: m.subject, messages: [m], truncated: false }; };
  imap.setFlags = async () => { await wait(40); };

  const config = configModule.load({ TU_MAIL_DATA_DIR: opts.dataDir, ...opts.env });
  const app = base.createApp(config);
  const server = app.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));

  // Once a second: memory, how late the event loop runs, and how much of one core the server uses.
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let lastCpu = process.cpuUsage(), lastAt = process.hrtime.bigint();
  setInterval(() => {
    const now = process.hrtime.bigint(), cpu = process.cpuUsage(lastCpu);
    const elapsedUs = Number(now - lastAt) / 1000;
    process.send({
      type: 'stats', rssMB: process.memoryUsage().rss / 1048576, heapMB: process.memoryUsage().heapUsed / 1048576,
      lagP99: delay.percentile(99) / 1e6, lagMax: delay.max / 1e6, cpuPct: ((cpu.user + cpu.system) / elapsedUs) * 100, sessions: session.count(),
    });
    delay.reset(); lastCpu = process.cpuUsage(); lastAt = now;
  }, 1000).unref();
  process.on('message', (m) => { if (m === 'stop') server.close(() => process.exit(0)); });
}

// =========================================================================== the crowd
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function scenario({ name, users, seconds, env, ramp, storm }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tumail-load-'));
  const child = fork(__filename, ['--server', JSON.stringify({ dataDir, env, latency: { login: 150, read: 80 } })], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: process.env.LOADTEST_PROFILE_DIR ? ['--cpu-prof', '--cpu-prof-dir=' + process.env.LOADTEST_PROFILE_DIR] : [] });
  const stats = [];
  child.on('message', (m) => { if (m.type === 'stats') stats.push(m); });
  const port = await new Promise((resolve, reject) => { child.once('message', (m) => m.type === 'ready' && resolve(m.port)); child.once('exit', () => reject(new Error('server exited'))); });
  const base = 'http://127.0.0.1:' + port;

  const timings = new Map(); // endpoint -> [ms]
  const outcomes = { ok: 0, throttled: 0, busy: 0, error: 0, timeout: 0 };
  const note = (label, ms) => { if (!timings.has(label)) timings.set(label, []); timings.get(label).push(ms); };
  async function call(label, jar, method, url, body) {
    const started = performance.now();
    try {
      const res = await fetch(base + url, {
        method, signal: AbortSignal.timeout(15000), body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Origin: base, ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      });
      await res.arrayBuffer();
      const ms = performance.now() - started;
      if (res.ok) { outcomes.ok += 1; note(label, ms); if (label === 'login') jar.cookie = res.headers.getSetCookie()[0].split(';')[0]; return true; }
      if (res.status === 429) outcomes.throttled += 1; else if (res.status === 503) outcomes.busy += 1; else outcomes.error += 1;
      return false;
    } catch (e) { outcomes.timeout += 1; return false; }
  }

  // Warm-up, not measured: the first sign-in and the first message read compile code and create files,
  // which says nothing about steady use.
  {
    const jar = { cookie: '' };
    await call('warmup', jar, 'POST', '/api/auth/login', { email: 'warmup@stud.tu-darmstadt.de', username: 'ab12cdef', password: 'load-test-password', fullName: 'Warm Up' }).then(() => {});
    if (!jar.cookie) { const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'warmup@stud.tu-darmstadt.de', username: 'ab12cdef', password: 'load-test-password' }) }); jar.cookie = (res.headers.getSetCookie()[0] || '').split(';')[0]; await res.arrayBuffer(); }
    for (let k = 0; k < 6; k += 1) { await call('warmup', jar, 'GET', `/api/mail/thread?folder=INBOX&uid=${390 + k}&peek=1`); await call('warmup', jar, 'GET', '/api/mail/messages?folder=INBOX&page=1&pageSize=40'); }
    timings.clear(); stats.length = 0;
    outcomes.ok = outcomes.throttled = outcomes.busy = outcomes.error = outcomes.timeout = 0;
    await sleep(1500); stats.length = 0;
  }

  const startedAt = Date.now();
  const rampMs = ramp;
  const endAt = startedAt + rampMs + seconds * 1000;
  let signedIn = 0;
  async function student(i) {
    await sleep((i / users) * rampMs);
    const jar = { cookie: '' };
    const ok = await call('login', jar, 'POST', '/api/auth/login', { email: `load${i}@stud.tu-darmstadt.de`, username: 'ab12cdef', password: 'load-test-password', fullName: 'Load User ' + i });
    if (!ok || storm) return;
    signedIn += 1;
    const open = async () => { await call('folders', jar, 'GET', '/api/mail/folders'); await call('list', jar, 'GET', '/api/mail/messages?folder=INBOX&page=1&pageSize=40'); await call('previews', jar, 'POST', '/api/mail/previews', { folder: 'INBOX', uids: Array.from({ length: 40 }, (_, k) => 400 - k) }); };
    await open();
    while (Date.now() < endAt) {
      await sleep(rand(1000, 4000)); // people read, they do not click every 50 ms
      const r = Math.random();
      if (r < 0.55) await call('read', jar, 'GET', `/api/mail/thread?folder=INBOX&uid=${Math.floor(rand(300, 400))}&peek=1`);
      else if (r < 0.75) { await call('list', jar, 'GET', `/api/mail/messages?folder=INBOX&page=${Math.floor(rand(1, 4))}&pageSize=40`); await call('previews', jar, 'POST', '/api/mail/previews', { folder: 'INBOX', uids: [390, 389, 388] }); }
      else if (r < 0.85) await call('flag', jar, 'PUT', '/api/mail/messages/flags', { folder: 'INBOX', uids: [Math.floor(rand(300, 400))], action: 'star' });
      else if (r < 0.95) await call('poll', jar, 'GET', '/api/mail/unread?since=0');
      else await open();
    }
  }
  await Promise.all(Array.from({ length: users }, (_, i) => student(i)));
  const wallSeconds = (Date.now() - startedAt) / 1000;
  const loaded = stats.filter((s) => s.sessions > 0);
  child.send('stop');
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
  try { child.kill(); } catch (e) { /* already gone */ }
  fs.rmSync(dataDir, { recursive: true, force: true });

  const all = [...timings.values()].flat().sort((a, b) => a - b);
  const per = (label) => { const v = (timings.get(label) || []).sort((a, b) => a - b); return v.length ? `${label} p95 ${pct(v, 95).toFixed(0)} ms` : ''; };
  const total = outcomes.ok + outcomes.throttled + outcomes.busy + outcomes.error + outcomes.timeout;
  const failed = total - outcomes.ok;
  const result = {
    name, users, signedIn, requests: total, perSecond: total / wallSeconds, failedPct: total ? (failed / total) * 100 : 0, outcomes,
    p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), loginP95: pct((timings.get('login') || []).sort((a, b) => a - b), 95),
    readP95: pct((timings.get('read') || []).sort((a, b) => a - b), 95),
    peakRss: Math.max(0, ...loaded.map((s) => s.rssMB)), peakHeap: Math.max(0, ...loaded.map((s) => s.heapMB)), peakLag: Math.max(0, ...loaded.map((s) => s.lagP99)), maxLag: Math.max(0, ...loaded.map((s) => s.lagMax)),
    avgCpu: loaded.length ? loaded.reduce((a, s) => a + s.cpuPct, 0) / loaded.length : 0, peakCpu: Math.max(0, ...loaded.map((s) => s.cpuPct)), peakSessions: Math.max(0, ...loaded.map((s) => s.sessions)),
    detail: ['folders', 'list', 'previews', 'read', 'flag', 'poll'].map(per).filter(Boolean).join(' · '),
  };
  const verdict = result.failedPct > 1 || result.p95 > 3000 ? 'OVERLOADED' : result.p95 > 1000 || result.peakCpu > 90 ? 'STRAINED' : 'OK';
  return { ...result, verdict };
}

function line(r) {
  const o = r.outcomes;
  return [
    `${String(r.users).padStart(5)} users  signed in ${String(r.signedIn).padStart(5)}  ${String(r.requests).padStart(6)} requests (${r.perSecond.toFixed(0)}/s)  failed ${r.failedPct.toFixed(1)}%`,
    `        latency p50 ${r.p50.toFixed(0)} · p95 ${r.p95.toFixed(0)} · p99 ${r.p99.toFixed(0)} ms   login p95 ${r.loginP95.toFixed(0)} ms   read p95 ${r.readP95.toFixed(0)} ms`,
    `        server: CPU avg ${r.avgCpu.toFixed(0)}% / peak ${r.peakCpu.toFixed(0)}% of one core   memory peak ${r.peakRss.toFixed(0)} MB (heap ${r.peakHeap.toFixed(0)})   event-loop lag p99 ${r.peakLag.toFixed(0)} ms (max ${r.maxLag.toFixed(0)})`,
    o.throttled || o.busy || o.error || o.timeout ? `        not ok: ${o.throttled} rate-limited, ${o.busy} busy, ${o.error} errors, ${o.timeout} timeouts` : '',
    `        verdict: ${r.verdict}`,
  ].filter(Boolean).join('\n');
}

(async () => {
  const seconds = Number(flag('seconds', 20));
  const high = { LOGIN_IP_PER_MINUTE: '1000000', MAX_SESSIONS: '50000', LOGIN_ACCOUNT_FAILURES: '1000000' };
  console.log(`Load test on ${os.cpus().length} x ${os.cpus()[0].model.trim()}, ${Math.round(os.totalmem() / 1e9)} GB, Node ${process.version}`);
  console.log('Fake mail backend: ~150 ms to sign in, 20-80 ms per mail operation, real parsing and cleaning of a 200 KB message.\n');
  if (flag('storm')) {
    const users = Number(flag('storm'));
    const r = await scenario({ name: 'storm', users, seconds: 1, env: {}, ramp: 5000, storm: true });
    console.log(`Sign-in storm, default limits: ${users} different students sign in within 5 seconds from ONE address`);
    console.log(`  signed in: ${r.outcomes.ok}   rate-limited (HTTP 429): ${r.outcomes.throttled}   other failures: ${r.outcomes.error + r.outcomes.busy + r.outcomes.timeout}`);
    return;
  }
  const ladder = flag('users') ? [Number(flag('users'))] : [25, 100, 250, 500, 1000];
  for (const users of ladder) {
    const r = await scenario({ name: 'ladder', users, seconds, env: high, ramp: Math.min(10000, users * 20) });
    console.log(line(r) + '\n');
  }
})().catch((e) => { console.error(e); process.exit(1); });
