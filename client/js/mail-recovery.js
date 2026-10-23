// Browser-local recovery is separate from mailbox drafts and never sends mail.
window.MailRecovery = (() => {
  let database;
  function db() { return database ||= new Promise((resolve,reject) => {
    const request=indexedDB.open('tu-mail-draft-recovery',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  }); }
  async function transaction(mode,work) { const database=await db(); return new Promise((resolve,reject)=>{
    const tx=database.transaction('drafts',mode),request=work(tx.objectStore('drafts'));
    tx.oncomplete=()=>resolve(request?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  }); }
  return {
    save: record=>transaction('readwrite',store=>store.put(record)),
    remove: id=>transaction('readwrite',store=>store.delete(id)),
    list: async account=>(await transaction('readonly',store=>store.getAll())).filter(r=>r.account===account).sort((a,b)=>b.updated-a.updated)
  };
})();
