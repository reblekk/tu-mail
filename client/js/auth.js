const ROOT='/';
// Dialogs close when the dimmed area around them is tapped (press and release both outside the box, so
// selecting text and letting go outside does not close it).
(function(){
 let pressedOutside=false;
 const onBackdrop=t=>t instanceof HTMLDialogElement&&t.open||(t.classList&&t.classList.contains('cmp-dialog-overlay'));
 document.addEventListener('pointerdown',e=>{pressedOutside=onBackdrop(e.target);},true);
 document.addEventListener('click',e=>{
  const t=e.target;if(!pressedOutside||!onBackdrop(t))return;pressedOutside=false;
  if(t instanceof HTMLDialogElement)t.close();else t.querySelector('[data-act="cancel"]')?.click();
 },true);
})();
// A tap outside an open pop-up closes it and does nothing else: the press is caught on the way down (pointer events
// cover touch screens, where mouse events never fire on plain elements) and the click it would cause is swallowed,
// so closing a menu never opens the email underneath.
window.TuOutside=(function(){
 let swallowUntil=0;
 document.addEventListener('click',e=>{if(Date.now()<swallowUntil){swallowUntil=0;e.preventDefault();e.stopPropagation();}},true);
 document.addEventListener('pointercancel',()=>{swallowUntil=0;},true);
 // Everything beside the open pop-up (and the pages inside message frames, which never pass a press to this
 // document) is made inert, so a press outside shows no hover or selected effect and cannot start anything.
 function freeze(keep){
  const path=new Set(),frozen=[];
  for(const el of keep)for(let n=el;n&&n!==document.documentElement;n=n.parentElement)path.add(n);
  for(const node of path)for(const child of node.parentElement?node.parentElement.children:[])if(!path.has(child)&&!child.inert){child.inert=true;frozen.push(child);}
  return()=>frozen.forEach(n=>{n.inert=false;});
 }
 return{watch(inside,close,keep){
  const parts=keep||(typeof inside==='function'?[]:[inside]);
  const contains=typeof inside==='function'?inside:(t=>inside.contains(t));
  const thaw=freeze(parts);
  const down=e=>{if(contains(e.target))return;swallowUntil=Date.now()+700;close();};
  const key=e=>{if(e.key==='Escape')close();};
  document.addEventListener('pointerdown',down,true);document.addEventListener('keydown',key,true);
  return()=>{thaw();document.removeEventListener('pointerdown',down,true);document.removeEventListener('keydown',key,true);};
 }};
})();
function getToken(){return '';}
function clearSession(){sessionStorage.removeItem('tu-mail-user');}
function requireAuth(){try{const user=JSON.parse(sessionStorage.getItem('tu-mail-user'));if(user)return user;}catch{}location.replace('/');return null;}
function accountHeaders(){try{return {'X-Mail-Account':JSON.parse(sessionStorage.getItem('tu-mail-user')).userId};}catch{return {};}}
// How a person is shown in menus: their full name, or the address when no name is known (the sign-in name,
// the TU-ID, is not a name).
function personLabel(person){return person&&person.name&&person.name!==person.username?person.name:(person&&person.email)||'';}
function canLeaveComposer(){if(window.composeIsOpen?.()){showToast('Close or save your message before switching accounts.');return false;}return true;}
async function renderProfileMenu(user){
 const target=document.getElementById('profile-menu');
 let stopWatching=null;
 const menu=document.createElement('details');menu.className='account-menu';
 const trigger=document.createElement('summary');trigger.innerHTML='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3.2"/><path d="M5.8 19.2c1.2-2.6 3.6-4 6.2-4s5 1.4 6.2 4"/></svg>';trigger.setAttribute('aria-label','Account menu');trigger.title='Account';
 const panel=document.createElement('div');panel.className='account-panel';
 const name=document.createElement('strong');name.textContent=personLabel(user);name.title=user.email;panel.append(name);
 const button=(label,action)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=action;panel.append(b);return b;};
 const mailPage=document.body.dataset.page==='mail';
 button(window.TuPrefs.langLabel(),()=>{if(canLeaveComposer())window.TuPrefs.toggleLang();});
 if(mailPage){
  const undoButton=button(window.UndoSend?window.UndoSend.label():'Undo send: 10 s',()=>{if(window.UndoSend)undoButton.textContent=window.UndoSend.cycle();});
  const notifyButton=button(window.MailNotify?window.MailNotify.label():'Notifications: off',async()=>{if(window.MailNotify)notifyButton.textContent=await window.MailNotify.cycle();});window.addEventListener('tu-notify-changed',()=>{if(window.MailNotify)notifyButton.textContent=window.MailNotify.label();});
  const picturesButton=button(window.TuPrefs.picturesLabel(),()=>{picturesButton.textContent=window.TuPrefs.togglePictures();});
  button('Contacts',()=>{menu.open=false;window.MailContacts?.open();});
 }
 if(window.showShortcuts)button('Keyboard shortcuts',()=>{menu.open=false;window.showShortcuts();});
 if(mailPage)button('Print message',()=>{menu.open=false;if(typeof state!=='undefined'&&state.current)window.print();else showToast('Open a message first.');});
 const install=button('Install app',()=>{menu.open=false;window.TuPwa?.install();});install.hidden=!window.TuPwa?.canInstall();
 window.addEventListener('tu-install-ready',()=>{install.hidden=false;});
 button('Add another account',()=>{if(canLeaveComposer())location.href='/index.html?add=1';});
 button('Sign out of all accounts',async()=>{if(!canLeaveComposer())return;try{await fetch('/api/auth/logout',{method:'POST',headers:accountHeaders()});clearSession();location.replace('/');}catch{showToast('Could not sign out. Try again.','error');}});
 menu.append(trigger,panel);target.replaceChildren(menu);
 try {const response=await fetch('/api/auth/accounts',{headers:accountHeaders()});if(!response.ok)return;const data=await response.json();for(const account of data.accounts||[]){if(account.userId===user.userId)continue;const entry=button(personLabel(account),()=>{if(!canLeaveComposer())return;sessionStorage.setItem('tu-mail-user',JSON.stringify(account));location.href='/mail.html';});entry.title=account.email;}}catch{}
 menu.addEventListener('toggle',()=>{if(menu.open)stopWatching=window.TuOutside.watch(menu,()=>{menu.open=false;});else if(stopWatching){stopWatching();stopWatching=null;}});
}
function showToast(message,type){const el=document.createElement('div');el.className='tu-toast';el.setAttribute('role',type==='error'?'alert':'status');el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),5000);}
function resetMailBadge(){}
