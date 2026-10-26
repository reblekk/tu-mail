const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'tumail-p3-'));
process.env.TU_MAIL_DATA_DIR=DATA;
process.env.TU_MAIL_LOG='off';
const client=path.join(__dirname,'../client');
const read=f=>fs.readFileSync(path.join(client,f),'utf8');

// ---------------------------------------------------------------- routes
const configModule=require('../server/config');
const base=require('../server/server');
const imap=require('../server/services/mail-imap');
imap.verifyCredentials=async c=>{if(c.password!=='test-only-password'){const e=new Error('no');e.code='MAIL_AUTH';throw e;}};
imap.forget=()=>{};
const servers=[];
function start(){
 const app=base.createApp(configModule.load({TU_MAIL_LOG:'off',LOGIN_IP_PER_MINUTE:'1000',LOGIN_ACCOUNT_FAILURES:'1000'}));
 const server=app.listen(0,'127.0.0.1');servers.push(server);
 return new Promise(r=>server.once('listening',()=>r({port:server.address().port})));
}
after(()=>Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections&&s.closeAllConnections();}))));
function call({port},{method='GET',url='/',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,method,path:url,headers:{Host:'localhost:3210',...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const buf=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,text:buf.toString(),json(){return JSON.parse(buf.toString());}});});
  });
  req.on('error',reject);req.end(data);
 });
}
const ORIGIN='http://localhost:3210';
let seq=0;
async function signIn(srv){
 const email='p3user'+(++seq)+'@stud.tu-darmstadt.de';
 const res=await call(srv,{method:'POST',url:'/api/auth/login',headers:{Origin:ORIGIN},body:{email,username:'ab12cdef',password:'test-only-password'}});
 assert.equal(res.status,200);
 return {email,headers:{Cookie:res.headers['set-cookie'][0].split(';')[0],Origin:ORIGIN}};
}

// ---------------------------------------------------------------- notifications
const notify=require('../client/js/notify.js');
test('notifications: on or off, and an alert is the sender and the subject',()=>{
 assert.deepEqual(['off','detail'].map(notify.next),['detail','off']);
 const result={unseen:5,latest:[{uid:7,from:'Alex',subject:'Lunch?'},{uid:9,from:'Sam',subject:'Report'}]};
 assert.equal(notify.describe('off',result),null);
 assert.equal(notify.describe('detail',{unseen:0,latest:[]}),null);
 const several=notify.describe('detail',result);
 assert.equal(several.title,'New mail');assert.equal(several.body,'Sam — Report\nAlex — Lunch?','newest first');
 const single=notify.describe('detail',{unseen:1,latest:[{uid:3,from:'Alex',subject:'Lunch?'}]});
 assert.deepEqual(single,{title:'Alex',body:'Lunch?'},'one message: the name is the title, the subject the text');
 assert.equal(notify.describe('detail',{unseen:1,latest:[{uid:3,from:'',subject:''}]}).body,'(no subject)');
 const t=s=>'DE:'+s;
 assert.equal(notify.describe('detail',result,t).title,'DE:New mail');
});

// ---------------------------------------------------------------- pages
test('German covers the notification strings',()=>{
 const i18n=require('../client/js/i18n.js');require('../client/js/i18n-de.js');
 i18n._reset('de');const t=s=>i18n.t(s);
 assert.equal(t('Notifications: on'),'Benachrichtigungen: an');
 i18n._reset('en');
});

// ---------------------------------------------------------------- sign-in notification prompt and default pictures
test('notification prompt: asked once per sign-in, only when it can help',()=>{
 const base={page:'mail',flag:'1',mode:'off',supported:true,permission:'default'};
 assert.equal(notify.shouldPrompt(base),true);
 assert.equal(notify.shouldPrompt({...base,permission:'granted'}),true,'already allowed in the browser but switched off here: still ask');
 assert.equal(notify.shouldPrompt({...base,mode:'detail'}),false);
 assert.equal(notify.shouldPrompt({...base,flag:null}),false,'not a fresh sign-in (a reload, or a second tab)');
 assert.equal(notify.shouldPrompt({...base,page:'login'}),false,'only on the mail page');
 assert.equal(notify.shouldPrompt({...base,supported:false}),false);
 assert.equal(notify.shouldPrompt({...base,permission:'denied'}),false,'blocked in the browser: asking cannot help');
 const login=read('js/login.js'),code=read('js/notify.js');
 assert.match(login,/sessionStorage\.setItem\('tu-mail-notify-prompt', '1'\)/,'every successful sign-in sets the flag');
 assert.match(code,/sessionStorage\.removeItem\('tu-mail-notify-prompt'\)/,'the flag is used up, so a reload does not ask again');
 for(const label of ["'Allow'","'Not now'"])assert.ok(code.includes(label),'the prompt offers '+label);
 assert.ok(!/Count only|Sender and subject/.test(code),'no choice of detail level');
 assert.match(read('js/auth.js'),/tu-notify-changed/,'the menu label follows a choice made in the prompt');
});

test('pictures in messages are shown by default and the setting can turn them off',()=>{
 const vm=require('node:vm');
 const store=new Map();
 const sandbox={localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v))},document:{readyState:'complete',querySelector:()=>null,getElementById:()=>null,addEventListener(){}},addEventListener(){},TuI18n:{lang:'en'}};
 sandbox.window=sandbox;
 vm.runInNewContext(read('js/ui-prefs.js'),sandbox);
 const prefs=sandbox.TuPrefs;
 assert.equal(prefs.picturesOn(),true,'on by default');assert.equal(prefs.picturesLabel(),'Pictures: on');
 assert.equal(prefs.togglePictures(),'Pictures: off');assert.equal(prefs.picturesOn(),false);assert.equal(store.get('tu-mail-pictures'),'off');
 assert.equal(prefs.togglePictures(),'Pictures: on');assert.equal(prefs.picturesOn(),true);
 store.set('tu-mail-pictures','garbage');assert.equal(prefs.picturesOn(),true,'anything but "off" means on');
 const broken={...sandbox,localStorage:{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}}};broken.window=broken;
 vm.runInNewContext(read('js/ui-prefs.js'),broken);
 assert.equal(broken.TuPrefs.picturesOn(),true,'when storage is unavailable the default applies');
 assert.doesNotThrow(()=>broken.TuPrefs.togglePictures());
 const thread=read('js/mail-thread.js');
 assert.match(thread,/showImages: window\.TuPrefs \? window\.TuPrefs\.picturesOn\(\) : false/,'new cards follow the setting');
 assert.match(read('js/auth.js'),/picturesLabel\(\)/,'the account menu has the switch');
 assert.match(thread,/\.hidden = !m\.remoteImages \|\| card\.showImages/,'the "pictures are hidden" banner only shows when they are off');
});

test('German covers the notification prompt and the pictures switch',()=>{
 const i18n=require('../client/js/i18n.js');require('../client/js/i18n-de.js');
 i18n._reset('de');const t=s=>i18n.t(s);
 assert.equal(t('Turn on notifications?'),'Benachrichtigungen aktivieren?');
 assert.equal(t('Allow'),'Erlauben');assert.equal(t('Not now'),'Jetzt nicht');
 assert.equal(t('Pictures: on'),'Bilder: an');assert.equal(t('Pictures: off'),'Bilder: aus');
 i18n._reset('en');
});

test('mail page layout: sync button in the filter row, account menu is an icon, no Contacts or Calendar in the sidebar',()=>{
 const mail=read('mail.html'),auth=read('js/auth.js'),tools=read('js/mail-tools.js');
 const filters=mail.slice(mail.indexOf('class="mail-filters"'),mail.indexOf('id="mail-filter-panel"'));
 assert.ok(filters.includes('id="mail-refresh-top"'),'sync button is in the filter row');
 const header=mail.slice(mail.indexOf('<div class="page-title">'),mail.indexOf('id="mail-state-loading"'));
 assert.ok(!header.includes('mail-refresh-top'),'and no longer in the header');
 assert.match(auth,/trigger\.innerHTML='<svg/,'the account menu shows an icon');
 assert.ok(!/trigger\.textContent='Account'/.test(auth));assert.match(auth,/aria-label','Account menu'/,'it keeps an accessible name');
 const sidebar=mail.slice(mail.indexOf('id="mail-folders"'),mail.indexOf('id="mail-scrim"'));
 assert.ok(!/Calendar|calendar\.html/.test(sidebar),'no Calendar in the sidebar');
 assert.ok(!/\['Contacts',contacts\]/.test(tools),'no Contacts button in the sidebar tools');
 assert.match(tools,/window\.MailContacts=\{open:contacts\}/);assert.match(auth,/button\('Contacts'/,'Contacts opens from the account menu');
});

test('the Sent folder is shown as "Sent", only by name',async()=>{
 const names=require('../server/services/folder-names');
 const list=[{path:'INBOX',name:'Inbox',role:'inbox'},{path:'Sent Items',name:'Sent Items',role:'sent'},{path:'Sent',name:'sent items',role:'sent'},{path:'Deleted Items',name:'Deleted Items',role:'trash'},{path:'Projects/Sent Items',name:'Sent Items',role:'other'}];
 const out=names.tidy(list);
 assert.deepEqual(out.map(f=>f.name),['Inbox','Sent','Sent','Deleted Items','Sent Items'],'only the special Sent folder is renamed');
 assert.deepEqual(out.map(f=>f.path),list.map(f=>f.path),'paths are never touched');
 assert.equal(list[1].name,'Sent Items','the input is not modified');
 assert.deepEqual(names.tidy([]),[]);
 const srv=await start();const me=await signIn(srv);
 imap.listFolders=async()=>list;
 const res=await call(srv,{url:'/api/mail/folders',headers:me.headers});
 assert.equal(res.status,200);assert.equal(res.json().find(f=>f.path==='Sent Items').name,'Sent');
 assert.ok(!read('js/mail-compose.js').includes('saved to Sent Items'),'messages say Sent too');
});

test('menus show a person by name, not by address',async()=>{
 const auth=read('js/auth.js');
 assert.match(auth,/function personLabel\(person\)/);
 assert.match(auth,/name\.textContent=personLabel\(user\)/,'the account menu header uses the name');
 assert.match(auth,/const entry=button\(personLabel\(account\)/,'other signed-in accounts are listed by name');
 assert.ok(!/account\.email\+' · '\+account\.profile/.test(auth),'no "address · student" labels');
 assert.match(auth,/entry\.title=account\.email/,'the address stays available as a tooltip');
 // the same rule, run: a name that is just the TU-ID is not shown as a name
 const label=new Function(auth.match(/function personLabel\(person\)\{[^\n]*\}/)[0]+';return personLabel;')();
 assert.equal(label({name:'Sharvee Shabnam',username:'sh12abcd',email:'sharvee.shabnam@stud.tu-darmstadt.de'}),'Sharvee Shabnam');
 assert.equal(label({name:'sh12abcd',username:'sh12abcd',email:'a@stud.tu-darmstadt.de'}),'a@stud.tu-darmstadt.de','the TU-ID is not a name');
 assert.equal(label({username:'x',email:'a@b.de'}),'a@b.de');
 assert.equal(label(null),'');
 // server side: accounts in the session carry the name
 const srv=await start();
 const login=await call(srv,{method:'POST',url:'/api/auth/login',headers:{Origin:ORIGIN},body:{email:'sh12abcd@stud.tu-darmstadt.de',username:'sh12abcd',password:'test-only-password',fullName:'Sharvee Shabnam'}});
 const h={Cookie:login.headers['set-cookie'][0].split(';')[0],Origin:ORIGIN};
 const accounts=()=>call(srv,{url:'/api/auth/accounts',headers:h}).then(r=>r.json().accounts[0]);
 assert.equal((await accounts()).name,'Sharvee Shabnam');
});
