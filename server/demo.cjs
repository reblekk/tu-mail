// Isolated demonstration: this server never imports IMAP, SMTP or real sessions.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const app = express();
const client = path.join(__dirname, '../client');
const user = { userId:'demo', email:'demo@example.test', username:'demo', name:'Demo Student', role:'mail' };
const examples = [
 ['Welcome to your demo inbox','TUDa Mail Demo','welcome@example.test','This is a sample mailbox. Explore the folders and open messages to preview TUDa Mail. No university account is connected and no messages can be sent.'],
 ['Study group — Thursday at 16:00','Alex Morgan','alex@example.test','Hi! Shall we meet at the library at 16:00 on Thursday? Bring your notes from the last lecture. See you there!'],
 ['Your library reservation is ready','Campus Library (demo)','library@example.test','Your reserved study space is ready. This fictional message shows how university notifications appear in your inbox.'],
 ['Project meeting: agenda for next week','Seminar Team (demo)','seminar@example.test','For our next meeting, please prepare a short project update. Agenda: progress, questions, and next steps.'],
 ['Welcome week: discover the campus','Student Community (demo)','community@example.test','Join the campus tour and meet other students. This is fictional sample content for testing the mail interface.']
];
const messages = examples.map(([subject,name,address,text],i)=>({uid:100-i,folder:'INBOX',subject,from:{name,address},to:[{name:user.name,address:user.email}],cc:[],bcc:[],replyTo:[],date:new Date(Date.now()-i*3600000).toISOString(),messageId:'demo-'+i,references:[],threadIds:['demo-'+i],inReplyTo:'',seen:i>1,flagged:i===1,answered:false,fromSelf:false,html:'<p>'+text+'</p>',text,snippet:text,remoteImages:false,attachments:[]}));
const folders=['Inbox','Drafts','Sent','Archive','Trash'];
app.use(express.json());
app.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');next();});
app.get(['/', '/index.html','/mail.html'],(req,res)=>{
 let html=fs.readFileSync(path.join(client,'mail.html'),'utf8');
 html=html.replace('<script src="js/auth.js"></script>','<script>sessionStorage.setItem("tu-mail-user",'+JSON.stringify(JSON.stringify(user))+');</script><script src="js/auth.js"></script>');
 html=html.replace('<span>TUDa Mail</span>','<span>TUDa Mail · Demo</span>').replace('<span class="wide-title">Mail</span>','<span class="wide-title">Demo inbox</span>');
 html=html.replace('<body>','<body><div style="background:#fff4cf;color:#654c00;padding:10px 18px;text-align:center;font:13px system-ui">DEMO · Fictional emails · No account connected · Sending is disabled</div>');
 res.type('html').send(html);
});
app.get('/api/mail/folders',(req,res)=>res.json(folders.map((name,i)=>({path:i?name:'INBOX',name,role:['inbox','drafts','sent','archive','trash'][i],depth:0,selectable:true,unseen:i?0:messages.filter(m=>!m.seen).length}))));
app.get('/api/mail/messages',(req,res)=>{const q=String(req.query.q||'').toLowerCase();const found=messages.filter(m=>m.folder===req.query.folder&&(!q||(m.subject+' '+m.text+' '+m.from.name).toLowerCase().includes(q))&&(req.query.unread!=='1'||!m.seen));res.json({total:found.length,page:1,pageSize:40,messages:found,related:[]});});
app.post('/api/mail/previews',(req,res)=>res.json(Object.fromEntries(messages.filter(m=>(req.body.uids||[]).includes(m.uid)).map(m=>[m.uid,m.snippet]))));
app.get('/api/mail/thread',(req,res)=>{const m=messages.find(m=>m.uid===Number(req.query.uid));res.json({subject:m?.subject||'',messages:m?[m]:[],truncated:false});});
app.get('/api/mail/messages/:uid',(req,res)=>{const m=messages.find(m=>m.uid===Number(req.params.uid));if(!m)return res.status(404).json({error:'Demo message not found'});m.seen=true;res.json(m);});
app.get('/api/mail/settings',(req,res)=>res.json({signatureHtml:'',useOnNew:true,useOnReply:true}));
app.get('/api/mail/send-allowance',(req,res)=>res.json({remaining:0,limit:0}));
app.get('/api/auth/me',(req,res)=>res.json({user}));
app.post('/api/auth/logout',(req,res)=>res.json({ok:true}));
app.use('/api',(req,res)=>res.status(400).json({error:'This is a preview mailbox. Sending and mailbox changes are disabled.'}));
app.use(express.static(client));
app.listen(3211,'127.0.0.1',()=>console.log('Demo mailbox: http://127.0.0.1:3211'));

