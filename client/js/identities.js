// Send-as addresses: a From picker in the compose window and a small editor in the account menu. The
// server only accepts saved addresses on the allowed domain, so this is convenience, not a security gate.
(function () {
  let cache = null;
  function load(force) {
    if (!cache || force) {
      cache = mailFetch('/api/mail/identities').catch(() => ({ own: { name: user.name || '', address: user.email }, identities: [] }));
    }
    return cache;
  }

  async function decorate(holder) {
    const row = holder.parentElement;
    const old = row.querySelector('#cmp-from-select');
    if (old) old.remove();
    holder.hidden = false;
    const data = await load();
    if (data.own && data.own.address) holder.textContent = data.own.name ? data.own.name + ' <' + data.own.address + '>' : data.own.address;
    if (!data.identities.length) return;
    const select = document.createElement('select');
    select.id = 'cmp-from-select';
    select.setAttribute('aria-label', 'From');
    for (const who of [data.own, ...data.identities]) {
      const option = document.createElement('option');
      option.value = who.address;
      option.textContent = who.name ? who.name + ' <' + who.address + '>' : who.address;
      option.setAttribute('data-i18n-skip', '');
      select.append(option);
    }
    holder.hidden = true;
    row.insertBefore(select, holder.nextSibling);
  }

  function chosen() {
    const select = document.getElementById('cmp-from-select');
    return select && !select.closest('[hidden]') ? select.value : '';
  }

  async function edit() {
    const data = await load(true);
    const d = document.createElement('dialog');
    d.className = 'mail-utility-dialog';
    d.addEventListener('close', () => d.remove());
    const title = document.createElement('h2');
    title.textContent = 'Name and send-as addresses';
    const help = document.createElement('p');
    help.textContent = 'Other addresses you may write from. Replies go to the address you pick; your mailbox still sends the message.';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Your name';
    nameLabel.setAttribute('for', 'idn-name');
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.id = 'idn-name'; nameInput.maxLength = 80; nameInput.value = data.displayName || '';
    nameInput.placeholder = data.suggested || 'Your name';
    const nameHelp = document.createElement('p');
    nameHelp.className = 'idn-hint';
    nameHelp.textContent = 'Shown to recipients next to your address. Leave it empty to use the name from your address, if it has one.';
    const list = document.createElement('div');
    const error = document.createElement('p');
    error.setAttribute('role', 'alert');
    error.className = 'form-error';
    const rows = [];
    const addRow = (who) => {
      const row = document.createElement('div');
      row.className = 'idn-row';
      const name = document.createElement('input');
      name.type = 'text'; name.maxLength = 80; name.value = who.name || ''; name.placeholder = 'Name'; name.setAttribute('aria-label', 'Name');
      const address = document.createElement('input');
      address.type = 'email'; address.value = who.address || ''; address.placeholder = 'Email address'; address.setAttribute('aria-label', 'Email address');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove'); remove.title = 'Remove';
      remove.addEventListener('click', () => { rows.splice(rows.indexOf(entry), 1); row.remove(); });
      const entry = { name, address };
      rows.push(entry);
      row.append(name, address, remove);
      list.append(row);
    };
    data.identities.forEach(addRow);
    const add = document.createElement('button');
    add.type = 'button'; add.textContent = 'Add address';
    add.addEventListener('click', () => { if (rows.length < 5) addRow({}); else toast('You can save up to 5 send-as addresses.'); });
    const save = document.createElement('button');
    save.type = 'button'; save.textContent = 'Save';
    save.addEventListener('click', async () => {
      error.textContent = '';
      const identities = rows.map((r) => ({ name: r.name.value.trim(), address: r.address.value.trim() })).filter((i) => i.address);
      try {
        cache = Promise.resolve(await mailFetch('/api/mail/identities', { method: 'PUT', body: JSON.stringify({ identities, displayName: nameInput.value.trim() }) }));
        toast('Send-as addresses saved');
        d.close();
      } catch (err) { error.textContent = err.message; }
    });
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', () => d.close());
    d.append(title, nameLabel, nameInput, nameHelp, help, list, error, add, save, close);
    document.body.append(d);
    d.showModal();
  }

  window.MailIdentities = { decorate, chosen, edit, load };
})();
