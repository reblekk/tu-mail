const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
process.env.TU_MAIL_LOG='off';
const configModule=require('../server/config');
const {createLoginLimiter}=require('../server/middleware/rate-limit');
const logger=require('../server/middleware/logger');
const imap=require('../server/services/mail-imap');
const base=require('../server/server');
const PASSWORD='test-only-password';
imap.verifyCredentials=async c=>{if(c.password!==PASSWORD){const e=new Error('Rejected');e.code='MAIL_AUTH';throw e;}};
imap.forget=()=>{};

const servers=[];
function start(env){
 const app=base.createApp(configModule.load({TU_MAIL_LOG:'off',...env}));
 const server=app.listen(0,'127.0.0.1');servers.push(server);
 return new Promise(resolve=>server.once('listening',()=>resolve({app,port:server.address().port})));
}
after(()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r)))));
// fetch() cannot set Host, which the public-URL checks depend on.
function call({port},{method='GET',url='/',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,method,path:url,headers:{...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...headers}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json(){return JSON.parse(text);}}));
  });
  req.on('error',reject);req.end(data);
 });
}
const HOST='mail.example.edu',ORIGIN='https://'+HOST;
const login=(srv,extra={},body={})=>call(srv,{method:'POST',url:'/api/auth/login',headers:{Host:HOST,Origin:ORIGIN,...extra},body:{email:'a@stud.tu-darmstadt.de',username:'ab12cdef',password:PASSWORD,...body}});
const PUBLIC={PUBLIC_URL:ORIGIN,TRUST_PROXY:'1'};

test('config: local defaults, public URL validation and proxy trust',()=>{
 const local=configModule.load({});
 assert.equal(local.bindHost,'127.0.0.1');assert.equal(local.publicUrl,null);assert.equal(local.secureCookies,false);
 const pub=configModule.load({PUBLIC_URL:ORIGIN});
 assert.equal(pub.bindHost,'0.0.0.0');assert.equal(pub.secureCookies,true);assert.equal(pub.hsts,true);assert.equal(pub.trustProxy,false);
 assert.equal(configModule.load({TRUST_PROXY:'2'}).trustProxy,2);
 assert.throws(()=>configModule.load({TRUST_PROXY:'true'}),/hop count/);
 assert.throws(()=>configModule.load({PUBLIC_URL:'http://mail.example.edu'}),/https/);
 assert.throws(()=>configModule.load({PUBLIC_URL:ORIGIN+'/app'}),/bare origin/);
 assert.doesNotThrow(()=>configModule.load({PUBLIC_URL:'http://localhost:3210'}));
 assert.equal(configModule.hostAllowed(local,'localhost:3210'),true);
 assert.equal(configModule.hostAllowed(local,HOST),false);
 assert.equal(configModule.hostAllowed(pub,HOST),true);
 assert.equal(configModule.hostAllowed(pub,'localhost:3210'),false);
 assert.equal(configModule.expectedOrigin(pub,'anything'),ORIGIN);
 assert.equal(configModule.expectedOrigin(local,'localhost:3210'),'http://localhost:3210');
});

test('rate limiter: per-IP window, per-account failures, reset on success',()=>{
 let t=0;const l=createLoginLimiter({ipPerMinute:3,accountFailures:2,accountWindowMs:600000},()=>t);
 assert.deepEqual([l.checkIp('1'),l.checkIp('1'),l.checkIp('1')],[0,0,0]);
 assert.ok(l.checkIp('1')>0);
 assert.equal(l.checkIp('2'),0,'other IPs are unaffected');
 t=61000;assert.equal(l.checkIp('1'),0,'window expires');
 l.recordFailure('a');assert.equal(l.checkAccount('a'),0);
 l.recordFailure('a');assert.ok(l.checkAccount('a')>0);
 assert.equal(l.checkAccount('b'),0);
 l.recordSuccess('a');assert.equal(l.checkAccount('a'),0);
 l.recordFailure('a');l.recordFailure('a');t+=600001;assert.equal(l.checkAccount('a'),0,'failures age out');
 l.sweep();assert.deepEqual(l.size(),{ips:0,accounts:0});
});

test('logger writes fixed fields and hashes identities',()=>{
 const lines=[];const {log,requests,who}=logger.create({sink:l=>lines.push(l)});
 log('login_ok',{who:who('Student@TU-Darmstadt.de'),ip:'1.2.3.4'});
 const res={statusCode:200,on(ev,fn){this.finish=fn;}};
 requests({method:'GET',path:'/api/mail/messages',query:{folder:'Secret'},url:'/api/mail/messages?folder=Secret',ip:'1.2.3.4'},res,()=>{});res.finish();
 const text=lines.join('\n');
 assert.equal(lines.length,2);
 assert.ok(!/student|Secret|tu-darmstadt/i.test(text));
 assert.equal(JSON.parse(lines[0]).who,who('student@tu-darmstadt.de'));
 assert.deepEqual(Object.keys(JSON.parse(lines[1])).sort(),['event','ip','method','ms','path','status','time']);
 assert.equal(logger.create({enabled:false,sink:l=>lines.push(l)}).log('x'),undefined);
 assert.equal(lines.length,2);
});

test('public mode: host and origin checks, headers, secure cookie',async()=>{
 const srv=await start(PUBLIC);
 assert.equal((await call(srv,{headers:{Host:'evil.example'}})).status,403);
 assert.equal((await call(srv,{headers:{Host:'localhost:3210'}})).status,403);
 const page=await call(srv,{headers:{Host:HOST}});
 assert.equal(page.status,200);
 const csp=page.headers['content-security-policy'];
 assert.match(csp,/default-src 'none'/);assert.match(csp,/script-src 'self'(;|$)/);assert.match(csp,/frame-ancestors 'none'/);assert.match(csp,/object-src 'none'/);
 assert.match(csp,/img-src [^;]*https:/);assert.doesNotMatch(csp,/img-src [^;]*\shttp:/);assert.doesNotMatch(csp,/script-src[^;]*unsafe/);
 assert.match(page.headers['strict-transport-security'],/max-age=\d+/);
 assert.equal(page.headers['x-frame-options'],'DENY');assert.equal(page.headers['x-content-type-options'],'nosniff');
 assert.ok(page.headers['permissions-policy']);assert.equal(page.headers['referrer-policy'],'no-referrer');
 assert.equal((await login(srv,{Origin:'http://'+HOST})).status,403,'wrong scheme');
 assert.equal((await login(srv,{Origin:'https://evil.example'})).status,403);
 assert.equal((await call(srv,{method:'POST',url:'/api/auth/login',headers:{Host:HOST},body:{}})).status,403,'missing origin');
 const ok=await login(srv);
 assert.equal(ok.status,200);
 const cookie=ok.headers['set-cookie'][0];
 assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.ok(!cookie.includes(PASSWORD));
 assert.equal((await call(srv,{url:'/api/auth/me',headers:{Host:HOST,Cookie:cookie.split(';')[0]}})).status,200);
});

test('local mode sends no HSTS and still refuses a foreign Host',async()=>{
 const srv=await start({});
 const res=await call(srv,{headers:{Host:'localhost:3210'}});
 assert.equal(res.status,200);assert.equal(res.headers['strict-transport-security'],undefined);
 assert.equal((await call(srv,{headers:{Host:HOST}})).status,403);
});

test('health endpoint reveals nothing but liveness',async()=>{
 const srv=await start(PUBLIC);
 const res=await call(srv,{url:'/api/health',headers:{Host:HOST}});
 assert.equal(res.status,200);assert.deepEqual(res.json(),{ok:true});
 assert.equal(res.headers['cache-control'],'no-store');
});

test('login is throttled per IP, and the proxy header counts only when trusted',async()=>{
 const trusted=await start({...PUBLIC,LOGIN_IP_PER_MINUTE:'3'});
 const as=ip=>({'X-Forwarded-For':ip});
 for(let i=0;i<3;i++)assert.equal((await login(trusted,as('10.0.0.1'),{password:'wrong'})).status,401);
 const blocked=await login(trusted,as('10.0.0.1'));
 assert.equal(blocked.status,429);assert.ok(Number(blocked.headers['retry-after'])>0);
 assert.equal((await login(trusted,as('10.0.0.2'))).status,200,'a different client is unaffected');
 const direct=await start({PUBLIC_URL:ORIGIN,LOGIN_IP_PER_MINUTE:'2'});
 assert.equal((await login(direct,as('10.0.0.1'))).status,200);
 assert.equal((await login(direct,as('10.0.0.2'))).status,200);
 assert.equal((await login(direct,as('10.0.0.3'))).status,429,'spoofed forwarding headers are ignored without TRUST_PROXY');
});

test('login is throttled per account across IPs and reset by a success',async()=>{
 const srv=await start({...PUBLIC,LOGIN_ACCOUNT_FAILURES:'3',LOGIN_IP_PER_MINUTE:'100'});
 const as=i=>({'X-Forwarded-For':'10.1.0.'+i});
 for(let i=0;i<3;i++)assert.equal((await login(srv,as(i),{password:'wrong'})).status,401);
 assert.equal((await login(srv,as(9))).status,429,'even the right password waits');
 assert.equal((await login(srv,as(9),{email:'b@stud.tu-darmstadt.de'})).status,200,'other accounts unaffected');
 const other={email:'c@stud.tu-darmstadt.de'};
 await login(srv,as(1),{...other,password:'wrong'});await login(srv,as(2),{...other,password:'wrong'});
 assert.equal((await login(srv,as(3),other)).status,200);
 await login(srv,as(4),{...other,password:'wrong'});await login(srv,as(5),{...other,password:'wrong'});
 assert.equal((await login(srv,as(6),other)).status,200,'success cleared the earlier failures');
});

test('invalid input does not count against an account',async()=>{
 const srv=await start({...PUBLIC,LOGIN_ACCOUNT_FAILURES:'2',LOGIN_IP_PER_MINUTE:'100'});
 for(let i=0;i<5;i++)assert.equal((await login(srv,{},{username:'!'})).status,400);
 assert.equal((await login(srv)).status,200);
});

test('session capacity is bounded',async()=>{
 // Sessions are process-wide, so leave room for the ones earlier tests created.
 const srv=await start({...PUBLIC,MAX_SESSIONS:String(require('../server/services/mail-session').count()+1),LOGIN_IP_PER_MINUTE:'100'});
 assert.equal((await login(srv)).status,200);
 const full=await login(srv,{},{email:'z@stud.tu-darmstadt.de'});
 assert.equal(full.status,503);assert.match(full.json().error,/busy/i);
});

test('client pages carry no inline scripts, so the CSP can forbid them',()=>{
 const dir=path.join(__dirname,'../client');
 for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.html'))){
  const html=fs.readFileSync(path.join(dir,file),'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html),file+' has an inline <script>');
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html),file+' has an inline event handler');
 }
});
