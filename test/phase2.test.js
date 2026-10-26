const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
// Settings, contacts and send records live in the data directory; keep them out of the real one.
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'tumail-p2-'));
process.env.TU_MAIL_DATA_DIR=DATA;
process.env.TU_MAIL_LOG='off';
const client=path.join(__dirname,'../client');
const read=f=>fs.readFileSync(path.join(client,f),'utf8');

// ---------------------------------------------------------------- search filters
const {buildQuery,parseFilters,hasFilters}=require('../server/services/search-query');
test('search: nothing narrows the folder by default',()=>{
 assert.equal(buildQuery({}),null);
 assert.equal(buildQuery({q:'',unreadOnly:false,filters:{}}),null);
 assert.equal(hasFilters({}),false);assert.equal(hasFilters({from:'a'}),true);
});

test('search: text, scope, unread and each filter map to IMAP criteria',()=>{
 assert.deepEqual(buildQuery({q:'exam'}).or,[{from:'exam'},{to:'exam'},{subject:'exam'}]);
 assert.deepEqual(buildQuery({q:'exam',scope:'all'}).or.at(-1),{body:'exam'});
 assert.deepEqual(buildQuery({unreadOnly:true}),{seen:false});
 const f=parseFilters({from:' prof@x.de ',to:'me',subject:'Re: plan',since:'2026-01-05',before:'2026-01-31',flagged:'1',attach:'1'});
 const q=buildQuery({filters:f});
 assert.equal(q.from,'prof@x.de');assert.equal(q.to,'me');assert.equal(q.subject,'Re: plan');
 assert.equal(q.since.toISOString(),'2026-01-05T00:00:00.000Z');
 assert.equal(q.before.toISOString(),'2026-02-01T00:00:00.000Z','"before" includes the whole last day');
 assert.equal(q.flagged,true);assert.deepEqual(q.header,{'content-type':'multipart/mixed'});
 const combined=buildQuery({q:'a',unreadOnly:true,filters:{from:'b'}});
 assert.equal(combined.seen,false);assert.equal(combined.from,'b');assert.ok(combined.or);
});

test('search: filter input is validated',()=>{
 assert.deepEqual(parseFilters({}),{});
 assert.deepEqual(parseFilters({since:'yesterday',before:'2026-02-30',from:'   '}),{},'bad dates and blanks are dropped');
 assert.equal(parseFilters({from:'a\u0000b\nc'}).from,'a b c','control characters become spaces');
 assert.equal(parseFilters({subject:'x'.repeat(500)}).subject.length,200);
 assert.deepEqual(parseFilters({flagged:'0',attach:'yes'}),{});
 assert.deepEqual(parseFilters({from:['a','b']}).from,'a b'.replace(' ',','),'arrays are flattened to text');
});

// ---------------------------------------------------------------- phishing hints
const safety=require('../client/js/safety.js');
const KNOWN=['tu-darmstadt.de','stud.tu-darmstadt.de','example.com'];
const texts=(m,k=KNOWN)=>safety.analyze(m,k).map(f=>f.text);
test('safety: a normal message gets no hints',()=>{
 assert.deepEqual(safety.analyze({from:{name:'Alex',address:'alex@stud.tu-darmstadt.de'},replyTo:[],links:[{text:'Read more',href:'https://tu-darmstadt.de/news'},{text:'www.tu-darmstadt.de',href:'https://www.tu-darmstadt.de/'}]},KNOWN),[]);
 assert.deepEqual(safety.analyze({from:{address:'news@mail.example.com'},links:[]},KNOWN),[],'a subdomain of a known domain is fine');
 assert.deepEqual(safety.analyze({from:{address:'someone@unrelated-shop.org'},links:[]},KNOWN),[],'unknown but dissimilar domains are not flagged');
});
test('safety: look-alike sender domains',()=>{
 assert.match(texts({from:{address:'it@tu-darmstadt-support.com'}})[0],/contains "tu-darmstadt"/);
 assert.match(texts({from:{address:'it@tu-darmstat.de'}})[0],/very similar/);
 assert.match(texts({from:{address:'it@examp1e.com'}})[0],/very similar/,'1 for l');
 assert.match(texts({from:{address:'it@rnicrosoft.com'}},['microsoft.com'])[0],/very similar/,'rn for m');
 assert.deepEqual(texts({from:{address:'it@tu-darmstadt.de'}}),[]);
 assert.match(texts({from:{address:'it@tu-dаrmstadt.de'}})[0],/unusual characters/,'Cyrillic a');
 assert.match(texts({from:{address:'it@xn--tu-darmstadt-x9a.de'}})[0],/xn--/);
});
test('safety: display name, reply-to and links',()=>{
 assert.match(texts({from:{name:'boss@tu-darmstadt.de',address:'x@evil.org'}})[0],/shows the address boss@tu-darmstadt\.de/);
 assert.deepEqual(texts({from:{name:'boss@tu-darmstadt.de',address:'boss@tu-darmstadt.de'}}),[]);
 assert.match(texts({from:{address:'a@example.com'},replyTo:[{address:'a@other.net'}]})[0],/different domain/);
 assert.deepEqual(texts({from:{address:'a@example.com'},replyTo:[{address:'b@mail.example.com'}]}),[]);
 assert.match(texts({from:{address:'a@example.com'},links:[{text:'https://tu-darmstadt.de/login',href:'https://login.evil.example.net/x'}]})[0],/leads to login\.evil\.example\.net/);
 assert.match(texts({from:{address:'a@example.com'},links:[{text:'Click',href:'http://192.168.4.7/pay'}]})[0],/numeric address/);
 assert.match(texts({from:{address:'a@example.com'},links:[{text:'Click',href:'https://xn--pypal-4ve.com/'}]})[0],/look-alike/);
 assert.match(texts({from:{address:'a@example.com'},links:[{text:'Click',href:'https://tu-darmstadt.de@evil.org/'}]})[0],/user name before the web address/);
 assert.deepEqual(texts({from:{address:'a@example.com'},links:[{text:'Open the portal',href:'https://evil.org'}]}),[],'plain words are not a claim about the target');
 assert.equal(safety.registrable('mail.example.co.uk'),'example.co.uk');assert.equal(safety.registrable('www.tu-darmstadt.de'),'tu-darmstadt.de');
});

// ---------------------------------------------------------------- message tools
const tools=require('../client/js/message-tools.js');
test('translation batching and whitespace handling',()=>{
 assert.deepEqual(tools.batches(['a','b','c'],2,100),[[0,1],[2]]);
 assert.deepEqual(tools.batches(['aaaa','bbbb','cc'],10,8),[[0,1],[2]]);
 assert.deepEqual(tools.batches([]),[]);
 assert.deepEqual(tools.split('  hello world \n'),{lead:'  ',core:'hello world',tail:' \n'});
 assert.deepEqual(tools.split('x'),{lead:'',core:'x',tail:''});
});

const displayName=require('../server/services/display-name');
// ---------------------------------------------------------------- translation service
const translate=require('../server/services/translate');
function fakeTranslator(handler){
 return new Promise(resolve=>{
  const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>handler(req,JSON.parse(body||'{}'),res));});
  server.listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port}));
 });
}
test('translate: configuration rules',()=>{
 assert.equal(translate.fromEnv({}),null);
 assert.equal(translate.fromEnv({TRANSLATE_URL:'https://tr.example.edu/'}).endpoint,'https://tr.example.edu/translate');
 assert.equal(translate.fromEnv({TRANSLATE_URL:'http://localhost:5000',TRANSLATE_API_KEY:'k'}).key,'k');
 assert.throws(()=>translate.fromEnv({TRANSLATE_URL:'http://tr.example.edu'}),/https/);
 assert.doesNotThrow(()=>translate.fromEnv({TRANSLATE_URL:'http://tr.internal:5000',TRANSLATE_ALLOW_HTTP:'true'}));
 assert.throws(()=>translate.fromEnv({TRANSLATE_URL:'ftp://x'}),/http/);
 assert.throws(()=>translate.fromEnv({TRANSLATE_URL:'not a url'}),/valid URL/);
 assert.throws(()=>translate.fromEnv({TRANSLATE_URL:'https://x.example.edu/?q=1'}),/query/);
});
test('translate: limits and answers from the server are checked',async()=>{
 assert.throws(()=>translate.validate([]),{status:400});
 assert.throws(()=>translate.validate('x'),{status:400});
 assert.throws(()=>translate.validate([1]),{status:400});
 assert.throws(()=>translate.validate(['x'.repeat(translate.MAX_TEXT_CHARS+1)]),{status:413});
 assert.throws(()=>translate.validate(Array(translate.MAX_TEXTS+1).fill('a')),{status:413});
 assert.throws(()=>translate.validate(Array(10).fill('x'.repeat(4000))),{status:413});
 let seen;
 const good=await fakeTranslator((req,body,res)=>{seen={path:req.url,body};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({translatedText:body.q.map(t=>'EN:'+t),detectedLanguage:body.q.map(()=>({language:'de',confidence:90}))}));});
 const cfg=translate.fromEnv({TRANSLATE_URL:good.url,TRANSLATE_API_KEY:'secret'});
 const out=await translate.translateTexts(cfg,['Hallo','Welt']);
 assert.deepEqual(out,{translations:['EN:Hallo','EN:Welt'],detected:'de'});
 assert.equal(seen.path,'/translate');assert.equal(seen.body.target,'en');assert.equal(seen.body.source,'auto');assert.equal(seen.body.format,'text');assert.equal(seen.body.api_key,'secret');
 closeServer(good.server);
 const short=await fakeTranslator((req,body,res)=>{res.end(JSON.stringify({translatedText:['only one']}));});
 await assert.rejects(translate.translateTexts(translate.fromEnv({TRANSLATE_URL:short.url}),['a','b']),{status:502});
 closeServer(short.server);
 const bad=await fakeTranslator((req,body,res)=>{res.statusCode=500;res.end('boom');});
 await assert.rejects(translate.translateTexts(translate.fromEnv({TRANSLATE_URL:bad.url}),['a']),{status:502});
 closeServer(bad.server);
 await assert.rejects(translate.translateTexts({endpoint:'http://127.0.0.1:1/translate',key:'',timeoutMs:2000},['a']),/did not answer/);
});

// ---------------------------------------------------------------- routes
const configModule=require('../server/config');
const base=require('../server/server');
const imap=require('../server/services/mail-imap');
const smtp=require('../server/services/mail-smtp');
imap.verifyCredentials=async c=>{if(c.password!=='test-only-password'){const e=new Error('no');e.code='MAIL_AUTH';throw e;}};
imap.forget=()=>{};
const servers=[];
function start(env={}){
 const app=base.createApp(configModule.load({TU_MAIL_LOG:'off',LOGIN_IP_PER_MINUTE:'1000',LOGIN_ACCOUNT_FAILURES:'1000',...env}));
 const server=app.listen(0,'127.0.0.1');servers.push(server);
 return new Promise(r=>server.once('listening',()=>r({port:server.address().port})));
}
// fetch() keeps connections open, which would keep close() waiting.
const closeServer=s=>new Promise(r=>{s.close(r);s.closeAllConnections&&s.closeAllConnections();});
after(()=>Promise.all(servers.map(closeServer)));
function call({port},{method='GET',url='/',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,method,path:url,headers:{Host:'localhost:3210',...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const buf=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,buf,text:buf.toString(),json(){return JSON.parse(buf.toString());}});});
  });
  req.on('error',reject);req.end(data);
 });
}
const ORIGIN='http://localhost:3210';
let seq=0;
async function signIn(srv,chosen){
 const email=chosen||'p2user'+(++seq)+'@stud.tu-darmstadt.de';
 const res=await call(srv,{method:'POST',url:'/api/auth/login',headers:{Origin:ORIGIN},body:{email,username:'ab12cdef',password:'test-only-password'}});
 assert.equal(res.status,200);
 return {email,headers:{Cookie:res.headers['set-cookie'][0].split(';')[0],Origin:ORIGIN}};
}

test('display name: read from first.last addresses, never from an ID',()=>{
 const f=displayName.fromEmail;
 assert.equal(f('fahim.haque@stud.tu-darmstadt.de'),'Fahim Haque');
 assert.equal(f('anna-lena.mueller@tu-darmstadt.de'),'Anna Lena Mueller');
 assert.equal(f('max_mustermann@x.de'),'Max Mustermann');
 assert.equal(f('Jörg.Müller@x.de'),'Jörg Müller');
 for(const bad of ['fh97fijo@x.de','demo1234@x.de','j.doe@x.de','jane.doe2@x.de','a.b.c.d.e@x.de','@x.de','','x'])assert.equal(f(bad),'',JSON.stringify(bad)+' gives no name');
 assert.equal(displayName.forPerson('fh97fijo@x.de','  Fahim \Ul\ <Haque> '),'Fahim Ul Haque','a chosen name is cleaned');
 assert.equal(displayName.forPerson('fahim.haque@x.de',''),'Fahim Haque','empty choice falls back to the address');
 assert.equal(displayName.forPerson('fh97fijo@x.de',''),'');
 assert.equal(displayName.clean('x'.repeat(200)).length,80);
});

test('routes: outgoing mail carries a real name, never the TU-ID',async()=>{
 const srv=await start();const me=await signIn(srv,'fahim.haque@stud.tu-darmstadt.de');
 let captured=null;smtp.sendMessage=async(creds,o)=>{captured=o;return {savedToSent:true};};
 let n=0;
 const send=async(h)=>{const form=new FormData();form.append('mode','new');form.append('sendAttempt','name-attempt-aaaaaaaaaaaaaaaa-'+(++n));form.append('to',JSON.stringify([{address:'x@example.com'}]));form.append('subject','Hi');form.append('html','<p>Hi</p>');
  return fetch('http://127.0.0.1:'+srv.port+'/api/mail/send',{method:'POST',headers:{...h,Origin:'http://127.0.0.1:'+srv.port},body:form});};
 assert.equal((await send(me.headers)).status,200);assert.equal(captured.fromName,'Fahim Haque');assert.notEqual(captured.fromName,'ab12cdef');
 const idOnly=await signIn(srv,'fh97fijo@stud.tu-darmstadt.de');
 assert.equal((await send(idOnly.headers)).status,200);assert.equal(captured.fromName,'','an ID-style address gets no name rather than the ID');
});

test('routes: .eml export needs a session and is served as a download',async()=>{
 const srv=await start();const me=await signIn(srv);
 let asked=null;
 imap.exportMessage=async(creds,o)=>{asked=o;return {filename:'Hallo Welt ä (7).eml',content:Buffer.from('Subject: x\r\n\r\nbody')};};
 assert.equal((await call(srv,{url:'/api/mail/messages/7/export?folder=INBOX'})).status,401);
 const res=await call(srv,{url:'/api/mail/messages/7/export?folder=INBOX',headers:me.headers});
 assert.equal(res.status,200);assert.equal(res.headers['content-type'],'message/rfc822');
 assert.match(res.headers['content-disposition'],/^attachment; filename="[^"]*"; filename\*=UTF-8''Hallo%20Welt%20%C3%A4%20%287%29\.eml$/);
 assert.equal(res.headers['x-content-type-options'],'nosniff');assert.equal(res.headers['cache-control'],'private, no-store');
 assert.equal(res.text,'Subject: x\r\n\r\nbody');assert.deepEqual(asked,{folder:'INBOX',uid:7});
 assert.equal((await call(srv,{url:'/api/mail/messages/abc/export?folder=INBOX',headers:me.headers})).status,400);
 const real=require('../server/services/mail-imap');
 assert.equal(real.emlName(Buffer.from('Subject: =?utf-8?B?SGFsbG8gV2VsdCDDpA==?=\r\n\r\nx'),7),'Hallo Welt ä (7).eml');
 assert.equal(real.emlName(Buffer.from('Subject: ../../etc/passwd:*?\r\n\r\nx'),8),'.. .. etc passwd (8).eml');
 assert.equal(real.emlName(Buffer.from('X: y\r\n\r\nx'),9),'message (9).eml');
});

test('routes: list filters reach the mailbox layer',async()=>{
 const srv=await start();const me=await signIn(srv);
 let options=null;
 imap.listMessages=async(creds,o)=>{options=o;return {total:0,page:1,pageSize:40,messages:[]};};
 const res=await call(srv,{url:'/api/mail/messages?folder=INBOX&from=prof&since=2026-01-05&before=bad&flagged=1&attach=1&unread=1',headers:me.headers});
 assert.equal(res.status,200);
 assert.equal(options.filters.from,'prof');assert.equal(options.filters.flagged,true);assert.equal(options.filters.attach,true);
 assert.equal(options.filters.since.toISOString(),'2026-01-05T00:00:00.000Z');assert.equal('before' in options.filters,false);
 assert.equal(options.unreadOnly,true);
});

test('routes: translation is off by default and works through the configured server',async()=>{
 const off=await start();const me0=await signIn(off);
 assert.equal((await call(off,{url:'/api/brand'})).json().features.translate,false);
 assert.equal((await call(off,{method:'POST',url:'/api/mail/translate',headers:me0.headers,body:{texts:['Hallo']}})).status,501);
 const fake=await fakeTranslator((req,body,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({translatedText:body.q.map(t=>t.toUpperCase()),detectedLanguage:[{language:'de',confidence:99}]}));});
 const on=await start({TRANSLATE_URL:fake.url});const me=await signIn(on);
 assert.equal((await call(on,{url:'/api/brand'})).json().features.translate,true);
 assert.equal((await call(on,{method:'POST',url:'/api/mail/translate',headers:{Origin:ORIGIN},body:{texts:['x']}})).status,401);
 const ok=await call(on,{method:'POST',url:'/api/mail/translate',headers:me.headers,body:{texts:['hallo','welt']}});
 assert.equal(ok.status,200);assert.deepEqual(ok.json(),{translations:['HALLO','WELT'],detected:'de'});
 assert.equal((await call(on,{method:'POST',url:'/api/mail/translate',headers:me.headers,body:{texts:'no'}})).status,400);
 assert.equal((await call(on,{method:'POST',url:'/api/mail/translate',headers:me.headers,body:{texts:['x'.repeat(6000)]}})).status,413);
 let last;
 for(let i=0;i<45;i++)last=await call(on,{method:'POST',url:'/api/mail/translate',headers:me.headers,body:{texts:['a']}});
 assert.equal(last.status,429,'translation requests are rate limited per person');
 closeServer(fake.server);
});

// ---------------------------------------------------------------- pages
test('every client script compiles, and the offline shell lists every local file the pages load',()=>{
 for(const f of fs.readdirSync(path.join(client,'js')))new vm.Script(read('js/'+f),{filename:f});
 new vm.Script(read('sw.js'),{filename:'sw.js'});
 const sw=read('sw.js');
 for(const page of ['index.html','mail.html']){
  for(const m of read(page).matchAll(/(?:src|href)="((?:css|js|assets)\/[^"]+)"/g)){
   if(m[1].endsWith('.svg')||m[1].endsWith('.png')&&!m[1].includes('icon-192'))continue;
   assert.ok(sw.includes("'/"+m[1]+"'"),page+' loads '+m[1]+' but the service worker does not cache it');
  }
 }
});

test('the mail page carries the new controls, loaded in a safe order',()=>{
 const mail=read('mail.html');
 for(const id of ['chip-filters','mail-filter-panel','flt-from','flt-to','flt-subject','flt-since','flt-before','flt-attach','flt-flagged','flt-reset','saved-list','saved-name','saved-save','msg-export'])assert.ok(mail.includes('id="'+id+'"'),'missing #'+id);
 const order=f=>mail.indexOf('js/'+f);
 for(const early of ['safety.js','undo-send.js'])assert.ok(order(early)<order('auth.js'),early+' must load before the account menu is built');
 for(const late of ['mail-search.js','message-tools.js'])assert.ok(order(late)>order('mail-app.js'),late+' needs the app globals');
 assert.ok(read('js/mail-thread.js').includes('class="safety-slot"'));
 assert.ok(read('js/mail-thread.js').includes('data-act="translate"'));
 assert.ok(read('js/mail-compose.js').includes('window.UndoSend.wait()'));
 const shortcuts=read('js/shortcuts.js');
 for(const key of ["['x'"])assert.ok(shortcuts.includes(key));
});

test('German covers the new strings, including patterns',()=>{
 const i18n=require('../client/js/i18n.js');require('../client/js/i18n-de.js');
 i18n._reset('de');
 const t=s=>i18n.t(s);
 assert.equal(t('Filters (3)'),'Filter (3)');
 assert.equal(t('Undo send: 20 s'),'Senden rückgängig: 20 s');assert.equal(t('Sending in 7 s…'),'Senden in 7 s …');
 assert.equal(t('Translated to English from German.'),'Ins Englische übersetzt (aus: German).');
 assert.match(t('Translated to English from German. Only the first part of this long message was translated.'),/Nur der erste Teil/);
 assert.equal(t('A link shows "https://a.de" but leads to evil.org.'),'Ein Link zeigt „https://a.de“, führt aber zu evil.org.');
 assert.match(t("The sender's domain x.com looks very similar to y.com but is not the same."),/sieht y\.com sehr ähnlich/);
 i18n._reset('en');
});

test('sign-in: the full name typed at login becomes the sender name, but only after a successful sign-in',async()=>{
 const srv=await start();
 const login=(email,password,fullName)=>call(srv,{method:'POST',url:'/api/auth/login',headers:{Origin:ORIGIN},body:{email,username:'ab12cdef',password,...(fullName===undefined?{}:{fullName})}});
 const session=res=>({Cookie:res.headers['set-cookie'][0].split(';')[0],Origin:ORIGIN});
 const view=h=>call(srv,{url:'/api/mail/settings',headers:h}).then(r=>r.json());
 const email='fh12abcd@stud.tu-darmstadt.de'; // an ID-style address: no name can be read from it
 const wrong=await login(email,'wrong-password','Not Saved');
 assert.equal(wrong.status,401);
 const first=await login(email,'test-only-password','  Fahim  Ul   Haque ');
 assert.equal(first.status,200);assert.equal(first.json().user.name,'Fahim Ul Haque','the session shows the name, not the TU-ID');
 let v=await view(session(first));
 assert.equal(v.displayName,'Fahim Ul Haque');
 const blank=await login(email,'test-only-password','');
 assert.equal(blank.json().user.name,'Fahim Ul Haque','leaving it empty keeps the saved name');
 const none=await login(email,'test-only-password');
 assert.equal(none.json().user.name,'Fahim Ul Haque','API clients that send no name are unaffected');
 const changed=await login(email,'test-only-password','Fahim Haque');
 assert.equal((await view(session(changed))).displayName,'Fahim Haque','a new name replaces the old one');
 const junk=await login(email,'test-only-password','12345 !!!');
 assert.equal(junk.json().user.name,'Fahim Haque','a name without letters is ignored');
 const ctrl=await login(email,'test-only-password','Fa\u0000him\n"Haque"');
 assert.equal((await view(session(ctrl))).displayName,'Fa him Haque');
 const long=await login(email,'test-only-password','A'.repeat(300));
 assert.equal((await view(session(long))).displayName.length,80);
 const fresh=await login('anna.schmidt@stud.tu-darmstadt.de','test-only-password');
 assert.equal(fresh.json().user.name,'Anna Schmidt','with no typed name, one is read from a first.last address');
 const idOnly=await login('zz99qqrr@stud.tu-darmstadt.de','test-only-password');
 assert.equal(idOnly.json().user.name,'ab12cdef','nothing to show: the UI falls back to the TU-ID, mail goes out without a name');
 assert.equal((await view(session(idOnly))).displayName,'');
});

test('sign-in page asks for the full name and sends it',()=>{
 const html=read('index.html'),js=read('js/login.js');
 assert.match(html,/<input id="fullname" name="fullName" type="text" autocomplete="name"[^>]*required>/);
 assert.ok(html.indexOf('id="fullname"')>html.indexOf('id="email"')&&html.indexOf('id="fullname"')<html.indexOf('id="password"'));
 assert.match(js,/body\.fullName/);assert.match(js,/tu-mail-fullnames/);
});
