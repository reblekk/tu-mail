const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const dir=path.join(process.env.TU_MAIL_DATA_DIR||path.join(__dirname,'../../data'),'settings');
const MAX_SIGNATURE_CHARS=700000;
const file=email=>path.join(dir,crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')+'.json');
async function getSettings(email) { try{return JSON.parse(await fs.readFile(file(email),'utf8'));}catch(e){if(e.code!=='ENOENT') throw e;return {signatureHtml:'',useOnNew:true,useOnReply:true};} }
async function saveSettings(email,value) { if(value.signatureHtml.length>MAX_SIGNATURE_CHARS) {const e=new Error('Signature is too large');e.status=413;throw e;} await fs.mkdir(dir,{recursive:true}); const target=file(email),tmp=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp'; await fs.writeFile(tmp,JSON.stringify(value)); await fs.rename(tmp,target); return value; }
module.exports={getSettings,saveSettings,MAX_SIGNATURE_CHARS};
