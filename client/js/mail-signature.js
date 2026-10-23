// The signature editor: a small dialog with the same sandboxed rich-text editor used for writing.
// Loaded by mail.html after mail-compose.js (which exports the editor helpers it reuses).
(function () {
  const MAX_PICTURE_WIDTH = 400;
  const MAX_PICTURE_CHARS = 250000;

  const TOOLS = [
    ['bold', '<b>B</b>', 'Bold'],
    ['italic', '<i>I</i>', 'Italic'],
    ['underline', '<u>U</u>', 'Underline'],
    ['link', '&#128279;', 'Insert link'],
    ['picture', '&#128444;', 'Insert picture (a small logo)'],
    ['removeFormat', 'T<sub>x</sub>', 'Clear formatting'],
  ];

  async function openSignatureDialog() {
    const kit = window.MailEditorKit;
    if (!kit) { toast('The editor is still loading — try again in a moment', 'error'); return; }
    const settings = await getMailSettings();

    const wrap = document.createElement('div');
    wrap.className = 'cmp-dialog-overlay';
    wrap.innerHTML = `
      <div class="cmp-dialog sig-dialog" role="dialog" aria-modal="true" aria-label="Email signature">
        <h4>Email signature</h4>
        <p>Added to the messages you write, below your cursor. Keep it short — a name, title and phone number is plenty.</p>
        <div class="cmp-toolbar sig-toolbar" id="sig-toolbar">
          ${TOOLS.map(([cmd, label, title]) => `<button type="button" class="cmp-tool" data-cmd="${cmd}" title="${title}" aria-label="${title}">${label}</button>`).join('')}
        </div>
        <div class="sig-editor-wrap"><iframe id="sig-editor" title="Signature" sandbox="allow-same-origin"></iframe></div>
        <label class="sig-check"><input type="checkbox" id="sig-new" ${settings.useOnNew ? 'checked' : ''} /> Add to new messages</label>
        <label class="sig-check"><input type="checkbox" id="sig-reply" ${settings.useOnReply ? 'checked' : ''} /> Add to replies and forwards</label>
        <input type="file" id="sig-picture" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
        <div class="cmp-dialog-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-act="cancel">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" data-act="save">Save signature</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const frame = wrap.querySelector('#sig-editor');
    let doc = null;
    frame.onload = () => {
      doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      doc.designMode = 'on';
      try { doc.execCommand('styleWithCSS', false, false); } catch (err) { /* older engines */ }
      doc.addEventListener('paste', (e) => {
        const pictures = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/'));
        if (pictures.length) { e.preventDefault(); pictures.forEach(insertPicture); return; }
        const html = e.clipboardData && e.clipboardData.getData('text/html');
        if (html) { e.preventDefault(); doc.execCommand('insertHTML', false, kit.cleanPastedHtml(html)); }
      });
      doc.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); });
    };
    frame.srcdoc = kit.editorDocument(settings.signatureHtml || '<div><br></div>');

    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); };
    document.addEventListener('keydown', onKey, true);

    const run = (cmd, value) => { if (!doc) return; frame.contentWindow.focus(); doc.execCommand(cmd, false, value); };
    const toolbar = wrap.querySelector('#sig-toolbar');
    toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('.cmp-tool')) e.preventDefault(); });
    toolbar.addEventListener('click', async (e) => {
      const btn = e.target.closest('.cmp-tool');
      if (!btn || !doc) return;
      const cmd = btn.dataset.cmd;
      if (cmd === 'picture') { wrap.querySelector('#sig-picture').click(); return; }
      if (cmd === 'link') {
        const selected = doc.getSelection().toString();
        const url = window.prompt(selected ? `Link “${selected.slice(0, 60)}” to:` : 'Web address or email:', 'https://');
        if (!url || url === 'https://') return;
        let href = url.trim();
        if (!/^(https?:|mailto:)/i.test(href)) href = /@/.test(href) && !/\//.test(href) ? `mailto:${href}` : `https://${href.replace(/^\/+/, '')}`;
        frame.contentWindow.focus();
        if (selected) doc.execCommand('createLink', false, href);
        else {
          const a = doc.createElement('a');
          a.href = href;
          a.textContent = url.trim();
          doc.execCommand('insertHTML', false, a.outerHTML + '&nbsp;');
        }
        return;
      }
      run(cmd);
    });
    // Pasted or chosen pictures are shrunk to signature size so the email stays light.
    function insertPicture(file) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_PICTURE_WIDTH / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let data = canvas.toDataURL('image/png');
        if (data.length > MAX_PICTURE_CHARS) data = canvas.toDataURL('image/jpeg', 0.85);
        if (data.length > MAX_PICTURE_CHARS) { toast('That picture is too detailed for a signature — try a smaller logo', 'error'); return; }
        run('insertImage', data);
      };
      img.onerror = () => { URL.revokeObjectURL(url); toast("That picture couldn't be read", 'error'); };
      img.src = url;
    }
    wrap.querySelector('#sig-picture').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) insertPicture(file);
    });

    wrap.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'cancel') { close(); return; }
      if (act.dataset.act !== 'save' || !doc) return;
      act.disabled = true;
      const empty = !doc.body.textContent.trim() && !doc.body.querySelector('img');
      try {
        const saved = await mailFetch('/api/mail/settings', {
          method: 'PUT',
          body: JSON.stringify({
            signatureHtml: empty ? '' : doc.body.innerHTML,
            useOnNew: wrap.querySelector('#sig-new').checked,
            useOnReply: wrap.querySelector('#sig-reply').checked,
          }),
        });
        window.mailSettingsChanged(saved);
        toast(saved.signatureHtml ? 'Signature saved' : 'Signature removed', 'success');
        close();
      } catch (err) {
        act.disabled = false;
        toast(err.message || "The signature couldn't be saved", 'error');
      }
    });
  }

  const btn = document.getElementById('mail-settings-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (typeof closeDrawer === 'function') closeDrawer();
      openSignatureDialog();
    });
  }
})();
