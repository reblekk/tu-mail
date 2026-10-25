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
const calendar=require('../server/services/calendar');

const ics=(lines,method='REQUEST')=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//t//EN','METHOD:'+method,...lines,'END:VCALENDAR',''].join('\r\n');
const vevent=(extra=[],uid='u1@example')=>['BEGIN:VEVENT','UID:'+uid,'DTSTAMP:20261001T000000Z','DTSTART:20261026T080000Z','DTEND:20261026T090000Z','SUMMARY:Seminar','LOCATION:Room 1',...extra,'END:VEVENT'];

// ---------------------------------------------------------------- calendar service
test('calendar: adding, updating and cancelling an invitation',async()=>{
 const who='cal1@x.de';
 const first=await calendar.addInvitation(who,ics(vevent()));
 assert.deepEqual([first.added,first.updated,first.removed],[1,0,0]);
 const again=await calendar.addInvitation(who,ics(vevent(['SEQUENCE:1']).map(l=>l==='SUMMARY:Seminar'?'SUMMARY:Seminar (moved)':l)));
 assert.deepEqual([again.added,again.updated],[0,1],'same UID updates in place');
 let events=await calendar.list(who,'2026-10-01','2026-11-30');
 assert.equal(events.length,1);assert.equal(events[0].title,'Seminar (moved)');assert.equal(events[0].start,'2026-10-26T08:00:00.000Z');
 const gone=await calendar.addInvitation(who,ics(vevent(),'CANCEL'));
 assert.equal(gone.removed,1);
 assert.deepEqual(await calendar.list(who,'2026-10-01','2026-11-30'),[]);
 const none=await calendar.addInvitation(who,ics(vevent(),'CANCEL'));
 assert.deepEqual([none.added,none.removed],[0,0],'cancelling something unknown is harmless');
});

test('calendar: recurring events expand inside the requested range only',async()=>{
 const who='cal2@x.de';
 await calendar.addInvitation(who,ics(vevent(['RRULE:FREQ=WEEKLY;COUNT=4'])));
 const all=await calendar.list(who,'2026-10-01','2026-12-31');
 assert.deepEqual(all.map(e=>e.start.slice(0,10)),['2026-10-26','2026-11-02','2026-11-09','2026-11-16']);
 const some=await calendar.list(who,'2026-11-05','2026-11-12');
 assert.deepEqual(some.map(e=>e.start.slice(0,10)),['2026-11-09']);
 assert.deepEqual(await calendar.list(who,'2027-03-01','2027-03-20'),[]);
 const forever=['BEGIN:VEVENT','UID:daily@x','DTSTAMP:20261001T000000Z','DTSTART:20260101T100000Z','DTEND:20260101T110000Z','RRULE:FREQ=DAILY','SUMMARY:Daily','END:VEVENT'];
 await calendar.addInvitation(who,ics(forever));
 const month=await calendar.list(who,'2026-10-01','2026-10-31');
 assert.ok(month.filter(e=>e.title==='Daily').length>=28&&month.filter(e=>e.title==='Daily').length<=32,'an endless rule only yields the days asked for');
});

test('calendar: creating events and validating input',async()=>{
 const who='cal3@x.de';
 const timed=await calendar.create(who,{title:'  Dentist  ',start:'2026-10-27T14:00:00.000Z',location:'Main st'});
 assert.match(timed.id,/^[0-9a-f]{24}$/);
 const day=await calendar.create(who,{title:'Holiday',allDay:true,start:'2026-10-30',end:'2026-11-01'});
 const list=await calendar.list(who,'2026-10-25','2026-11-03');
 const dentist=list.find(e=>e.title==='Dentist'),holiday=list.find(e=>e.title==='Holiday');
 assert.equal(dentist.end,'2026-10-27T15:00:00.000Z','default length is one hour');
 assert.deepEqual([holiday.allDay,holiday.start,holiday.end],[true,'2026-10-30','2026-11-02'],'all-day end is exclusive');
 await assert.rejects(calendar.create(who,{title:'   ',start:'2026-10-27T14:00:00.000Z'}),/title/);
 await assert.rejects(calendar.create(who,{title:'x',start:'tomorrow'}),/date and time/);
 await assert.rejects(calendar.create(who,{title:'x',allDay:true,start:'2026-02-30'}),/valid date/);
 await assert.rejects(calendar.create(who,{title:'x',start:'2026-10-27T14:00:00.000Z',end:'2026-10-27T13:00:00.000Z'}),/cannot end before/);
 await assert.rejects(calendar.create(who,{title:'x',allDay:true,start:'2026-10-30',end:'2026-10-29'}),/cannot end before/);
 const details=await calendar.details(who,timed.id);
 assert.equal(details.location,'Main st');assert.equal(details.source,'manual');
 await calendar.remove(who,day.id);
 assert.equal((await calendar.list(who,'2026-10-25','2026-11-03')).some(e=>e.title==='Holiday'),false);
 await assert.rejects(calendar.remove(who,day.id),{status:404});
 await assert.rejects(calendar.details(who,'0'.repeat(24)),{status:404});
});

test('calendar: ranges, bad files and separation between people',async()=>{
 const who='cal4@x.de';
 await assert.rejects(calendar.list(who,'2026-10-01','2026-09-01'),/after/);
 await assert.rejects(calendar.list(who,'nope','2026-09-01'),/YYYY-MM-DD/);
 await assert.rejects(calendar.list(who,'2026-01-01','2026-12-31'),/at most/);
 await assert.rejects(calendar.addInvitation(who,'not a calendar'),/valid calendar/);
 await assert.rejects(calendar.addInvitation(who,'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'),/no event/i);
 await assert.rejects(calendar.addInvitation(who,Buffer.alloc(600*1024,'a')),/too large/);
 await assert.rejects(calendar.addInvitation(who,ics(['BEGIN:VEVENT','UID:x','SUMMARY:No start','END:VEVENT'])),/start/);
 await calendar.create(who,{title:'Mine',start:'2026-10-27T14:00:00.000Z'});
 assert.deepEqual(await calendar.list('someone-else@x.de','2026-10-01','2026-12-01'),[]);
});

test('calendar: simultaneous saves are not lost, and the export is one valid file',async()=>{
 const who='cal5@x.de';
 await Promise.all(Array.from({length:20},(_,i)=>calendar.create(who,{title:'Event '+i,start:'2026-11-'+String(1+i%20).padStart(2,'0')+'T10:00:00.000Z'})));
 const events=await calendar.list(who,'2026-10-31','2026-12-01');
 assert.equal(events.length,20);
 await calendar.addInvitation(who,ics(vevent(['RRULE:FREQ=WEEKLY;COUNT=2'],'rec@x')));
 const out=await calendar.exportIcs(who);
 assert.equal((out.match(/BEGIN:VCALENDAR/g)||[]).length,1);
 assert.equal((out.match(/BEGIN:VEVENT/g)||[]).length,21);
 assert.match(out,/RRULE:FREQ=WEEKLY;COUNT=2/);
 assert.match(out,/^BEGIN:VCALENDAR\r\n/);
 const again=calendar.parseIcs(out);assert.equal(again.vevents.length,21,'the export can be read back');
});

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

test('routes: calendar needs a session and works end to end',async()=>{
 const srv=await start();const me=await signIn(srv);
 assert.equal((await call(srv,{url:'/api/mail/calendar/events?from=2026-10-01&to=2026-11-01'})).status,401);
 assert.equal((await call(srv,{url:'/api/mail/calendar/export.ics'})).status,401);
 const made=await call(srv,{method:'POST',url:'/api/mail/calendar/events',headers:me.headers,body:{title:'Lecture',start:'2026-10-27T08:00:00.000Z',end:'2026-10-27T09:30:00.000Z',location:'Hall 3'}});
 assert.equal(made.status,200);const id=made.json().id;
 const list=await call(srv,{url:'/api/mail/calendar/events?from=2026-10-25&to=2026-11-02',headers:me.headers});
 assert.equal(list.status,200);assert.equal(list.json().events[0].title,'Lecture');
 assert.equal((await call(srv,{url:'/api/mail/calendar/events/'+id,headers:me.headers})).json().location,'Hall 3');
 assert.equal((await call(srv,{method:'POST',url:'/api/mail/calendar/events',headers:me.headers,body:{title:'',start:'2026-10-27T08:00:00.000Z'}})).status,400);
 assert.equal((await call(srv,{url:'/api/mail/calendar/events?from=2026-01-01&to=2026-12-31',headers:me.headers})).status,400);
 assert.equal((await call(srv,{url:'/api/mail/calendar/events/not-an-id',headers:me.headers})).status,404);
 const file=await call(srv,{url:'/api/mail/calendar/export.ics',headers:me.headers});
 assert.equal(file.status,200);assert.match(file.headers['content-type'],/text\/calendar/);assert.match(file.headers['content-disposition'],/attachment; filename="calendar\.ics"/);
 assert.match(file.text,/SUMMARY:Lecture/);assert.equal(file.headers['x-content-type-options'],'nosniff');
 const other=await signIn(srv);
 assert.deepEqual((await call(srv,{url:'/api/mail/calendar/events?from=2026-10-25&to=2026-11-02',headers:other.headers})).json().events,[],'events belong to one person');
 assert.equal((await call(srv,{method:'DELETE',url:'/api/mail/calendar/events/'+id,headers:other.headers})).status,404,'nobody else can delete it');
 assert.equal((await call(srv,{method:'DELETE',url:'/api/mail/calendar/events/'+id,headers:me.headers})).status,200);
 assert.deepEqual((await call(srv,{url:'/api/mail/calendar/events?from=2026-10-25&to=2026-11-02',headers:me.headers})).json().events,[]);
});

test('routes: an invitation is added to the calendar only when asked',async()=>{
 const srv=await start();const me=await signIn(srv);
 let asked=null;
 imap.readAttachment=async(creds,o)=>{asked=o;return {filename:'invite.ics',contentType:'text/calendar',content:Buffer.from(ics(vevent(['RRULE:FREQ=WEEKLY;COUNT=2'],'route@x')))};};
 const before=await call(srv,{url:'/api/mail/calendar/events?from=2026-10-20&to=2026-11-20',headers:me.headers});
 assert.deepEqual(before.json().events,[],'reading the invitation does not add it');
 const add=await call(srv,{method:'POST',url:'/api/mail/messages/12/invitation/0/calendar',headers:me.headers,body:{folder:'INBOX'}});
 assert.equal(add.status,200);assert.equal(add.json().added,1);assert.deepEqual(asked,{folder:'INBOX',uid:12,index:0});
 const after=await call(srv,{url:'/api/mail/calendar/events?from=2026-10-20&to=2026-11-20',headers:me.headers});
 assert.equal(after.json().events.length,2);
 const twice=await call(srv,{method:'POST',url:'/api/mail/messages/12/invitation/0/calendar',headers:me.headers,body:{folder:'INBOX'}});
 assert.equal(twice.json().updated,1);
 assert.equal((await call(srv,{method:'POST',url:'/api/mail/messages/12/invitation/0/calendar',body:{folder:'INBOX'}})).status,403,'no session, no origin: refused');
});

// ---------------------------------------------------------------- calendar page logic
const page=require('../client/js/calendar.js');
test('calendar page: grid start, day spans and ordering',()=>{
 assert.equal(page.ymd(page.gridStart(2026,9)),'2026-09-28','October 2026 starts on a Thursday, so the grid starts the Monday before');
 assert.equal(page.ymd(page.gridStart(2026,10)),'2026-10-26','a month starting on Sunday begins six days earlier');
 assert.equal(page.ymd(page.gridStart(2026,5)),'2026-06-01','a month starting on Monday begins that day');
 assert.deepEqual(page.daysOf({allDay:true,start:'2026-10-30',end:'2026-11-02'}),['2026-10-30','2026-10-31','2026-11-01']);
 assert.deepEqual(page.daysOf({allDay:true,start:'2026-10-30',end:'2026-10-30'}),['2026-10-30'],'at least one day');
 const at=(d,h,m=0)=>new Date(2026,9,d,h,m).toISOString();
 assert.deepEqual(page.daysOf({start:at(26,23),end:at(27,1)}),['2026-10-26','2026-10-27']);
 assert.deepEqual(page.daysOf({start:at(26,9),end:at(27,0)}),['2026-10-26'],'ending at midnight does not spill over');
 assert.deepEqual(page.daysOf({start:at(26,9),end:at(26,9)}),['2026-10-26']);
 const map=page.byDay([{title:'b',start:at(26,14),end:at(26,15)},{title:'a',start:at(26,9),end:at(26,10)},{title:'all',allDay:true,start:'2026-10-26',end:'2026-10-27'}]);
 assert.deepEqual(map.get('2026-10-26').map(e=>e.title),['all','a','b'],'all-day first, then by time');
});

// ---------------------------------------------------------------- notifications
const notify=require('../client/js/notify.js');
test('notifications: modes cycle and the text matches the privacy level',()=>{
 assert.deepEqual(['off','count','detail','off'].map(notify.next),['count','detail','off','count']);
 const result={unseen:5,latest:[{uid:7,from:'Alex',subject:'Lunch?'},{uid:9,from:'Sam',subject:'Report'}]};
 assert.equal(notify.describe('off',result),null);
 assert.equal(notify.describe('count',{unseen:0,latest:[]}),null);
 assert.deepEqual(notify.describe('count',result),{title:'New mail',body:'You have 5 unread messages'});
 assert.equal(notify.describe('count',{unseen:1,latest:[{uid:1}]}).body,'You have 1 unread message');
 const detail=notify.describe('detail',result);
 assert.equal(detail.title,'New mail');assert.equal(detail.body,'Sam — Report\nAlex — Lunch?','newest first');
 const one=notify.describe('detail',{unseen:1,latest:[{uid:3,from:'',subject:''}]});
 assert.equal(one.title,'New message');assert.equal(one.body,'? — (no subject)');
 assert.ok(!/Lunch|Alex/.test(notify.describe('count',result).body),'count mode reveals no sender or subject');
 const t=s=>'DE:'+s;
 assert.equal(notify.describe('count',result,t).title,'DE:New mail');
});

// ---------------------------------------------------------------- pages
test('the calendar page and the mail page link to each other and the menu knows which page it is on',()=>{
 const cal=read('calendar.html'),mail=read('mail.html');
 for(const id of ['cal-prev','cal-today','cal-next','cal-heading','view-month','view-agenda','cal-new','cal-export','cal-grid','cal-agenda','cal-day','cal-day-add','profile-menu'])assert.ok(cal.includes('id="'+id+'"'),'calendar page lacks #'+id);
 assert.match(cal,/<body data-page="calendar">/);assert.match(mail,/<body data-page="mail">/);
 assert.match(cal,/href="mail\.html"/);assert.match(mail,/id="open-calendar" href="calendar\.html"/);
 assert.ok(cal.indexOf('js/auth.js')<cal.indexOf('js/calendar.js'));
 assert.ok(mail.indexOf('js/notify.js')<mail.indexOf('js/auth.js'),'notify loads before the account menu is built');
 const auth=read('js/auth.js');
 assert.match(auth,/dataset\.page==='mail'/);assert.match(auth,/MailNotify/);assert.match(auth,/if\(window\.showShortcuts\)/);
 assert.ok(read('js/mail-tools.js').includes("'/calendar'"),'the invitation dialog can add to the calendar');
 assert.ok(!read('js/mail-tools.js').includes('does not add an event to a local calendar'));
});

test('German covers the calendar and notification strings',()=>{
 const i18n=require('../client/js/i18n.js');require('../client/js/i18n-de.js');
 i18n._reset('de');const t=s=>i18n.t(s);
 assert.equal(t('Calendar'),'Kalender');assert.equal(t('All day'),'Ganztägig');
 assert.equal(t('Location: Room 4'),'Ort: Raum 4'.replace('Raum 4','Room 4'));
 assert.equal(t('Starts: Mon 9:00'),'Beginn: Mon 9:00');
 assert.equal(t('Monday, 26 October 2026, 2 events'),'Monday, 26 October 2026, 2 Termine');
 assert.equal(t('Friday, 30 October 2026, 1 event'),'Friday, 30 October 2026, 1 Termin');
 assert.equal(t('You have 3 unread messages'),'Sie haben 3 ungelesene Nachrichten');
 assert.equal(t('You have 1 unread message'),'Sie haben 1 ungelesene Nachricht');
 assert.equal(t('Notifications: count only'),'Benachrichtigungen: nur Anzahl');
 i18n._reset('en');
});
