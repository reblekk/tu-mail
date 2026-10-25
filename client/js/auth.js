const ROOT='/';
function getToken(){return '';}
function clearSession(){sessionStorage.removeItem('tu-mail-user');}
function requireAuth(){try{const user=JSON.parse(sessionStorage.getItem('tu-mail-user'));if(user)return user;}catch{}location.replace('/');return null;}
function accountHeaders(){try{return {'X-Mail-Account':JSON.parse(sessionStorage.getItem('tu-mail-user')).userId};}catch{return {};}}
function canLeaveComposer(){if(window.composeIsOpen?.()){showToast('Close or save your message before switching accounts.');return false;}return true;}
async function renderProfileMenu(user){
 const target=document.getElementById('profile-menu');
 const menu=document.createElement('details');menu.className='account-menu';
 const trigger=document.createElement('summary');trigger.textContent='Account';trigger.setAttribute('aria-label','Account menu');
 const panel=document.createElement('div');panel.className='account-panel';
 const name=document.createElement('strong');name.textContent=user.email;panel.append(name);
 const button=(label,action)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=action;panel.append(b);return b;};
 button(window.TuPrefs.langLabel(),()=>{if(canLeaveComposer())window.TuPrefs.toggleLang();});
 const undoButton=button(window.UndoSend?window.UndoSend.label():'Undo send: 10 s',()=>{if(window.UndoSend)undoButton.textContent=window.UndoSend.cycle();});
 const remindButton=button(window.MailReminders?window.MailReminders.label():'Reminders',()=>{menu.open=false;window.MailReminders?.showList();});window.MailReminders?.bindLabel(remindButton);
 button('Send-as addresses',()=>{menu.open=false;window.MailIdentities?.edit();});
 button('Keyboard shortcuts',()=>{menu.open=false;window.showShortcuts();});
 button('Print message',()=>{menu.open=false;if(typeof state!=='undefined'&&state.current)window.print();else showToast('Open a message first.');});
 const install=button('Install app',()=>{menu.open=false;window.TuPwa?.install();});install.hidden=!window.TuPwa?.canInstall();
 window.addEventListener('tu-install-ready',()=>{install.hidden=false;});
 button('Add another account',()=>{if(canLeaveComposer())location.href='/index.html?add=1';});
 button('Sign out of all accounts',async()=>{if(!canLeaveComposer())return;try{await fetch('/api/auth/logout',{method:'POST',headers:accountHeaders()});clearSession();location.replace('/');}catch{showToast('Could not sign out. Try again.','error');}});
 menu.append(trigger,panel);target.replaceChildren(menu);
 try {const response=await fetch('/api/auth/accounts',{headers:accountHeaders()});if(!response.ok)return;const data=await response.json();for(const account of data.accounts||[]){if(account.userId===user.userId)continue;button(account.email+' · '+account.profile,()=>{if(!canLeaveComposer())return;sessionStorage.setItem('tu-mail-user',JSON.stringify(account));location.href='/mail.html';});}}catch{}
 document.addEventListener('click',event=>{if(!menu.contains(event.target))menu.open=false;});
}
function showToast(message,type){const el=document.createElement('div');el.className='tu-toast';el.setAttribute('role',type==='error'?'alert':'status');el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),5000);}
function resetMailBadge(){}
