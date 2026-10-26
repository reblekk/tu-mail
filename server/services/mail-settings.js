const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const dir=path.join(process.env.TU_MAIL_DATA_DIR||path.join(__dirname,'../../data'),'settings');
const MAX_SIGNATURE_CHARS=700000;
const file=email=>path.join(dir,crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')+'.json');
const defaults=()=>({signatureHtml:'',useOnNew:true,useOnReply:true,displayName:''});
async function getSettings(email) { try{return {...defaults(),...JSON.parse(await fs.readFile(file(email),'utf8'))};}catch(e){if(e.code!=='ENOENT') throw e;return defaults();} }
async function write(email,value) { await fs.mkdir(dir,{recursive:true}); const target=file(email),tmp=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp'; await fs.writeFile(tmp,JSON.stringify(value)); await fs.rename(tmp,target); return value; }
// Signature settings from the signature dialog; the display name is kept as it is.
async function saveSettings(email,value) { if(value.signatureHtml.length>MAX_SIGNATURE_CHARS) {const e=new Error('Signature is too large');e.status=413;throw e;} const old=await getSettings(email); return write(email,{...value,displayName:old.displayName||''}); }
// The full name typed at sign-in; it is the name recipients see.
async function saveDisplayName(email,displayName) { const old=await getSettings(email); return write(email,{...old,displayName}); }
module.exports={getSettings,saveSettings,saveDisplayName,MAX_SIGNATURE_CHARS};
