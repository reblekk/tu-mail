const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const dir=path.join(process.env.TU_MAIL_DATA_DIR||path.join(__dirname,'../../data'),'settings');
const MAX_SIGNATURE_CHARS=700000;
const file=email=>path.join(dir,crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')+'.json');
const defaults=()=>({signatureHtml:'',useOnNew:true,useOnReply:true,identities:[],displayName:''});
async function getSettings(email) { try{return {...defaults(),...JSON.parse(await fs.readFile(file(email),'utf8'))};}catch(e){if(e.code!=='ENOENT') throw e;return defaults();} }
async function write(email,value) { await fs.mkdir(dir,{recursive:true}); const target=file(email),tmp=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp'; await fs.writeFile(tmp,JSON.stringify(value)); await fs.rename(tmp,target); return value; }
// Signature settings from the signature dialog; the display name and send-as identities are kept as they are.
async function saveSettings(email,value) { if(value.signatureHtml.length>MAX_SIGNATURE_CHARS) {const e=new Error('Signature is too large');e.status=413;throw e;} const old=await getSettings(email); return write(email,{...value,identities:old.identities||[],displayName:old.displayName||''}); }
// displayName: undefined keeps the saved one, '' returns to the automatic name.
async function saveIdentities(email,identities,displayName) { const old=await getSettings(email); return write(email,{...old,identities,displayName:displayName===undefined?(old.displayName||''):displayName}); }
module.exports={getSettings,saveSettings,saveIdentities,MAX_SIGNATURE_CHARS};
