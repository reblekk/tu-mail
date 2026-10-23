// Attachment preview: click a picture, PDF or text file on a message to look at it without leaving
// the app. Everything else keeps downloading. The server decides what may be shown (it checks the
// file's real contents, not its name), and a file it won't preview simply downloads.
(function () {
  let viewer = null;
  let group = [];
  let index = 0;
  let loadToken = 0;
  let pdfUrl = null;

  function releasePdf() {
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; }
  }

  function build() {
    viewer = document.createElement('div');
    viewer.className = 'att-viewer';
    viewer.hidden = true;
    viewer.innerHTML = `
      <div class="att-bar">
        <div class="att-title"><span class="att-name"></span><span class="att-meta"></span></div>
        <div class="att-actions">
          <button type="button" class="att-nav" data-av="prev" aria-label="Previous attachment">&#8249;</button>
          <button type="button" class="att-nav" data-av="next" aria-label="Next attachment">&#8250;</button>
          <a class="btn btn-secondary btn-sm att-dl" download>Download</a>
          <button type="button" class="att-close" data-av="close" aria-label="Close preview">&#10005;</button>
        </div>
      </div>
      <div class="att-stage" data-av="stage"></div>`;
    document.body.appendChild(viewer);
    viewer.addEventListener('click', (e) => {
      const act = e.target.closest('[data-av]');
      if (!act) return;
      if (act.dataset.av === 'close' || (act.dataset.av === 'stage' && e.target === act)) close();
      else if (act.dataset.av === 'prev') step(-1);
      else if (act.dataset.av === 'next') step(1);
    });
  }

  const canEmbedPdf = () => navigator.pdfViewerEnabled !== false && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  async function show() {
    const item = group[index];
    const stage = viewer.querySelector('.att-stage');
    const mine = ++loadToken;
    releasePdf();
    viewer.querySelector('.att-name').textContent = item.name;
    viewer.querySelector('.att-meta').textContent = group.length > 1 ? `${item.size} · ${index + 1} of ${group.length}` : item.size;
    viewer.querySelector('.att-dl').href = item.dl;
    viewer.querySelectorAll('.att-nav').forEach((b) => { b.hidden = group.length < 2; });
    stage.innerHTML = '<div class="att-note"><div class="spinner"></div></div>';

    if (item.kind === 'image') {
      const img = new Image();
      img.alt = item.name;
      img.onload = () => { if (mine === loadToken) { stage.innerHTML = ''; stage.appendChild(img); } };
      img.onerror = () => { if (mine === loadToken) fallback(stage, "This picture can't be previewed."); };
      img.src = item.src;
    } else if (item.kind === 'pdf') {
      if (!canEmbedPdf()) {
        // Phones can't show a PDF inside a page; their own viewer in a new tab does it better.
        window.open(item.src, '_blank', 'noopener');
        fallback(stage, 'Opened in a new tab.');
        return;
      }
      try {
        // Fetched first so a file that isn't really a PDF is never put in the frame (it would download).
        const res = await fetch(item.src);
        if (!res.ok || !/^application\/pdf/i.test(res.headers.get('content-type') || '')) throw new Error('not a pdf');
        const blob = await res.blob();
        if (mine !== loadToken) return;
        pdfUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        const frame = document.createElement('iframe');
        frame.title = item.name;
        frame.className = 'att-pdf';
        frame.src = pdfUrl;
        stage.innerHTML = '';
        stage.appendChild(frame);
      } catch (err) {
        if (mine === loadToken) fallback(stage, "This PDF can't be previewed.");
      }
    } else {
      try {
        const res = await fetch(item.src);
        if (!res.ok || !/^text\/plain/i.test(res.headers.get('content-type') || '')) throw new Error('not previewable');
        const text = await res.text();
        if (mine !== loadToken) return;
        const pre = document.createElement('pre');
        pre.className = 'att-text';
        pre.textContent = text; // text only, never HTML
        stage.innerHTML = '';
        stage.appendChild(pre);
      } catch (err) {
        if (mine === loadToken) fallback(stage, "This file can't be previewed.");
      }
    }
  }

  function fallback(stage, message) {
    stage.innerHTML = `<div class="att-note"><p>${message}</p><p>Use <b>Download</b> to open it on your device.</p></div>`;
  }

  function step(delta) {
    index = (index + delta + group.length) % group.length;
    show();
  }

  function close() {
    loadToken += 1;
    releasePdf();
    viewer.hidden = true;
    viewer.querySelector('.att-stage').innerHTML = '';
    document.documentElement.classList.remove('att-open');
  }

  function open(chip) {
    if (!viewer) build();
    group = [...chip.closest('.msg-attachments').querySelectorAll('.msg-attachment[data-kind]')].map((el) => ({
      kind: el.dataset.kind, name: el.dataset.name, size: el.dataset.size, src: el.dataset.src, dl: el.dataset.dl, el,
    }));
    index = Math.max(0, group.findIndex((g) => g.el === chip));
    viewer.hidden = false;
    document.documentElement.classList.add('att-open');
    show();
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.msg-attachment[data-kind]');
    if (!chip || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    open(chip);
  });

  document.addEventListener('keydown', (e) => {
    if (!viewer || viewer.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft' && group.length > 1) step(-1);
    else if (e.key === 'ArrowRight' && group.length > 1) step(1);
  }, true);
})();
