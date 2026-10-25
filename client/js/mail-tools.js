// Contacts and invitation previews use textContent for all untrusted values.
(() => {
  window.savedMailContacts=[];
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  function dialog(title){const d=node('dialog');d.className='mail-utility-dialog';const heading=node('h2',title),close=node('button','Close');close.type='button';close.onclick=()=>d.close();d.append(heading);document.body.append(d);d.addEventListener('close',()=>d.remove());return {d,close};}
  async function loadContacts(){try{window.savedMailContacts=await mailFetch('/api/mail/contacts');}catch{window.savedMailContacts=[];}}
  loadContacts();
  async function contacts(){
    const {d,close}=dialog('Contacts');const form=node('form'),name=node('input'),address=node('input'),save=node('button','Save contact'),list=node('div'),error=node('p');
    name.placeholder='Name';name.setAttribute('aria-label','Contact name');address.type='email';address.required=true;address.placeholder='Email address';address.setAttribute('aria-label','Contact email');save.type='submit';error.setAttribute('role','alert');
    const search=node('input');search.type='search';search.placeholder='Search contacts';search.setAttribute('aria-label','Search contacts');
    const render=()=>{list.replaceChildren();for(const contact of savedMailContacts.filter(c=>(c.name+' '+c.address).toLowerCase().includes(search.value.toLowerCase()))){const row=node('div');row.className='contact-row';row.append(node('span',(contact.name?contact.name+' — ':'')+contact.address));const write=node('button','Write'),edit=node('button','Edit'),remove=node('button','Remove');write.onclick=()=>{d.close();openCompose({to:[contact]});};edit.onclick=()=>{name.value=contact.name;address.value=contact.address;address.focus();};remove.onclick=async()=>{try{await mailFetch('/api/mail/contacts/'+encodeURIComponent(contact.id),{method:'DELETE'});await loadContacts();render();}catch(e){error.textContent=e.message;}};row.append(write,edit,remove);list.append(row);}if(!list.children.length)list.append(node('p','No contacts to show.'));};
    form.append(name,address,save);form.onsubmit=async event=>{event.preventDefault();save.disabled=true;error.textContent='';try{await mailFetch('/api/mail/contacts',{method:'POST',body:JSON.stringify({name:name.value,address:address.value})});form.reset();await loadContacts();render();}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
    search.oninput=render;d.append(form,search,error,list,close);await loadContacts();render();d.showModal();
  }
  async function recover(){
    const {d,close}=dialog('Recovered drafts');d.append(node('p','These copies are stored on this browser, including locally added attachments. They remain until sent or removed here.'));
    try{const drafts=await MailRecovery.list(user.userId);if(!drafts.length)d.append(node('p','No recovered drafts.'));for(const record of drafts){const row=node('div');row.className='contact-row';row.append(node('span',(record.subject||'(No subject)')+' · '+new Date(record.updated).toLocaleString()));const open=node('button','Restore'),remove=node('button','Remove local copy');open.onclick=()=>{d.close();window.restoreRecoveredDraft(record);};remove.onclick=async()=>{await MailRecovery.remove(record.id);row.remove();};row.append(open,remove);d.append(row);}}catch(e){d.append(node('p','Local draft storage is unavailable in this browser.'));}d.append(close);d.showModal();
  }
  const controls=node('div');controls.className='mail-extra-tools';
  for(const [title,action] of [['Contacts',contacts],['Recovered drafts',recover]]){const button=node('button',title);button.type='button';button.onclick=action;controls.append(button);}
  document.getElementById('mail-folders').append(controls);
  document.addEventListener('click',async event=>{
    const link=event.target.closest('[data-invitation]');if(!link)return;event.preventDefault();
    const {d,close}=dialog('Meeting invitation');const status=node('p','Loading invitation…');d.append(status,close);d.showModal();
    const base='/api/mail/messages/'+link.dataset.uid+'/invitation/'+link.dataset.index;
    try{const invite=await mailFetch(base+'?folder='+encodeURIComponent(link.dataset.folder));status.textContent='';d.insertBefore(node('h3',invite.title),close);for(const [label,value] of [['Starts',invite.start?invite.start.value+' · '+invite.start.timezone:'Not specified'],['Ends',invite.end?invite.end.value+' · '+invite.end.timezone:'Not specified'],['Location',invite.location],['Organizer',invite.organizer],['Details',invite.description],['Recurrence',invite.recurring?'This is a recurring meeting. Your response applies to the invitation as supplied.':'']]){if(value)d.insertBefore(node('p',label+': '+value),close);}if(invite.method==='CANCEL')d.insertBefore(node('p','This meeting has been cancelled.'),close);
      const download=node('a','Download for your calendar');download.href=link.href;download.download='invitation.ics';d.insertBefore(download,close);
      const addCal=node('button',invite.method==='CANCEL'?'Remove from calendar':'Add to calendar');addCal.type='button';addCal.onclick=async()=>{addCal.disabled=true;try{const r=await mailFetch(base+'/calendar',{method:'POST',body:JSON.stringify({folder:link.dataset.folder})});status.textContent=r.removed?'Removed from your calendar.':r.updated?'Updated in your calendar.':'Added to your calendar.';if(!d.querySelector('.open-calendar')){const open=node('a','Open calendar');open.href='/calendar.html';open.className='open-calendar';d.insertBefore(open,close);}}catch(e){status.textContent=e.message;addCal.disabled=false;}};d.insertBefore(addCal,close);
      if(invite.canRespond){d.insertBefore(node('p','Choose a response to prepare an email. Review it and press Send to notify the organizer.'),close);for(const [label,response] of [['Accept','ACCEPTED'],['Tentative','TENTATIVE'],['Decline','DECLINED']]){const button=node('button',label);button.onclick=async()=>{button.disabled=true;try{const reply=await mailFetch(base+'/reply',{method:'POST',body:JSON.stringify({folder:link.dataset.folder,response})});d.close();await openCompose({to:[{address:reply.to}],subject:reply.subject,bodyHtml:'<p>'+esc(reply.text)+'</p>',files:[new File([reply.content],reply.filename,{type:'text/calendar; method=REPLY'})]});}catch(e){status.textContent=e.message;button.disabled=false;}};d.insertBefore(button,close);}}
      else if(invite.method!=='CANCEL')d.insertBefore(node('p','A response is unavailable: this account is not an invited attendee, or this is not a meeting request.'),close);
    }catch(e){status.textContent=e.message;}
  });
})();
