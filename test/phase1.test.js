const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.TU_MAIL_LOG='off';
const client=path.join(__dirname,'../client');
const read=f=>fs.readFileSync(path.join(client,f),'utf8');

// ---------------------------------------------------------------- language
const i18n=require('../client/js/i18n.js');
const {de,patterns}=require('../client/js/i18n-de.js');
const tr=text=>{i18n._reset('de');return i18n.t(text);};

test('German: exact strings, patterns, whitespace and passthrough',()=>{
 assert.equal(tr('Sign in'),'Anmelden');
 assert.equal(tr('  Inbox\n  '),'  Posteingang\n  ','keeps surrounding whitespace');
 assert.equal(tr('New\n      message'),'Neue Nachricht','collapses inner whitespace like HTML does');
 assert.equal(tr('3 selected'),'3 ausgewählt');
 assert.equal(tr('1 message archived'),'1 Nachricht archiviert');
 assert.equal(tr('4 messages archived'),'4 Nachrichten archiviert');
 assert.equal(tr('2 messages moved to Projects'),'2 Nachrichten nach Projects verschoben');
 assert.equal(tr('2 messages moved to Deleted Items'),'2 Nachrichten in „Gelöschte Elemente“ verschoben');
 assert.equal(tr('Nothing in this folder matches “exam”.'),'Nichts in diesem Ordner entspricht „exam“.');
 assert.equal(tr('Delete “Old”?'),'„Old“ löschen?');
 assert.equal(tr('Tue 2026-09-29 8:13 PM'),'Di, 29.09.2026, 20:13');
 assert.equal(tr('Tue 2026-09-29 12:05 AM'),'Di, 29.09.2026, 00:05');
 assert.equal(tr('Remove notes.pdf'),'notes.pdf entfernen');
 assert.equal(tr('Remove flag'),'Markierung entfernen','exact entries beat patterns');
 assert.equal(tr('Quarterly budget review'),'Quarterly budget review','unknown text is left alone');
 assert.equal(tr(''),'');
 i18n._reset('en');
 assert.equal(i18n.t('Sign in'),'Sign in','English is the identity');
});

test('German dictionary is complete for the static pages and has no dead entries',()=>{
 i18n._reset('de');
 const ignore=new Set(['TU Mail','Technische Universität Darmstadt','TU-ID','Webmail','Bcc','Cc','Normal']);
 const missing=[];
 for(const file of ['index.html','mail.html','calendar.html']){
  const html=read(file);
  const texts=[...html.matchAll(/>([^<>{}]+)</g)].map(m=>m[1]).concat([...html.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"]+)"/g)].map(m=>m[1]));
  for(const raw of texts){
   const t=raw.replace(/\s+/g,' ').trim();
   if(!/[A-Za-z]{2}/.test(t)||ignore.has(t))continue;
   // Some words are the same in both languages; they still need an explicit entry.
   if(i18n.t(t)===t&&!Object.prototype.hasOwnProperty.call(de,t))missing.push(file+': '+t);
  }
 }
 assert.deepEqual(missing,[],'untranslated static text');
 // Every entry must still correspond to text somewhere in the client or the server.
 const sources=fs.readdirSync(path.join(client,'js')).filter(f=>f!=='i18n-de.js').map(f=>read('js/'+f)).concat([read('index.html'),read('mail.html'),read('calendar.html')],
  fs.readFileSync(path.join(__dirname,'../server/server.js'),'utf8'),fs.readFileSync(path.join(__dirname,'../server/routes/mail.js'),'utf8')).join('\n');
 const serverFolderNames=new Set(['Sent Items','Deleted Items','Junk','Trash','Inbox','Drafts','Sent','Archive','Spam','Message sent','Message']);
 const dead=Object.keys(de).filter(k=>!sources.includes(k)&&!sources.includes(k.replace(/'/g,"\\'"))&&!serverFolderNames.has(k));
 assert.deepEqual(dead,[],'dictionary entries that no longer match any source text');
 for(const [k,v] of Object.entries(de)){assert.equal(typeof v,'string');assert.ok(v.trim(),'empty translation for '+k);}
 assert.ok(patterns.length>10);
});

// ---------------------------------------------------------------- pages
test('pages wire up language, accessibility and the install manifest',()=>{
 for(const file of ['index.html','mail.html']){
  const html=read(file);
  assert.match(html,/class="skip-link" href="#main"/);assert.match(html,/<main[^>]*id="main"/);
  assert.match(html,/rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html,/href="css\/a11y\.css"/);
  assert.match(html,/js\/i18n\.js/);assert.match(html,/js\/i18n-de\.js/);
  for(const m of html.matchAll(/(?:src|href)="((?:css|js|assets)\/[^"]+)"/g))assert.ok(fs.existsSync(path.join(client,m[1])),file+' references missing '+m[1]);
 }
 const mail=read('mail.html');
 assert.match(mail,/id="msg-print"/);assert.match(mail,/css\/print\.css" media="print"/);
 assert.ok(mail.indexOf('js/i18n.js')<mail.indexOf('js/auth.js'),'language scripts load before the app');
 assert.ok(mail.indexOf('js/ui-prefs.js')<mail.indexOf('js/auth.js'),'preferences load before the account menu uses them');
});

test('print hides the chrome, and no dark theme remains',()=>{
 const print=read('css/print.css');
 assert.match(print,/@media print/);assert.match(print,/\.msg-toolbar/);assert.match(print,/\.mail-folders/);
 assert.ok(!fs.existsSync(path.join(client,'css/theme.css'))&&!fs.existsSync(path.join(client,'js/theme.js')),'theme files are gone');
 for(const f of fs.readdirSync(path.join(client,'css')))assert.ok(!/data-theme/.test(read('css/'+f)),f+' still has theme rules');
});

test('service worker never touches the API and the shortcuts file lists every documented key',()=>{
 const sw=read('sw.js');
 assert.match(sw,/startsWith\('\/api\/'\)/);assert.match(sw,/req\.method !== 'GET'/);
 assert.match(sw,/skipWaiting/);
 for(const url of [...sw.matchAll(/'(\/(?:css|js|assets)\/[^']+)'/g)].map(m=>m[1]))assert.ok(fs.existsSync(path.join(client,url)),'service worker precaches missing '+url);
 const shortcuts=read('js/shortcuts.js');
 for(const key of ['j / ↓','k / ↑','c','r','a','u','f','e','Delete','p','/','g then i','Esc','?'])assert.ok(shortcuts.includes("['"+key+"'"),'shortcut help is missing '+key);
});

// ---------------------------------------------------------------- brand
const brand=require('../server/services/brand');
test('brand: defaults, validation and derived colours',()=>{
 const d=brand.load({});
 assert.equal(d.name,'TU Mail');assert.equal(d.color,'#b90f22');assert.equal(d.logo,null);
 assert.match(d.colorDark,/^#[0-9a-f]{6}$/);assert.match(d.colorTint,/^#[0-9a-f]{6}$/);
 assert.notEqual(d.colorDark,d.color);
 const custom=brand.load({BRAND_NAME:'Uni Mail',BRAND_PRIMARY_COLOR:'#003366',BRAND_HELP_URL:'https://help.example.edu/mail',BRAND_FOOTER:'Run by IT'});
 assert.deepEqual([custom.name,custom.color,custom.helpUrl,custom.footer],['Uni Mail','#003366','https://help.example.edu/mail','Run by IT']);
 assert.equal(brand.load({BRAND_NAME:'x'.repeat(41)}).name,'TU Mail','over-long names fall back');
 assert.equal(brand.load({BRAND_NAME:'A\nB'}).name,'A B','control characters are stripped');
 assert.throws(()=>brand.load({BRAND_PRIMARY_COLOR:'red'}),/BRAND_PRIMARY_COLOR/);
 assert.throws(()=>brand.load({BRAND_PRIMARY_COLOR:'#12345; background:url(x)'}),/BRAND_PRIMARY_COLOR/);
 assert.throws(()=>brand.load({BRAND_HELP_URL:'javascript:alert(1)'}),/https/);
 assert.throws(()=>brand.load({BRAND_HELP_URL:'http://help.example.edu'}),/https/);
 const m=brand.manifest(custom);
 assert.equal(m.name,'Uni Mail');assert.equal(m.theme_color,'#003366');assert.equal(m.display,'standalone');assert.equal(m.start_url,'/mail.html');
 assert.ok(m.icons.some(i=>i.purpose==='maskable')&&m.icons.some(i=>i.sizes==='192x192'));
});

test('brand: logo must be a small image inside the data directory',()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'tumail-brand-'));
 fs.mkdirSync(path.join(data,'brand'));
 fs.writeFileSync(path.join(data,'brand','logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
 fs.writeFileSync(path.join(data,'brand','notes.txt'),'x');
 fs.writeFileSync(path.join(data,'secret.png'),'x');
 fs.writeFileSync(path.join(data,'brand','huge.png'),Buffer.alloc(600*1024));
 const env=extra=>({TU_MAIL_DATA_DIR:data,...extra});
 assert.equal(brand.load(env({BRAND_LOGO:'logo.svg'})).logo.type,'image/svg+xml');
 assert.throws(()=>brand.load(env({BRAND_LOGO:'../secret.png'})),/inside the brand folder/);
 assert.throws(()=>brand.load(env({BRAND_LOGO:'notes.txt'})),/\.svg/);
 assert.throws(()=>brand.load(env({BRAND_LOGO:'missing.png'})),/not found/);
 assert.throws(()=>brand.load(env({BRAND_LOGO:'huge.png'})),/512 KB/);
});

// ---------------------------------------------------------------- server routes
const configModule=require('../server/config');
const base=require('../server/server');
const imap=require('../server/services/mail-imap');
imap.verifyCredentials=async c=>{if(c.password!=='test-only-password'){const e=new Error('no');e.code='MAIL_AUTH';throw e;}};
const servers=[];
function start(env){
 const app=base.createApp(configModule.load({TU_MAIL_LOG:'off',LOGIN_IP_PER_MINUTE:'100',...env}));
 const server=app.listen(0,'127.0.0.1');servers.push(server);
 return new Promise(r=>server.once('listening',()=>r({port:server.address().port})));
}
after(()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r)))));
function call({port},{method='GET',url='/',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,method,path:url,headers:{Host:'localhost:3210',...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...headers}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json(){return JSON.parse(text);}}));
  });
  req.on('error',reject);req.end(data);
 });
}

test('server: brand endpoint, manifest, logo and service worker headers',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'tumail-srv-'));
 fs.mkdirSync(path.join(data,'brand'));
 fs.writeFileSync(path.join(data,'brand','logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
 const plain=await start({});
 const b=await call(plain,{url:'/api/brand'});
 assert.equal(b.status,200);assert.equal(b.json().name,'TU Mail');assert.equal(b.json().logoUrl,null);assert.equal(b.headers['cache-control'],'no-store');
 assert.equal((await call(plain,{url:'/brand/logo'})).status,404);
 const branded=await start({TU_MAIL_DATA_DIR:data,BRAND_NAME:'Uni Mail',BRAND_PRIMARY_COLOR:'#003366',BRAND_LOGO:'logo.svg'});
 const bb=(await call(branded,{url:'/api/brand'})).json();
 assert.equal(bb.name,'Uni Mail');assert.equal(bb.color,'#003366');assert.equal(bb.logoUrl,'/brand/logo');
 const logo=await call(branded,{url:'/brand/logo'});
 assert.equal(logo.status,200);assert.equal(logo.headers['content-type'],'image/svg+xml');assert.match(logo.headers['content-security-policy'],/sandbox/);
 const man=await call(branded,{url:'/manifest.webmanifest'});
 assert.equal(man.status,200);assert.match(man.headers['content-type'],/application\/manifest\+json/);
 assert.equal(man.json().name,'Uni Mail');assert.equal(man.json().theme_color,'#003366');
 const sw=await call(plain,{url:'/sw.js'});
 assert.equal(sw.status,200);assert.equal(sw.headers['cache-control'],'no-cache');
 const csp=(await call(plain,{url:'/'})).headers['content-security-policy'];
 assert.match(csp,/worker-src 'self'/);assert.match(csp,/manifest-src 'self'/);
 for(const icon of man.json().icons)assert.equal((await call(plain,{url:icon.src})).status,200,icon.src+' is served');
});

test('server: metrics are off without a token, protected with one, and carry no personal data',async()=>{
 const off=await start({});
 assert.equal((await call(off,{url:'/metrics'})).status,404);
 assert.throws(()=>configModule.load({METRICS_TOKEN:'short'}),/16 characters/);
 const TOKEN='metrics-token-0123456789';
 const on=await start({METRICS_TOKEN:TOKEN});
 assert.equal((await call(on,{url:'/metrics'})).status,401);
 assert.equal((await call(on,{url:'/metrics',headers:{Authorization:'Bearer wrong-token-0123456789'}})).status,401);
 const origin='http://localhost:3210';
 const login=(password)=>call(on,{method:'POST',url:'/api/auth/login',headers:{Origin:origin},body:{email:'metrics.person@stud.tu-darmstadt.de',username:'ab12cdef',password}});
 assert.equal((await login('test-only-password')).status,200);
 assert.equal((await login('wrong')).status,401);
 const res=await call(on,{url:'/metrics',headers:{Authorization:'Bearer '+TOKEN}});
 assert.equal(res.status,200);assert.match(res.headers['content-type'],/text\/plain/);
 assert.match(res.text,/^tu_mail_login_ok_total 1$/m);
 assert.match(res.text,/^tu_mail_login_failed_total\{reason="rejected"\} 1$/m);
 assert.match(res.text,/^tu_mail_sessions \d+$/m);
 assert.match(res.text,/^# TYPE tu_mail_uptime_seconds gauge$/m);
 assert.match(res.text,/tu_mail_http_requests_total\{class="2xx"\} \d+/);
 assert.ok(!/metrics\.person|ab12cdef|test-only-password|stud\.tu-darmstadt/.test(res.text),'no identities in metrics');
});
