// Builder routes (items 21-30, 33-35, 52-57) + template gallery (34) + assets (28).
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { store } = require('../store');
const { oracle } = require('../oracle');
const sites = require('../sites');
const docs = require('../doc');
const templates = require('../templates');
const render = require('../render');
const chatops = require('../chatops');
const ai = require('../ai');
const auth = require('../auth');
const { page, esc } = require('../views');

const json = express.json({ limit: '1mb' });
const BUILDER_JS = fs.readFileSync(path.join(__dirname, '..', 'static', 'builder.js'), 'utf8');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const jerr = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });

const MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
async function saveAsset({ memberId, siteId, bytes, mime, name, rightsConfirmed, aiMade }) {
  const sig = MAGIC[mime];
  if (!sig || !sig.every((b, i) => bytes[i] === b)) throw Object.assign(new Error('Only JPEG, PNG or WebP images.'), { status: 400 });
  if (bytes.length > 650000) throw Object.assign(new Error('Image is too big after compressing. Try a smaller photo.'), { status: 413 });
  const id = await store.add('assets', { memberId, siteId, mime, data: bytes.toString('base64'), bytes: bytes.length, originalName: String(name || '').slice(0, 120), rightsConfirmed: !!rightsConfirmed, aiMade: !!aiMade, at: new Date().toISOString() });
  return `/a/${id}`;
}

function mount(app, { needMember }) {
  const M = [auth.requireLogin, needMember];
  const owned = async (req) => {
    const s = await sites.getOwnedSite(req.member, req.params.id);
    await sites.ensureDoc(s);
    return s;
  };

  app.get('/static/builder.js', (_req, res) => { res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=300'); res.send(BUILDER_JS); });

  // Item 28: images are served from the store with long caching (CDN friendly).
  app.get('/a/:id', wrap(async (req, res) => {
    const a = await store.get('assets', String(req.params.id));
    if (!a) return res.status(404).send('Not found');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(a.mime).send(Buffer.from(a.data, 'base64'));
  }));

  // ---------- Item 21: the builder ----------
  app.get('/sites/:id/builder', ...M, wrap(async (req, res) => {
    const s = await owned(req);
    const all = await templates.allTemplates();
    const meta = {
      types: docs.SECTION_TYPES, fonts: templates.FONTS, assistant: !!s.assistant,
      templates: all.map((t) => ({ id: t.id, name: t.name, light: t.theme.light, dark: t.theme.dark, fonts: [t.theme.headingFont, t.theme.bodyFont] })),
      aiLine: ai.connected() ? '' : 'AI: Not connected (plain chat commands still work).',
    };
    const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
    res.send(page(`Builder - ${s.details.businessName}`, `
<style>
.wrap{max-width:none;padding:0}.bld{display:grid;grid-template-columns:minmax(280px,360px) 1fr;height:calc(100dvh - 62px)}
.chatcol{display:flex;flex-direction:column;border-right:1px solid var(--line);background:var(--card);min-height:0}
#log{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}.msg{padding:9px 12px;border-radius:12px;max-width:92%;white-space:pre-wrap;font-size:15px}
.msg.me{align-self:flex-end;background:var(--acc);color:var(--accfg)}.msg.bot{align-self:flex-start;background:var(--bg);border:1px solid var(--line)}
#chat{display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)}#chat textarea{margin:0;min-height:44px;resize:vertical}
.quick{display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 10px}.quick button,.sm{padding:6px 10px;min-height:36px;font-size:14px}
.pvcol{display:flex;flex-direction:column;min-height:0;background:var(--bg)}.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;border-bottom:1px solid var(--line)}
.bar select{width:auto;margin:0;padding:8px}#frame-wrap{flex:1;display:flex;justify-content:center;overflow:auto;padding:8px}#pv{border:1px solid var(--line);border-radius:10px;background:#fff;width:100%;height:100%}
#frame-wrap[data-dev=phone] #pv{width:390px}#frame-wrap[data-dev=tablet] #pv{width:820px}
.tabs{display:none}@media(max-width:760px){.bld{grid-template-columns:1fr;height:calc(100dvh - 110px)}.tabs{display:flex}.tabs button{flex:1;border-radius:0}
.bld[data-tab=chat] .pvcol,.bld[data-tab=preview] .chatcol{display:none}}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--fg);width:min(560px,calc(100vw - 20px));max-height:85dvh;padding:0}dialog::backdrop{background:#0007}
.dh{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card)}#panel-body{padding:12px 16px}
.slist{padding-left:1.2em}.slist li{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}.slist input{margin:0}
select{padding:10px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}input[type=color]{width:44px;height:36px;padding:2px;margin:2px}.small{font-size:13px}
</style>
<div class="tabs" role="tablist"><button role="tab" data-tab="chat" aria-selected="true">Chat</button><button role="tab" class="sec" data-tab="preview" aria-selected="false">Preview</button></div>
<div class="bld" id="bld" data-site="${esc(s.id)}" data-tab="chat">
<aside class="chatcol" aria-label="Builder chat"><div id="log" aria-live="polite"></div>
<div class="quick"><button class="sec" data-say="add gallery">+ Gallery</button><button class="sec" data-say="add faq">+ FAQ</button><button class="sec" data-say="add quote form">+ Quote form</button><button class="sec" data-say="help">Help</button></div>
<form id="chat"><label for="msg" class="skip">Message</label><textarea id="msg" rows="2" placeholder="Tell me what to change…" maxlength="1000"></textarea><button>Send</button></form></aside>
<section class="pvcol" aria-label="Live preview"><div class="bar">
<select id="pagesel" aria-label="Page"></select><select id="lang" aria-label="Language" hidden><option value="en">English</option><option value="es">Español</option></select>
<button class="sm sec" id="undo" aria-label="Undo">↶ Undo</button><button class="sm sec" id="redo" aria-label="Redo">↷ Redo</button>
<button class="sm sec" id="b-sections">Sections</button><button class="sm sec" id="b-pages">Pages</button><button class="sm sec" id="b-brand">Brand</button><button class="sm sec" id="b-ai">AI</button><button class="sm sec" id="b-versions">History</button><button class="sm sec" id="b-settings">Settings</button>
<span class="row" role="group" aria-label="Device"><button class="sm sec" data-dev="phone" aria-pressed="false">📱</button><button class="sm sec" data-dev="tablet" aria-pressed="false">Tablet</button><button class="sm sec" data-dev="full" aria-pressed="true">Full</button></span>
<button class="sm sec" id="preview-btn">Preview</button><button class="sm" id="publish">Publish</button><span id="status" class="mut small" role="status"></span></div>
<div id="frame-wrap" data-dev="full"><iframe id="pv" title="Site preview"></iframe></div></section></div>
<dialog id="panel"><div class="dh"><b id="panel-title"></b><button class="sm sec" id="panel-close">Close</button></div><div id="panel-body"></div></dialog>
<script type="application/json" id="doc-json">${safe(s.doc)}</script><script type="application/json" id="meta-json">${safe(meta)}</script>
<script src="/static/builder.js"></script>`, { user: req.user }));
  }));

  app.get('/sites/:id/preview', ...M, wrap(async (req, res) => {
    const s = await owned(req);
    const template = await templates.getTemplate(s.doc.template);
    let slug = String(req.query.page || ''), lang = req.query.lang === 'es' ? 'es' : 'en';
    if (slug === 'es' || slug.startsWith('es/')) { lang = 'es'; slug = slug.slice(3); }
    if (!s.doc.translations?.es) lang = 'en';
    const html = sites.renderSite(s, { pageSlug: slug, lang, base: `/sites/${s.id}/preview?page=`, edit: req.query.edit === '1', preview: true, template, canonicalBase: '' });
    res.setHeader('Cache-Control', 'no-store');
    if (!html) return res.status(404).send('No such page');
    res.send(html);
  }));

  app.get('/sites/:id/doc.json', ...M, wrap(async (req, res) => res.json({ doc: (await owned(req)).doc })));
  app.post('/sites/:id/doc', ...M, json, async (req, res) => {
    try { await owned(req); res.json({ doc: await sites.saveDoc(req.member, req.params.id, req.body?.doc, req.user.email, String(req.body?.note || 'Edit')) }); } catch (e) { jerr(res, e); }
  });
  app.post('/sites/:id/new-section', ...M, json, async (req, res) => {
    try { const s = await owned(req); res.json({ section: docs.sectionFor(String(req.body?.type), { menu: [], faqs: [], ...s.details }) }); } catch (e) { jerr(res, Object.assign(e, { status: 400 })); }
  });
  app.post('/sites/:id/chat', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const r = await chatops.chat({ member: req.member, site: s, doc: s.doc, pageId: req.body?.pageId, message: req.body?.message });
      if (r.doc) r.doc = await sites.saveDoc(req.member, s.id, r.doc, req.user.email, 'Chat: ' + String(req.body?.message || '').slice(0, 80));
      res.json(r);
    } catch (e) { jerr(res, e); }
  });
  app.get('/sites/:id/versions', ...M, wrap(async (req, res) => {
    await owned(req);
    res.json({ versions: (await sites.versions(req.params.id)).map((v) => ({ id: v.id, at: v.at, note: v.note })) });
  }));
  app.post('/sites/:id/versions/:vid/restore', ...M, json, async (req, res) => {
    try { res.json({ doc: await sites.restoreVersion(req.member, req.params.id, req.params.vid, req.user.email) }); } catch (e) { jerr(res, e); }
  });
  app.post('/sites/:id/upload', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      if (req.body?.rightsConfirmed !== true) throw Object.assign(new Error('Please confirm you have the rights to this image.'), { status: 400 });
      const src = await saveAsset({ memberId: req.member.id, siteId: s.id, bytes: Buffer.from(String(req.body?.data || ''), 'base64'), mime: req.body?.mime, name: req.body?.name, rightsConfirmed: true });
      await oracle(req.user.email, 'asset.uploaded', { site: s.id, src });
      res.json({ src });
    } catch (e) { jerr(res, e); }
  });
  app.post('/sites/:id/publish.json', ...M, async (req, res) => {
    try {
      const s = await owned(req);
      const r = await sites.publish(req.member, s.id, req.user.email);
      res.json({ ...r, url: require('../publicSite').canonicalFor(s, null) });
    } catch (e) { jerr(res, e); }
  });
  app.post('/sites/:id/assistant', ...M, json, async (req, res) => {
    try { const s = await owned(req); await store.update('sites', s.id, { assistant: !!req.body?.on }); await oracle(req.user.email, 'site.assistant', { site: s.id, on: !!req.body?.on }); res.json({ ok: true }); } catch (e) { jerr(res, e); }
  });

  // ---------- AI helpers (items 52-57) ----------
  const need = (r) => { if (!r.ok) throw Object.assign(new Error(r.reason), { status: r.reason === 'AI: Not connected' ? 503 : 400 }); return r; };
  const facts = (s) => JSON.stringify(s.details);

  // 52: AI writer -> suggestion only; member approves in the builder.
  app.post('/sites/:id/ai/rewrite', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const p = String(req.body?.path || '');
      if (!/^pages\.\d+\.sections\.\d+\.data\.(text|intro)$/.test(p)) throw Object.assign(new Error('Pick a text section.'), { status: 400 });
      const before = p.split('.').reduce((o, k) => o?.[k], s.doc);
      if (!before) throw Object.assign(new Error('That section is empty. Write something first.'), { status: 400 });
      const how = ['Make it clearer', 'Make it shorter', 'Make it friendlier', 'Fix spelling and grammar'].includes(req.body?.how) ? req.body.how : 'Make it clearer';
      const r = need(await ai.text({ memberId: req.member.id, task: 'rewrite', prompt: `${how}. Keep every fact exactly; add no new facts.\n\nTEXT:\n${before}` }));
      await store.add('suggestions', { siteId: s.id, kind: 'rewrite', path: p, before, after: r.text, at: new Date().toISOString(), status: 'shown' });
      res.json({ suggestion: r.text.slice(0, 4000) });
    } catch (e) { jerr(res, e); }
  });
  // 53: Imagen -> asset marked aiMade (labeled "AI-made" on the site).
  app.post('/sites/:id/ai/image', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const prompt = String(req.body?.prompt || '').slice(0, 300);
      if (!prompt) throw Object.assign(new Error('Describe the image.'), { status: 400 });
      const gov = await require('../governor').check(s, { pages: [{ title: 'AI image', sections: [{ type: 'text', data: { text: prompt } }] }], theme: {} });
      if (gov.status === 'hold') throw Object.assign(new Error('That description is not allowed.'), { status: 400 });
      const r = need(await ai.image({ memberId: req.member.id, prompt }));
      const src = await saveAsset({ memberId: req.member.id, siteId: s.id, bytes: r.bytes, mime: r.mime, name: 'ai-image', aiMade: true });
      res.json({ src, message: 'AI image added. It is labeled "AI-made" on your site.' });
    } catch (e) { jerr(res, e); }
  });
  // 54: meta tags for every page (AI if connected, otherwise filled from real content).
  app.post('/sites/:id/ai/meta', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const doc = structuredClone(s.doc);
      const name = s.details.businessName;
      let gen = null;
      if (ai.connected()) {
        const r = await ai.text({ memberId: req.member.id, task: 'meta', json: true, prompt: `Write SEO meta for each page using only this content. Return {"pages":[{"id","title"(<=60 chars),"description"(<=155 chars),"keywords"(comma list, <=8)}]}.\nBusiness: ${facts(s)}\n${doc.pages.map((p) => `PAGE id=${p.id} title=${p.title}\n${docs.docText(doc, [p]).slice(0, 1500)}`).join('\n\n')}` });
        if (r.ok && Array.isArray(r.data.pages)) gen = r.data.pages;
      }
      for (const p of doc.pages) {
        const g = gen?.find((x) => x.id === p.id);
        const text = docs.docText(doc, [p]).split('\n').filter((l) => !l.startsWith('#')).join(' ');
        p.meta = {
          ...p.meta,
          title: (g?.title || p.meta.title || (p.slug ? `${p.title} - ${name}` : `${name}${s.details.tagline ? ' - ' + s.details.tagline : ''}`)).slice(0, 70),
          description: (g?.description || p.meta.description || text).slice(0, 160),
          keywords: (g?.keywords || p.meta.keywords || [name, ...s.details.services.slice(0, 5)].join(', ')).slice(0, 200),
          robots: p.meta.robots || 'index,follow',
        };
      }
      res.json({ doc: docs.clean(doc), message: gen ? 'AI wrote meta tags for every page. Check them in Settings.' : 'Meta tags filled from your content (AI not connected).' });
    } catch (e) { jerr(res, e); }
  });
  // 55: Spanish version.
  app.post('/sites/:id/ai/spanish', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const strings = [];
      const walk = (o) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && v.trim() && !['src', 'href', 'kind', 'price', 'phone', 'email', 'id', 'type', 'slug', 'robots', 'ogImage'].includes(k)) strings.push(v); else if (v && typeof v === 'object') walk(v); } };
      const pages = structuredClone(s.doc.pages);
      walk(pages);
      const uniq = [...new Set(strings)];
      const r = need(await ai.text({ memberId: req.member.id, task: 'spanish', json: true, prompt: `Translate each string to natural Spanish for a small-business website. Keep names, prices, addresses, phone numbers unchanged. Return {"t":[...]} same order and length.\n${JSON.stringify(uniq)}` }));
      const t = Array.isArray(r.data.t) && r.data.t.length === uniq.length ? r.data.t : null;
      if (!t) throw Object.assign(new Error('Translation came back incomplete. Try again.'), { status: 502 });
      const map = new Map(uniq.map((u, i) => [u, String(t[i])]));
      const tr = (o) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && map.has(v) && !['src', 'href', 'kind', 'price', 'phone', 'email', 'id', 'type', 'slug', 'robots', 'ogImage'].includes(k)) o[k] = map.get(v); else if (v && typeof v === 'object') tr(v); } };
      tr(pages);
      const doc = { ...s.doc, translations: { es: { pages, at: new Date().toISOString() } } };
      res.json({ doc: docs.clean(doc), message: 'Spanish version made. Pick "Español" above the preview to check it, then Publish.' });
    } catch (e) { jerr(res, e); }
  });
  // 56: social posts members copy or share.
  app.post('/sites/:id/ai/social', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const url = require('../publicSite').canonicalFor(s, null);
      const r = need(await ai.text({ memberId: req.member.id, task: 'social', json: true, prompt: `Write 3 short posts announcing this business's website update, using only these facts. Return {"Facebook":"...","Instagram":"... with up to 5 hashtags","X":"under 250 chars"}. Include the link ${url} in Facebook and X.\nFacts: ${facts(s)}\nSite: ${docs.docText(s.doc).slice(0, 3000)}` }));
      const posts = { Facebook: String(r.data.Facebook || ''), Instagram: String(r.data.Instagram || ''), X: String(r.data.X || '').slice(0, 280) };
      const share = { Facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, X: `https://x.com/intent/post?text=${encodeURIComponent(posts.X)}`, Instagram: '' };
      res.json({ posts, share });
    } catch (e) { jerr(res, e); }
  });
  // 57: FAQ builder from the member's details -> approve to add.
  app.post('/sites/:id/ai/faq', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const r = need(await ai.text({ memberId: req.member.id, task: 'faq', json: true, prompt: `Write up to 6 FAQs a customer would ask, answered ONLY from these facts. Skip any question the facts can't answer. Return {"items":[{"q","a"}]}.\nFacts: ${facts(s)}` }));
      res.json({ items: (Array.isArray(r.data.items) ? r.data.items : []).slice(0, 6).map((x) => ({ q: String(x.q || '').slice(0, 200), a: String(x.a || '').slice(0, 1200) })).filter((x) => x.q && x.a) });
    } catch (e) { jerr(res, e); }
  });
  app.post('/sites/:id/ai/faq/apply', ...M, json, async (req, res) => {
    try {
      const s = await owned(req);
      const doc = structuredClone(s.doc);
      let p = doc.pages.find((x) => x.slug === 'faq');
      if (!p) { p = { id: 'faq', slug: 'faq', title: 'FAQ', nav: true, sections: [], meta: {} }; doc.pages.splice(Math.max(1, doc.pages.length - 1), 0, p); }
      let sec = p.sections.find((x) => x.type === 'faq');
      if (!sec) { sec = docs.sectionFor('faq', { faqs: [] }); p.sections.push(sec); }
      sec.data.items.push(...(Array.isArray(req.body?.items) ? req.body.items : []));
      res.json({ doc: docs.clean(doc) });
    } catch (e) { jerr(res, e); }
  });

  // ---------- Item 30: export to member's GitHub ----------
  app.post('/account/github', ...M, wrap(async (req, res) => {
    const tok = String(req.body.token || '').trim();
    if (!/^(gh[pous]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(tok)) return res.status(400).send(page('GitHub', '<p class="bad">That does not look like a GitHub token.</p><p><a href="/dashboard">Back</a></p>', { user: req.user }));
    await store.update('members', req.member.id, { githubTokenBox: require('../secretbox').seal(tok) });
    await oracle(req.user.email, 'github.connected', { member: req.member.id });
    res.redirect(303, '/dashboard#github');
  }));
  app.post('/sites/:id/export/github', ...M, wrap(async (req, res) => {
    const s = await owned(req);
    try {
      const repo = await require('../github').exportToMember(req.member, s, req.body.repo);
      res.send(page('Exported', `<p class="ok">Exported to <a href="https://github.com/${esc(repo)}">github.com/${esc(repo)}</a> (private).</p><p><a href="/dashboard">Back</a></p>`, { user: req.user }));
    } catch (e) {
      res.status(e.status && e.status < 500 ? 400 : 502).send(page('Export failed', `<p class="bad">${esc(e.message)}</p><p><a href="/dashboard">Back</a></p>`, { user: req.user }));
    }
  }));

  // ---------- Item 34: template gallery with live demos labeled "Sample" ----------
  app.get('/templates', wrap(async (req, res) => {
    const all = await templates.allTemplates();
    res.send(page('Templates', `<h1>Templates</h1><p class="mut">Every demo uses sample text, marked "Sample". Your site uses only your real details.</p>
<div class="tgrid">${all.map((t) => `<div class="card"><div class="sw">${[...t.theme.light, ...t.theme.dark].map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</div><h3>${esc(t.name)}</h3><p class="mut">${esc(t.industry || '')} · ${esc(t.theme.headingFont)} / ${esc(t.theme.bodyFont)}</p><a class="btn sec" href="/templates/${esc(t.id)}/demo">View sample</a></div>`).join('')}</div>
<style>.tgrid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr))}.sw{display:flex;height:22px;border-radius:6px;overflow:hidden}.sw i{flex:1}</style>`, { user: req.user }));
  }));
  app.get('/templates/:id/demo', wrap(async (req, res) => {
    const t = (await templates.allTemplates({ includeUnapproved: !!req.user?.isOwner })).find((x) => x.id === req.params.id);
    if (!t) return res.status(404).send('Not found');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(demoHtml(t, `/templates/${t.id}/demo?page=`, String(req.query.page || '')));
  }));
}

function demoDoc(t) {
  const d = { ...t.sample, description: 'Sample text: this is where your real story goes.', phone: '', email: '', address: '', hours: 'Sample: Mon-Fri 9-5', menu: [], faqs: [{ q: 'Sample question?', a: 'Sample answer.' }], takesBookings: (t.extraPages || []).includes('booking') };
  return { d, doc: docs.buildDoc(d, t) };
}
function demoHtml(t, base, slug) {
  const { d, doc } = demoDoc(t);
  const p = doc.pages.find((x) => x.slug === slug) || doc.pages[0];
  return render.renderPage({ details: d }, doc, p, { base, template: t, preview: true })
    .replace('<body>', '<body><div role="note" style="position:sticky;top:0;z-index:9;background:#111;color:#fff;text-align:center;padding:6px;font:600 14px system-ui">SAMPLE - demo template with sample text</div>');
}

module.exports = { mount, saveAsset, demoDoc, demoHtml };
