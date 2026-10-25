// Sign-in form. The full name is saved by the server as the sender name; this browser remembers it per
// address so returning to the page does not mean typing it again.
(function () {
  const KEY = 'tu-mail-fullnames';
  const form = document.getElementById('login');
  const emailInput = document.getElementById('email');
  const nameInput = document.getElementById('fullname');

  const names = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
  const remember = (email, name) => {
    try {
      const all = names();
      all[email.toLowerCase()] = name;
      const keys = Object.keys(all);
      if (keys.length > 20) delete all[keys[0]];
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) { /* private mode: the name is simply asked for again */ }
  };
  // Fill in a remembered name once the address is known, but never overwrite what was typed.
  const prefill = () => {
    const known = names()[emailInput.value.trim().toLowerCase()];
    if (known && !nameInput.value.trim()) nameInput.value = known;
  };
  emailInput.addEventListener('change', prefill);
  emailInput.addEventListener('blur', prefill);

  // The server keeps the sign-in for hours, but sessionStorage is gone once the tab or browser closes.
  // If the cookie is still good, pick the sign-in up again instead of asking for the password.
  const resume = async () => {
    if (new URLSearchParams(location.search).has('add')) return;
    try {
      const response = await fetch('/api/auth/accounts');
      if (!response.ok) return;
      const { accounts } = await response.json();
      if (!accounts || !accounts.length) return;
      sessionStorage.setItem('tu-mail-user', JSON.stringify(accounts[accounts.length - 1]));
      location.replace('/mail.html');
    } catch (e) { /* offline or blocked: show the form */ }
  };
  resume();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = document.getElementById('submit'), error = document.getElementById('error');
    button.disabled = true;
    error.textContent = '';
    try {
      const body = Object.fromEntries(new FormData(form));
      body.email = body.email.trim();
      body.username = body.username.trim();
      body.fullName = (body.fullName || '').trim();
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      document.getElementById('password').value = '';
      if (body.fullName) remember(body.email, body.fullName);
      sessionStorage.setItem('tu-mail-user', JSON.stringify(data.user));
      sessionStorage.setItem('tu-mail-notify-prompt', '1'); // the mail page offers notifications once per sign-in
      location.href = '/mail.html';
    } catch (err) {
      error.textContent = err.message || 'Unable to sign in.';
    } finally {
      button.disabled = false;
    }
  });
})();
