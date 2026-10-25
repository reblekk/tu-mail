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

// ---------------------------------------------------------------- reminders and message tools
const reminders=require('../client/js/reminders.js');
test('reminders: presets, due selection and stored data cleaning',()=>{
 const now=new Date(2026,9,26,10,0,0).getTime(); // Monday 10:00
 const list=reminders.presets(now);
 assert.deepEqual(list.map(p=>p.label),['In 1 hour','This evening','Tomorrow morning','Next week']);
 assert.equal(list[0].due,now+3600000);
 assert.equal(new Date(list[1].due).getHours(),18);
 assert.equal(new Date(list[2].due).getDate(),27);assert.equal(new Date(list[2].due).getHours(),8);
 assert.equal(new Date(list[3].due).getDay(),1,'next week is the coming Monday');
 assert.ok(list[3].due>now+6*86400000);
 const sunday=reminders.presets(new Date(2026,9,25,12,0,0).getTime());
 assert.equal(new Date(sunday[3].due).getDay(),1);
 assert.ok(sunday[3].due>sunday[2].due+86400000,'on a Sunday, next week is not tomorrow');
 const late=reminders.presets(new Date(2026,9,26,17,50,0).getTime());
 assert.ok(!late.some(p=>p.label==='This evening'),'no "this evening" when it is nearly evening');
 assert.deepEqual(reminders.dueNow([{due:5},{due:50}],10).map(r=>r.due),[5]);
 const clean=reminders.clean([{due:1,uid:2,folder:'INBOX',subject:'s'},{due:'x',uid:1,folder:'a'},null,{due:2,uid:'3',folder:'a'},{due:3,uid:4,folder:'INBOX',subject:'y'.repeat(500)}]);
 assert.equal(clean.length,2);assert.equal(clean[1].subject.length,200);
 assert.deepEqual(reminders.clean('nope'),[]);
});
const tools=require('../client/js/message-tools.js');
test('translation batching and whitespace handling',()=>{
 assert.deepEqual(tools.batches(['a','b','c'],2,100),[[0,1],[2]]);
 assert.deepEqual(tools.batches(['aaaa','bbbb','cc'],10,8),[[0,1],[2]]);
 assert.deepEqual(tools.batches([]),[]);
 assert.deepEqual(tools.split('  hello world \n'),{lead:'  ',core:'hello world',tail:' \n'});
 assert.deepEqual(tools.split('x'),{lead:'',core:'x',tail:''});
});

// ---------------------------------------------------------------- send-as identities
const identities=require('../server/services/identities');
const {allowedEmail}=require('../server/services/account-profiles');
test('identities: validation and resolution',()=>{
 const ctx={ownAddress:'me@stud.tu-darmstadt.de',isAllowed:allowedEmail};
 const ok=identities.sanitize([{name:' Dr. "Me" <x> ',address:'Alias@TU-Darmstadt.de'},{name:'dup',address:'alias@tu-darmstadt.de'},{name:'self',address:'ME@stud.tu-darmstadt.de'}],ctx);
 assert.deepEqual(ok.identities,[{name:'Dr. Me x',address:'alias@tu-darmstadt.de'}],'cleaned, de-duplicated, own address dropped');
 assert.throws(()=>identities.sanitize([{address:'a@gmail.com'}],ctx),/not on a domain/);
 assert.throws(()=>identities.sanitize([{address:'not-an-address'}],ctx),/valid email/);
 assert.throws(()=>identities.sanitize('x',ctx),{status:400});
 assert.throws(()=>identities.sanitize(Array.from({length:6},(_,i)=>({address:'a'+i+'@tu-darmstadt.de'})),ctx),/up to 5/);
 const own={name:'Me',address:'me@stud.tu-darmstadt.de'};
 const saved=[{name:'Alias',address:'alias@tu-darmstadt.de'}];
 assert.deepEqual(identities.resolve(saved,'',own),own);
 assert.deepEqual(identities.resolve(saved,'ME@stud.tu-darmstadt.de',own),own);
 assert.deepEqual(identities.resolve(saved,'alias@tu-darmstadt.de',own),{name:'Alias',address:'alias@tu-darmstadt.de'});
 assert.deepEqual(identities.resolve([{name:'',address:'b@tu-darmstadt.de'}],'b@tu-darmstadt.de',own),{name:'Me',address:'b@tu-darmstadt.de'},'falls back to the account name');
 assert.throws(()=>identities.resolve(saved,'boss@tu-darmstadt.de',own),{status:400});
 const smtp=require('../server/services/mail-smtp');
 const creds={email:'me@stud.tu-darmstadt.de'};
 assert.deepEqual(smtp.fromHeader({fromName:'Me',fromAddress:'alias@tu-darmstadt.de'},creds),{name:'Me',address:'alias@tu-darmstadt.de'});
 assert.equal(smtp.fromHeader({},creds),'me@stud.tu-darmstadt.de');
 assert.deepEqual(smtp.senderHeader({fromAddress:'alias@tu-darmstadt.de'},creds),{sender:'me@stud.tu-darmstadt.de'},'the submitting account is named');
 assert.deepEqual(smtp.senderHeader({fromAddress:'ME@stud.tu-darmstadt.de'},creds),{});
 assert.deepEqual(smtp.senderHeader({},creds),{});
});

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

test('routes: identities are saved per person, validated, and survive signature saves',async()=>{
 const srv=await start();const me=await signIn(srv);
 const get=await call(srv,{url:'/api/mail/identities',headers:me.headers});
 assert.equal(get.status,200);assert.deepEqual(get.json().identities,[]);assert.equal(get.json().own.address,me.email);
 assert.equal((await call(srv,{url:'/api/mail/identities'})).status,401);
 const put=await call(srv,{method:'PUT',url:'/api/mail/identities',headers:me.headers,body:{identities:[{name:'Group',address:'group@tu-darmstadt.de'}]}});
 assert.equal(put.status,200);assert.equal(put.json().identities[0].address,'group@tu-darmstadt.de');
 assert.equal((await call(srv,{method:'PUT',url:'/api/mail/identities',headers:me.headers,body:{identities:[{address:'x@gmail.com'}]}})).status,400);
 assert.equal((await call(srv,{method:'PUT',url:'/api/mail/identities',headers:me.headers,body:{identities:'no'}})).status,400);
 const sig=await call(srv,{method:'PUT',url:'/api/mail/settings',headers:me.headers,body:{signatureHtml:'<p>Regards</p>',useOnNew:true,useOnReply:true}});
 assert.equal(sig.status,200);
 assert.equal((await call(srv,{url:'/api/mail/identities',headers:me.headers})).json().identities.length,1,'saving the signature keeps identities');
 assert.equal((await call(srv,{url:'/api/mail/settings',headers:me.headers})).json().signatureHtml,'<p>Regards</p>');
 const other=await signIn(srv);
 assert.deepEqual((await call(srv,{url:'/api/mail/identities',headers:other.headers})).json().identities,[],'another person does not see them');
});

test('routes: send uses a saved identity and refuses an unsaved one',async()=>{
 const srv=await start();const me=await signIn(srv);
 await call(srv,{method:'PUT',url:'/api/mail/identities',headers:me.headers,body:{identities:[{name:'Group',address:'group@tu-darmstadt.de'}]}});
 let captured=null;
 smtp.sendMessage=async(creds,outgoing)=>{captured=outgoing;return {savedToSent:true};};
 const send=async(fromAddress,attempt)=>{
  const form=new FormData();
  form.append('mode','new');form.append('sendAttempt',attempt);form.append('to',JSON.stringify([{address:'x@example.com'}]));form.append('subject','Hi');form.append('html','<p>Hi</p>');
  if(fromAddress)form.append('fromAddress',fromAddress);
  return fetch('http://127.0.0.1:'+srv.port+'/api/mail/send',{method:'POST',headers:{...me.headers,Origin:'http://127.0.0.1:'+srv.port},body:form});
 };
 const bad=await send('boss@tu-darmstadt.de','attempt-aaaaaaaaaaaaaaaaaaaa-1');
 assert.equal(bad.status,400);assert.equal(captured,null,'nothing was submitted');
 const ok=await send('group@tu-darmstadt.de','attempt-aaaaaaaaaaaaaaaaaaaa-2');
 assert.equal(ok.status,200);assert.equal(captured.fromAddress,'group@tu-darmstadt.de');assert.equal(captured.fromName,'Group');
 captured=null;
 const own=await send('','attempt-aaaaaaaaaaaaaaaaaaaa-3');
 assert.equal(own.status,200);assert.equal(captured.fromAddress,me.email);
});

const displayName=require('../server/services/display-name');
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

test('routes: outgoing mail carries a real name, never the TU-ID, and the person can change it',async()=>{
 const srv=await start();const me=await signIn(srv,'fahim.haque@stud.tu-darmstadt.de');
 const view=(await call(srv,{url:'/api/mail/identities',headers:me.headers})).json();
 assert.equal(view.own.name,'Fahim Haque');assert.equal(view.suggested,'Fahim Haque');assert.equal(view.displayName,'');
 let captured=null;smtp.sendMessage=async(creds,o)=>{captured=o;return {savedToSent:true};};
 let n=0;
 const send=async()=>{const form=new FormData();form.append('mode','new');form.append('sendAttempt','name-attempt-aaaaaaaaaaaaaaaa-'+(++n));form.append('to',JSON.stringify([{address:'x@example.com'}]));form.append('subject','Hi');form.append('html','<p>Hi</p>');
  return fetch('http://127.0.0.1:'+srv.port+'/api/mail/send',{method:'POST',headers:{...me.headers,Origin:'http://127.0.0.1:'+srv.port},body:form});};
 assert.equal((await send()).status,200);assert.equal(captured.fromName,'Fahim Haque');assert.notEqual(captured.fromName,'ab12cdef');
 const put=(body)=>call(srv,{method:'PUT',url:'/api/mail/identities',headers:me.headers,body});
 const chosen=await put({identities:[],displayName:'Dr. Fahim \Ul\ Haque'});
 assert.equal(chosen.status,200);assert.equal(chosen.json().own.name,'Dr. Fahim Ul Haque');assert.equal(chosen.json().displayName,'Dr. Fahim Ul Haque');
 assert.equal((await send()).status,200);assert.equal(captured.fromName,'Dr. Fahim Ul Haque');
 await call(srv,{method:'PUT',url:'/api/mail/settings',headers:me.headers,body:{signatureHtml:'<p>x</p>',useOnNew:true,useOnReply:true}});
 assert.equal((await call(srv,{url:'/api/mail/identities',headers:me.headers})).json().displayName,'Dr. Fahim Ul Haque','saving the signature keeps the name');
 assert.equal((await put({identities:[]})).json().displayName,'Dr. Fahim Ul Haque','omitting the name keeps it');
 assert.equal((await put({identities:[],displayName:''})).json().own.name,'Fahim Haque','an empty name returns to the automatic one');
 const idOnly=await signIn(srv,'fh97fijo@stud.tu-darmstadt.de');
 assert.equal((await call(srv,{url:'/api/mail/identities',headers:idOnly.headers})).json().own.name,'','an ID-style address gets no name rather than the ID');
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
 for(const page of ['index.html','mail.html','calendar.html']){
  for(const m of read(page).matchAll(/(?:src|href)="((?:css|js|assets)\/[^"]+)"/g)){
   if(m[1].endsWith('.svg')||m[1].endsWith('.png')&&!m[1].includes('icon-192'))continue;
   assert.ok(sw.includes("'/"+m[1]+"'"),page+' loads '+m[1]+' but the service worker does not cache it');
  }
 }
});

test('the mail page carries the new controls, loaded in a safe order',()=>{
 const mail=read('mail.html');
 for(const id of ['chip-filters','mail-filter-panel','flt-from','flt-to','flt-subject','flt-since','flt-before','flt-attach','flt-flagged','flt-reset','saved-list','saved-name','saved-save','msg-remind','msg-export'])assert.ok(mail.includes('id="'+id+'"'),'missing #'+id);
 const order=f=>mail.indexOf('js/'+f);
 for(const early of ['safety.js','undo-send.js','reminders.js'])assert.ok(order(early)<order('auth.js'),early+' must load before the account menu is built');
 for(const late of ['mail-search.js','identities.js','message-tools.js'])assert.ok(order(late)>order('mail-app.js'),late+' needs the app globals');
 assert.ok(read('js/mail-thread.js').includes('class="safety-slot"'));
 assert.ok(read('js/mail-thread.js').includes('data-act="translate"'));
 assert.ok(read('js/mail-compose.js').includes('window.UndoSend.wait()'));
 const shortcuts=read('js/shortcuts.js');
 for(const key of ["['b'","['x'"])assert.ok(shortcuts.includes(key));
});

test('German covers the new strings, including patterns',()=>{
 const i18n=require('../client/js/i18n.js');require('../client/js/i18n-de.js');
 i18n._reset('de');
 const t=s=>i18n.t(s);
 assert.equal(t('Filters (3)'),'Filter (3)');
 assert.equal(t('Undo send: 20 s'),'Senden rückgängig: 20 s');assert.equal(t('Sending in 7 s…'),'Senden in 7 s …');
 assert.equal(t('In 1 hour · Mon, 26 Oct, 11:00 AM'),'In 1 Stunde · Mon, 26 Oct, 11:00 AM');
 assert.equal(t('Reminders (2)'),'Erinnerungen (2)');
 assert.equal(t('Translated to English from German.'),'Ins Englische übersetzt (aus: German).');
 assert.match(t('Translated to English from German. Only the first part of this long message was translated.'),/Nur der erste Teil/);
 assert.equal(t('A link shows "https://a.de" but leads to evil.org.'),'Ein Link zeigt „https://a.de“, führt aber zu evil.org.');
 assert.match(t("The sender's domain x.com looks very similar to y.com but is not the same."),/sieht y\.com sehr ähnlich/);
 i18n._reset('en');
});
