// Builder UI (items 21, 23, 24, 25, 26, 28, 29, 33, 35, 52-57). Plain JS, no build step.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const root = $('#bld');
  const ID = root.dataset.site;
  const API = `/sites/${ID}`;
  const S = { doc: JSON.parse($('#doc-json').textContent), pageId: null, undo: [], redo: [], busy: false, meta: JSON.parse($('#meta-json').textContent) };
  S.pageId = S.doc.pages[0].id;
  const frame = $('#pv');
  const log = $('#log');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const page = () => S.doc.pages.find((p) => p.id === S.pageId) || S.doc.pages[0];
  const pageIndex = () => S.doc.pages.indexOf(page());

  async function api(path, body, method = 'POST') {
    const r = await fetch(API + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ error: 'Something went wrong.' }));
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    return j;
  }
  function say(who, text) {
    const p = document.createElement('div');
    p.className = 'msg ' + who;
    p.textContent = text;
    log.append(p);
    log.scrollTop = 1e9;
  }
  function status(t) { $('#status').textContent = t; }

  // ---------- preview ----------
  function reload() {
    let y = 0;
    try { y = frame.contentWindow.scrollY; } catch {}
    frame.onload = () => { try { frame.contentWindow.scrollTo(0, y); } catch {} };
    const lang = $('#lang').value;
    frame.src = `${API}/preview?page=${encodeURIComponent(page().slug)}&edit=${lang === 'es' ? 0 : 1}&lang=${lang}&t=${Date.now()}`;
    $('#pagesel').innerHTML = S.doc.pages.map((p) => `<option value="${esc(p.id)}"${p.id === S.pageId ? ' selected' : ''}>${esc(p.title)}</option>`).join('');
    $('#undo').disabled = !S.undo.length;
    $('#redo').disabled = !S.redo.length;
    $('#lang').hidden = !S.doc.translations?.es;
  }

  // ---------- save / undo / redo (item 24) ----------
  async function save(note) {
    status('Saving…');
    const r = await api('/doc', { doc: S.doc, note });
    S.doc = r.doc;
    status('Saved');
    reload();
  }
  async function commit(mutate, note) {
    const before = JSON.stringify(S.doc);
    mutate(S.doc);
    if (JSON.stringify(S.doc) === before) return;
    S.undo.push(before);
    if (S.undo.length > 100) S.undo.shift();
    S.redo = [];
    try { await save(note); } catch (e) { S.doc = JSON.parse(S.undo.pop()); status(e.message); reload(); }
  }
  async function setDoc(doc, note) { S.undo.push(JSON.stringify(S.doc)); S.redo = []; S.doc = doc; await save(note); }
  $('#undo').onclick = async () => { if (!S.undo.length) return; S.redo.push(JSON.stringify(S.doc)); S.doc = JSON.parse(S.undo.pop()); await save('Undo'); };
  $('#redo').onclick = async () => { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.doc)); S.doc = JSON.parse(S.redo.pop()); await save('Redo'); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.isContentEditable && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); (e.shiftKey ? $('#redo') : $('#undo')).click(); }
  });

  function getAt(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
  function setAt(obj, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    const o = ks.reduce((a, k) => a[k], obj);
    o[last] = v;
  }

  // ---------- tap to edit (item 23) ----------
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || !e.data.ios) return;
    if (e.data.type === 'edit') {
      if (getAt(S.doc, e.data.path) === e.data.value) return;
      commit((d) => setAt(d, e.data.path, e.data.value), 'Edited text');
    } else if (e.data.type === 'img') openImage(e.data.path);
  });

  // ---------- chat (item 21) ----------
  $('#chat').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('#msg').value.trim();
    if (!t || S.busy) return;
    $('#msg').value = '';
    say('me', t);
    S.busy = true; status('Working…');
    try {
      const r = await api('/chat', { message: t, pageId: S.pageId });
      say('bot', r.reply);
      if (r.doc) { S.undo.push(JSON.stringify(S.doc)); S.redo = []; S.doc = r.doc; reload(); }
      status('Saved');
    } catch (err) { say('bot', err.message); status(''); }
    S.busy = false;
  };
  document.querySelectorAll('[data-say]').forEach((b) => (b.onclick = () => { $('#msg').value = b.dataset.say; $('#chat').requestSubmit(); }));

  $('#pagesel').onchange = (e) => { S.pageId = e.target.value; reload(); };
  $('#lang').onchange = reload;
  document.querySelectorAll('[data-dev]').forEach((b) => (b.onclick = () => { $('#frame-wrap').dataset.dev = b.dataset.dev; document.querySelectorAll('[data-dev]').forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { root.dataset.tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b)); }));

  // ---------- panels ----------
  const dlg = $('#panel');
  function panel(title, html, wire) {
    $('#panel-title').textContent = title;
    $('#panel-body').innerHTML = html;
    if (!dlg.open) dlg.showModal();
    wire && wire($('#panel-body'));
  }
  $('#panel-close').onclick = () => dlg.close();

  // Item 26: add, move, remove sections
  function sectionsPanel() {
    const p = page();
    panel(`Sections on ${p.title}`, `<ol class="slist">${p.sections.map((s, i) => `<li><span>${esc(S.meta.types[s.type])}${s.data.heading ? ` – <i>${esc(s.data.heading)}</i>` : ''}</span>
<span class="row"><button class="sm sec" data-mv="${i}:-1" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button class="sm sec" data-mv="${i}:1" aria-label="Move down"${i < p.sections.length - 1 ? '' : ' disabled'}>↓</button><button class="sm danger" data-rm="${i}" aria-label="Remove">✕</button></span></li>`).join('')}</ol>
<label for="addtype">Add a section</label><div class="row"><select id="addtype">${Object.entries(S.meta.types).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select><button id="addsec">Add</button></div>
<p class="mut small">Removing a section can be undone.</p>`, (b) => {
      b.querySelectorAll('[data-mv]').forEach((x) => (x.onclick = async () => { const [i, d] = x.dataset.mv.split(':').map(Number); await commit((doc) => { const ss = doc.pages[pageIndex()].sections; const [s] = ss.splice(i, 1); ss.splice(i + d, 0, s); }, 'Moved section'); sectionsPanel(); }));
      b.querySelectorAll('[data-rm]').forEach((x) => (x.onclick = async () => { await commit((doc) => doc.pages[pageIndex()].sections.splice(+x.dataset.rm, 1), 'Removed section'); sectionsPanel(); }));
      $('#addsec', b).onclick = async () => { const r = await api('/new-section', { type: $('#addtype', b).value }); await commit((doc) => doc.pages[pageIndex()].sections.push(r.section), 'Added section'); sectionsPanel(); };
    });
  }
  function pagesPanel() {
    panel('Pages', `<ol class="slist">${S.doc.pages.map((p, i) => `<li><span><input aria-label="Page name" data-ti="${i}" value="${esc(p.title)}" maxlength="60"></span><span class="row"><label class="check small"><input type="checkbox" data-nav="${i}"${p.nav ? ' checked' : ''}> menu</label>${i ? `<button class="sm danger" data-rp="${i}" aria-label="Remove page">✕</button>` : ''}</span></li>`).join('')}</ol>
<div class="row"><input id="np" placeholder="New page name" maxlength="60"><button id="addp">Add page</button></div>`, (b) => {
      b.querySelectorAll('[data-ti]').forEach((x) => (x.onchange = () => commit((d) => (d.pages[+x.dataset.ti].title = x.value), 'Renamed page')));
      b.querySelectorAll('[data-nav]').forEach((x) => (x.onchange = () => commit((d) => (d.pages[+x.dataset.nav].nav = x.checked), 'Menu changed')));
      b.querySelectorAll('[data-rp]').forEach((x) => (x.onclick = async () => { await commit((d) => d.pages.splice(+x.dataset.rp, 1), 'Removed page'); S.pageId = S.doc.pages[0].id; pagesPanel(); }));
      $('#addp', b).onclick = async () => { const t = $('#np', b).value.trim(); if (!t) return; const r = await api('/chat', { message: 'add page ' + t, pageId: S.pageId }); if (r.doc) await setDoc(r.doc, 'Added page'); pagesPanel(); };
    });
  }
  // Item 33 brand kit + 35 switch template + 36 mode
  function brandPanel() {
    const th = S.doc.theme;
    const t = S.meta.templates.find((x) => x.id === S.doc.template) || S.meta.templates[0];
    const c = th.colors || {};
    const L = c.light || { bg: t.light[0], fg: t.light[1], acc: t.light[2], card: t.light[3] };
    const D = c.dark || { bg: t.dark[0], fg: t.dark[1], acc: t.dark[2], card: t.dark[3] };
    const col = (m, k, v) => `<label class="small">${k}<input type="color" data-c="${m}.${k}" value="${v}"></label>`;
    const fsel = (id, v) => `<select id="${id}">${S.meta.fonts.map((f) => `<option${f === v ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>`;
    panel('Brand kit & template', `<h3>Logo</h3><p>${th.logo ? `<img src="${esc(th.logo.src)}" alt="" style="height:48px"> <button class="sm sec" id="rmlogo">Remove logo</button>` : ''} <button class="sm" id="uplogo">${th.logo ? 'Change' : 'Upload'} logo</button></p>
<h3>Colors</h3><p class="mut small">Applied to every page. Colors are adjusted automatically when needed so text stays readable.</p>
<div class="row">Light: ${['bg', 'fg', 'acc', 'card'].map((k) => col('light', k, L[k])).join('')}</div><div class="row">Dark: ${['bg', 'fg', 'acc', 'card'].map((k) => col('dark', k, D[k])).join('')}</div>
<p><button class="sm sec" id="resetc">Use template colors</button></p>
<h3>Fonts</h3><div class="row"><label class="small">Headings ${fsel('hf', th.headingFont)}</label><label class="small">Text ${fsel('bf', th.bodyFont)}</label></div>
<h3>Light / dark</h3><select id="mode">${['auto', 'light', 'dark'].map((m) => `<option${m === th.mode ? ' selected' : ''} value="${m}">${m === 'auto' ? 'Follow visitor\'s device' : m}</option>`).join('')}</select>
<h3>Template</h3><p class="mut small">Switching keeps all your words and photos.</p><select id="tpl">${S.meta.templates.map((x) => `<option value="${x.id}"${x.id === S.doc.template ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select> <a href="/templates" target="_blank">See samples</a>`, (b) => {
      b.querySelectorAll('[data-c]').forEach((x) => (x.onchange = () => commit((d) => { d.theme.colors = d.theme.colors || {}; d.theme.colors.light = d.theme.colors.light || { ...L }; d.theme.colors.dark = d.theme.colors.dark || { ...D }; const [m, k] = x.dataset.c.split('.'); d.theme.colors[m][k] = x.value; }, 'Brand colors')));
      $('#resetc', b).onclick = () => commit((d) => (d.theme.colors = null), 'Template colors').then(brandPanel);
      $('#hf', b).onchange = (e) => commit((d) => (d.theme.headingFont = e.target.value), 'Heading font');
      $('#bf', b).onchange = (e) => commit((d) => (d.theme.bodyFont = e.target.value), 'Text font');
      $('#mode', b).onchange = (e) => commit((d) => (d.theme.mode = e.target.value), 'Color mode');
      $('#tpl', b).onchange = (e) => commit((d) => { d.template = e.target.value; d.theme.colors = null; const nt = S.meta.templates.find((x) => x.id === e.target.value); d.theme.headingFont = nt.fonts[0]; d.theme.bodyFont = nt.fonts[1]; }, 'Switched template').then(brandPanel);
      $('#uplogo', b).onclick = () => openImage('theme.logo');
      const rl = $('#rmlogo', b); if (rl) rl.onclick = () => commit((d) => (d.theme.logo = null), 'Removed logo').then(brandPanel);
    });
  }
  async function versionsPanel() {
    const r = await api('/versions', null, 'GET');
    panel('Version history', `<p class="mut small">Every save is kept. Tap Restore to go back to any version.</p><ol class="slist">${r.versions.map((v) => `<li><span>${esc(new Date(v.at).toLocaleString())}<br><span class="mut small">${esc(v.note)}</span></span><button class="sm sec" data-v="${esc(v.id)}">Restore</button></li>`).join('')}</ol>`, (b) => {
      b.querySelectorAll('[data-v]').forEach((x) => (x.onclick = async () => { const res = await api(`/versions/${x.dataset.v}/restore`, {}); S.undo.push(JSON.stringify(S.doc)); S.doc = res.doc; reload(); dlg.close(); say('bot', 'Restored that version.'); }));
    });
  }
  function settingsPanel() {
    const p = page();
    const m = p.meta || {};
    const st = S.doc.settings;
    panel('Page & site settings', `<h3>Search & social for “${esc(p.title)}”</h3>
<label>Title<input id="mt" maxlength="70" value="${esc(m.title)}" placeholder="Filled automatically if blank"></label>
<label>Description<textarea id="md" maxlength="170" rows="2">${esc(m.description)}</textarea></label>
<label>Keywords<input id="mk" maxlength="200" value="${esc(m.keywords)}"></label>
<label>Search engines<select id="mr">${[['', 'Show in search (default)'], ['index,follow', 'Show in search'], ['noindex,follow', 'Hide this page'], ['noindex,nofollow', 'Hide page and links']].map(([v, l]) => `<option value="${v}"${v === (m.robots || '') ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
<button id="savemeta">Save page settings</button> <button class="sec" id="aimeta">AI: fill all pages</button>
<h3>Redirects (301)</h3><p class="mut small">One per line: /old-page -> /new-page</p><textarea id="rd" rows="3">${esc(st.redirects.map((r) => `${r.from} -> ${r.to}`).join('\n'))}</textarea>
<h3>“Page not found” page</h3><label>Heading<input id="nfh" value="${esc(st.notFound.heading)}" maxlength="120"></label><label>Text<textarea id="nft" rows="2" maxlength="600">${esc(st.notFound.text)}</textarea></label>
<button id="saveset">Save site settings</button>`, (b) => {
      $('#savemeta', b).onclick = () => commit((d) => (d.pages[pageIndex()].meta = { ...d.pages[pageIndex()].meta, title: $('#mt', b).value, description: $('#md', b).value, keywords: $('#mk', b).value, robots: $('#mr', b).value }), 'Page settings').then(() => say('bot', 'Page settings saved.'));
      $('#aimeta', b).onclick = () => aiCall('/ai/meta', {}, 'Meta tags').then(settingsPanel);
      $('#saveset', b).onclick = () => commit((d) => {
        d.settings.redirects = $('#rd', b).value.split('\n').map((l) => l.split('->').map((x) => x.trim())).filter((x) => x.length === 2 && x[0] && x[1]).map(([from, to]) => ({ from, to }));
        d.settings.notFound = { heading: $('#nfh', b).value, text: $('#nft', b).value };
      }, 'Site settings').then(() => say('bot', 'Site settings saved.'));
    });
  }
  // AI tools (items 52-57)
  async function aiCall(path, body, note) {
    status('AI working…');
    try {
      const r = await api(path, body);
      if (r.doc) await setDoc(r.doc, note);
      if (r.message) say('bot', r.message);
      status('');
      return r;
    } catch (e) { say('bot', e.message); status(''); return null; }
  }
  function aiPanel() {
    const sections = page().sections.map((s, i) => ({ s, i })).filter(({ s }) => 'text' in s.data || 'intro' in s.data);
    panel('AI tools', `<p class="mut small">AI uses only your real details. You approve every change. ${esc(S.meta.aiLine)}</p>
<h3>Rewrite text</h3><select id="rws">${sections.map(({ s, i }) => `<option value="${i}">${esc(S.meta.types[s.type])}${s.data.heading ? ' – ' + esc(s.data.heading) : ''}</option>`).join('')}</select>
<select id="rwh"><option>Make it clearer</option><option>Make it shorter</option><option>Make it friendlier</option><option>Fix spelling and grammar</option></select> <button id="rw">Suggest</button><div id="rwout"></div>
<h3>FAQ from your details</h3><button id="faq">Suggest FAQs</button><div id="faqout"></div>
<h3>Spanish version</h3><p class="small">${S.doc.translations?.es ? 'A Spanish version exists. Re-make it after big changes.' : 'Adds /es/ pages in Spanish.'}</p><button id="es">${S.doc.translations?.es ? 'Update' : 'Make'} Spanish version</button>${S.doc.translations?.es ? ' <button class="sec" id="rmes">Remove Spanish</button>' : ''}
<h3>Social posts</h3><button id="soc">Write posts about this site</button><div id="socout"></div>
<h3>AI assistant on your site</h3><label class="check"><input type="checkbox" id="asst"${S.meta.assistant ? ' checked' : ''}> Answer visitors' questions from this site's content (labeled as AI)</label>`, (b) => {
      $('#rw', b).onclick = async () => {
        const i = +$('#rws', b).value; const s = page().sections[i]; const field = 'text' in s.data ? 'text' : 'intro';
        const path = `pages.${pageIndex()}.sections.${i}.data.${field}`;
        const r = await aiCall('/ai/rewrite', { path, how: $('#rwh', b).value });
        if (r && r.suggestion) $('#rwout', b).innerHTML = `<div class="card"><p class="small mut">Suggestion (not saved yet):</p><p>${esc(r.suggestion)}</p><button id="ok">Approve</button> <button class="sec" id="no">Reject</button></div>`, $('#ok', b).onclick = () => commit((d) => setAt(d, path, r.suggestion), 'AI rewrite approved').then(() => ($('#rwout', b).innerHTML = '<p class="ok">Applied.</p>')), $('#no', b).onclick = () => ($('#rwout', b).innerHTML = '');
      };
      $('#faq', b).onclick = async () => {
        const r = await aiCall('/ai/faq', {});
        if (r && r.items) $('#faqout', b).innerHTML = `<div class="card">${r.items.length ? r.items.map((x) => `<p><b>${esc(x.q)}</b><br>${esc(x.a)}</p>`).join('') + '<button id="okf">Approve: add to FAQ page</button>' : '<p>Not enough details to write FAQs. Add more about your business first.</p>'}</div>`, r.items.length && ($('#okf', b).onclick = async () => { const res = await api('/ai/faq/apply', { items: r.items }); await setDoc(res.doc, 'AI FAQ approved'); $('#faqout', b).innerHTML = '<p class="ok">Added.</p>'; });
      };
      $('#es', b).onclick = () => aiCall('/ai/spanish', {}, 'Spanish version').then(() => aiPanel());
      const rm = $('#rmes', b); if (rm) rm.onclick = () => commit((d) => delete d.translations, 'Removed Spanish').then(aiPanel);
      $('#soc', b).onclick = async () => {
        const r = await aiCall('/ai/social', {});
        if (r && r.posts) $('#socout', b).innerHTML = Object.entries(r.posts).map(([k, v]) => `<div class="card"><b>${esc(k)}</b><p>${esc(v)}</p><button class="sm sec" data-copy="${esc(v)}">Copy</button> ${r.share[k] ? `<a class="small" href="${esc(r.share[k])}" target="_blank" rel="noopener">Share</a>` : ''}</div>`).join(''), b.querySelectorAll('[data-copy]').forEach((x) => (x.onclick = () => navigator.clipboard.writeText(x.dataset.copy).then(() => (x.textContent = 'Copied'))));
      };
      $('#asst', b).onchange = async (e) => { await api('/assistant', { on: e.target.checked }); S.meta.assistant = e.target.checked; say('bot', `AI assistant ${e.target.checked ? 'on (after you publish)' : 'off'}.`); };
    });
  }

  // ---------- images (item 28 crop/resize/compress, 53 AI images, 87 rights) ----------
  function openImage(path) {
    const isLogo = path === 'theme.logo';
    panel(isLogo ? 'Logo' : 'Image', `<label>Choose a photo<input type="file" id="f" accept="image/jpeg,image/png,image/webp"></label>
<label>Shape<select id="ratio"><option value="0">Original</option><option value="1">Square</option><option value="1.333">4:3</option><option value="1.778">16:9 (banner)</option></select></label>
<canvas id="cv" style="max-width:100%;display:none;border-radius:8px"></canvas>
<label>Describe the image (for people who can't see it) *<input id="alt" maxlength="200" required></label>
<label class="check"><input type="checkbox" id="rights"> <span>I took this photo or have the rights to use it.</span></label>
<p><button id="up" disabled>Use this image</button> <span id="sz" class="mut small"></span></p>
${isLogo ? '' : `<hr><h3>Or make one with AI</h3><p class="mut small">Labeled "AI-made" on your site. Uses 10 AI credits.</p><input id="ap" maxlength="300" placeholder="e.g. warm bakery counter with fresh bread, morning light"><button class="sec" id="gen">Generate</button>`}
${getAt(S.doc, path) ? '<hr><button class="danger sm" id="rmimg">Remove this image</button>' : ''}`, (b) => {
      let blob = null, img = null, gen = 0;
      const cv = $('#cv', b);
      const draw = async () => {
        if (!img || !img.complete || !img.width) return;
        const my = ++gen;
        const r = +$('#ratio', b).value;
        let sw = img.width, sh = img.height, sx = 0, sy = 0;
        if (r) { if (sw / sh > r) { sw = sh * r; sx = (img.width - sw) / 2; } else { sh = sw / r; sy = (img.height - sh) / 2; } }
        const max = isLogo ? 400 : 1600;
        const scale = Math.min(1, max / sw);
        cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
        cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        cv.style.display = 'block';
        let out = null;
        for (const q of [0.82, 0.7, 0.55, 0.4]) {
          out = await new Promise((res) => cv.toBlob(res, 'image/webp', q));
          if (!out || out.type !== 'image/webp') out = await new Promise((res) => cv.toBlob(res, 'image/jpeg', q));
          if (my !== gen) return; // a newer crop started; drop this one
          if (out.size < 600000) break;
        }
        blob = out;
        $('#sz', b).textContent = `${cv.width}×${cv.height}, ${Math.round(blob.size / 1024)} KB`;
        check();
      };
      const check = () => ($('#up', b).disabled = !(blob && $('#alt', b).value.trim() && $('#rights', b).checked));
      $('#f', b).onchange = (e) => { const file = e.target.files[0]; if (!file) return; b.dataset.name = file.name; img = new Image(); img.onload = draw; img.src = URL.createObjectURL(file); };
      $('#ratio', b).onchange = draw;
      $('#alt', b).oninput = check; $('#rights', b).onchange = check;
      $('#up', b).onclick = async () => {
        $('#up', b).disabled = true; status('Uploading…');
        const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
        try {
          const r = await api('/upload', { data, mime: blob.type, name: b.dataset.name || 'image', rightsConfirmed: true });
          await commit((d) => setAt(d, path, { src: r.src, alt: $('#alt', b).value.trim(), aiMade: false, rightsConfirmed: true }), 'Image');
          dlg.close();
        } catch (e) { status(e.message); $('#up', b).disabled = false; }
      };
      const genBtn = $('#gen', b);
      if (genBtn) genBtn.onclick = async () => {
        const p = $('#ap', b).value.trim(); if (!p) return;
        genBtn.disabled = true;
        const r = await aiCall('/ai/image', { prompt: p });
        genBtn.disabled = false;
        if (r && r.src) { await commit((d) => setAt(d, path, { src: r.src, alt: p.slice(0, 200), aiMade: true, rightsConfirmed: false }), 'AI image'); dlg.close(); }
      };
      const rm = $('#rmimg', b);
      if (rm) rm.onclick = () => commit((d) => {
        const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((a, k) => a[k], d);
        if (Array.isArray(o)) o.splice(+last, 1); else o[last] = null;
      }, 'Removed image').then(() => dlg.close());
    });
  }

  // ---------- publish (item 29 + Governor) ----------
  $('#publish').onclick = async () => {
    status('Checking…');
    try {
      const r = await api('/publish.json', {});
      const g = r.governor;
      const list = g.issues.length ? `<ul>${g.issues.map((i) => `<li class="${i.level === 'warn' ? 'warn' : 'bad'}"><b>${esc(i.where)}</b>: ${esc(i.msg)}</li>`).join('')}</ul>` : '';
      panel(r.published ? 'Published!' : r.held ? 'Waiting for review' : 'Fix these first',
        r.published ? `<p class="ok">Your site is live: <a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a></p>${list ? '<p>Suggestions:</p>' + list : ''}` : r.held ? `<p>The Governor flagged something that needs the owner's review. You'll get an email when it's decided.</p>${list}` : `<p>The Governor found things to fix before publishing:</p>${list}`);
      status('');
    } catch (e) { status(e.message); }
  };
  $('#preview-btn').onclick = () => window.open(`${API}/preview?page=${encodeURIComponent(page().slug)}&lang=${$('#lang').value}`, '_blank');
  $('#b-sections').onclick = sectionsPanel;
  $('#b-pages').onclick = pagesPanel;
  $('#b-brand').onclick = brandPanel;
  $('#b-versions').onclick = versionsPanel;
  $('#b-settings').onclick = settingsPanel;
  $('#b-ai').onclick = aiPanel;
  say('bot', `Hi! This is your site. Tap any text on the right to edit it, or tell me what to change. Say "help" for ideas.`);
  reload();
})();
