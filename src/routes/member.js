// Member routes: items 38 (PageSpeed), 44 (domains), 47 (restore backups),
// 58 (AI lead replies), 61 (Google sign-in), 62 (Oracle profile), 64 (stats),
// 65 (leads inbox), 66 (checklist), 68 (help center), 69 (referrals),
// 79 (support bot), 89 (data download / deletion request), 32 (skins).
const express = require('express');
const config = require('../config');
const { store } = require('../store');
const { oracle } = require('../oracle');
const { sendEmail } = require('../email');
const auth = require('../auth');
const billing = require('../billing');
const sites = require('../sites');
const ai = require('../ai');
const docs = require('../doc');
const domains = require('../domains');
const referrals = require('../referrals');
const firebase = require('../firebase');
const security = require('../security');
const { SKINS } = require('../templates');
const { page, esc } = require('../views');

const json = express.json({ limit: '20kb' });
const day = (t) => new Date(t).toISOString().slice(0, 10);

const GUIDES = [
  ['start', 'Getting started', 'Sign in, then on your Dashboard fill in "Build a site" with your real business details and pick a template. Tap "Create site", then "Open builder".'],
  ['edit', 'Editing your site', 'In the builder, tap any text in the preview to change it. Tap an image to upload or change it. Use Undo/Redo at the top. "History" lets you go back to any saved version.'],
  ['sections', 'Adding sections and pages', 'Tap "Sections" to add, move or remove sections like Gallery, FAQ, Pricing or Map. Tap "Pages" to add or rename pages. You can also type in the chat: "add gallery", "add page Team".'],
  ['photos', 'Photos', 'Tap an image spot, choose a photo, pick a shape (square, 4:3, 16:9). Photos are resized and compressed for you. Describe each photo for people who can\'t see it, and confirm you have the rights to it.'],
  ['brand', 'Logo, colors and fonts', 'Tap "Brand" to upload a logo and pick colors and fonts. They apply to every page. Switching templates keeps all your content.'],
  ['publish', 'Publishing', 'Tap "Publish". The Governor checks your site first (no fake reviews or badges, image descriptions, readable colors). Fix anything it lists, then publish again.'],
  ['forms', 'Forms and leads', 'Contact, quote and booking forms send messages to your Leads inbox and your email. In Leads, tap "Draft reply with AI" to get a draft you can edit before sending.'],
  ['domain', 'Your web address', `Every site has a backup address ${config.domain}/s/your-site. Custom domains: open your site's "Domain" page for step-by-step DNS help.`],
  ['ai', 'AI tools', 'In the builder tap "AI": rewrite text, make FAQs from your details, a Spanish version, social posts and AI images. Nothing changes until you approve. Your monthly AI allowance is on the dashboard.'],
  ['billing', 'Billing and cancelling', 'Billing shows your next charge, card and invoices. To cancel: Dashboard → Membership → Cancel. You keep access until your paid period ends.'],
  ['data', 'Your data', 'Dashboard → Your data: download everything as a file, or request account deletion (a person reviews it).'],
];

async function memberSites(m) { return (await store.where('sites', 'memberId', m.id)).filter((s) => !s.archived); }
async function ownedSite(req) { return sites.getOwnedSite(req.member, req.params.id); }

// Dashboard additions (rendered inside the dashboard in server.js).
async function dashboardExtras(req) {
  const m = req.member;
  const list = await memberSites(m);
  const u = await ai.usage(m.id);
  const leads = (await store.where('leads', 'memberId', m.id)).filter((l) => !l.spam);
  const newLeads = leads.filter((l) => l.status === 'new').length;
  const doms = (await store.where('domains', 'memberId', m.id)).filter((d) => d.status === 'verified');
  const steps = [
    ['Add your business info', list.length > 0, '#new'],
    ['Pick a template', list.some((s) => s.templateChosen || (s.doc && s.doc.template !== 'advisory')), list[0] ? `/sites/${list[0].id}/builder` : '#new'],
    ['Publish your site', list.some((s) => s.published), list[0] ? `/sites/${list[0].id}/builder` : '#new'],
    ['Connect a domain', doms.length > 0 || process.env.SUBDOMAINS_LIVE === 'yes', list[0] ? `/sites/${list[0].id}/domain` : '#new'],
  ];
  const done = steps.filter((s) => s[1]).length;
  const code = await referrals.codeFor(m);
  return `${done < steps.length ? `<div class="card"><h2 style="margin-top:0">Getting started (${done} of ${steps.length})</h2><ol>${steps.map(([t, ok, href]) => `<li>${ok ? `<span class="ok">✓</span> <s>${esc(t)}</s>` : `<a href="${esc(href)}">${esc(t)}</a>`}</li>`).join('')}</ol></div>` : ''}
<div class="card"><div class="row" style="justify-content:space-between"><span><b>Leads:</b> ${newLeads} new of ${leads.length} · <a href="/leads">Open inbox</a></span>
<span><b>AI this month:</b> ${u.used} of ${u.allowance} credits${ai.connected() ? '' : ' <span class="mut">(AI: Not connected)</span>'}</span></div>
<div class="meter" role="img" aria-label="${u.used} of ${u.allowance} AI credits used"><i style="width:${Math.min(100, Math.round((u.used / u.allowance) * 100))}%"></i></div></div>
<div class="card"><h2 style="margin-top:0">Refer a friend</h2><p>Share your link. When a friend becomes a paying member (after their first $100.00 bill), you get a $${(referrals.REWARD() / 100).toFixed(2)} bill credit after review.</p><input readonly value="${esc(referrals.linkFor(code))}" aria-label="Your referral link" onclick="this.select()"></div>
<div class="card" id="look"><h2 style="margin-top:0">Builder look</h2><form method="post" action="/account/skin" class="row">${Object.entries(SKINS).map(([k, s]) => `<label class="check"><input type="radio" name="skin" value="${k}"${(m.settings?.skin || 'classic') === k ? ' checked' : ''}> ${esc(s.name)}</label>`).join('')}<button class="sec">Save</button></form></div>
<div class="card" id="github"><h2 style="margin-top:0">Export to GitHub</h2>${m.githubTokenBox ? `<p class="ok">GitHub connected.</p>${list.map((s) => `<form method="post" action="/sites/${s.id}/export/github" class="row"><input name="repo" value="${esc(s.slug)}" aria-label="Repository name for ${esc(s.slug)}" style="max-width:240px"><button class="sec">Export ${esc(s.details.businessName)}</button></form>`).join('')}` : `<p class="mut">Paste a GitHub token with "repo" access. It's encrypted and never shown again.</p><form method="post" action="/account/github" class="row"><input name="token" type="password" autocomplete="off" aria-label="GitHub token" style="max-width:320px"><button class="sec">Connect GitHub</button></form>`}</div>
<div class="card" id="data"><h2 style="margin-top:0">Your data</h2><div class="row"><a class="btn sec" href="/profile">Your profile</a><a class="btn sec" href="/account/export">Download my data</a>
<details><summary>Request account deletion</summary><form method="post" action="/account/delete-request"><p>A person reviews deletion requests. Your sites stay until it's approved.</p><label class="check"><input type="checkbox" name="confirm" value="yes" required> I want my account and sites deleted.</label><button class="danger">Send request</button></form></details></div></div>`;
}

function siteLinks(s) {
  return `<a href="/sites/${s.id}/builder">Open builder</a> · <a href="/sites/${s.id}/stats">Stats</a> · <a href="/sites/${s.id}/domain">Domain</a> · <a href="/sites/${s.id}/backups">Backups</a>`;
}

function mount(app, { needMember, wrap }) {
  const M = [auth.requireLogin, needMember];

  // ---------- 61 Google sign-in ----------
  app.get('/login/google.js', (_req, res) => {
    if (!firebase.configured()) return res.status(404).send('');
    res.type('application/javascript').send(`(async()=>{const c=${JSON.stringify(firebase.webConfig())};firebase.initializeApp(c);
document.getElementById('gbtn').onclick=async()=>{try{const r=await firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider());const t=await r.user.getIdToken();
const f=await fetch('/login/firebase',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken:t})});const j=await f.json();if(j.ok)location.href=j.next;else alert(j.error||'Sign-in failed')}catch(e){alert('Google sign-in was cancelled or failed.')}}})();`);
  });
  app.post('/login/firebase', security.rateLimit('login', 10, 10 * 60e3), json, wrap(async (req, res) => {
    if (!firebase.configured()) return res.status(503).json({ error: 'Google sign-in: Not connected' });
    let who;
    try { who = await firebase.verifyIdToken(req.body?.idToken); } catch { return res.status(401).json({ error: 'Google sign-in failed.' }); }
    const m = await billing.memberByEmail(who.email);
    if (!m && !auth.isOwnerEmail(who.email)) return res.status(404).json({ error: 'No membership for that Google account. Get started on the home page.' });
    if (m && !m.googleUid) await store.update('members', m.id, { googleUid: who.uid });
    auth.startSession(res, who.email, 'google');
    await oracle(who.email, 'login.google', {});
    res.json({ ok: true, next: auth.isOwnerEmail(who.email) ? '/owner' : '/dashboard' });
  }));

  // ---------- 32 skins ----------
  app.post('/account/skin', ...M, wrap(async (req, res) => {
    const skin = SKINS[req.body.skin] ? req.body.skin : 'classic';
    await store.update('members', req.member.id, { settings: { ...(req.member.settings || {}), skin } });
    res.redirect(303, '/dashboard#look');
  }));

  // ---------- 65 leads inbox + 58 AI reply drafts ----------
  app.get('/leads', ...M, wrap(async (req, res) => {
    const all = (await store.where('leads', 'memberId', req.member.id)).sort((a, b) => (a.at < b.at ? 1 : -1));
    const showSpam = req.query.spam === '1';
    const list = all.filter((l) => !!l.spam === showSpam);
    const names = Object.fromEntries((await memberSites(req.member)).map((s) => [s.id, s.details.businessName]));
    res.send(page('Leads', `<h1>Leads inbox</h1><p><a href="/leads${showSpam ? '' : '?spam=1'}">${showSpam ? 'Back to inbox' : `Spam (${all.filter((l) => l.spam).length})`}</a></p>
${list.length ? list.map((l) => `<div class="card" id="${esc(l.id)}"><div class="row" style="justify-content:space-between"><b>${esc(l.name)}</b><span class="pill ${l.status === 'new' ? 'ok' : 'mut'}">${esc(l.status)}</span></div>
<p class="mut">${esc(l.kind)} · ${esc(names[l.siteId] || '')} · ${esc(new Date(l.at).toLocaleString('en-US'))}</p><p><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.phone ? ` · <a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : ''}${l.date ? ` · wants ${esc(l.date)} ${esc(l.time)}` : ''}</p>
<p>${esc(l.message).replace(/\n/g, '<br>')}</p>
${l.reply ? `<p class="mut">You replied ${esc(new Date(l.reply.at).toLocaleString('en-US'))}:</p><blockquote>${esc(l.reply.text).replace(/\n/g, '<br>')}</blockquote>` : `<form method="post" action="/leads/${esc(l.id)}/send"><label>Your reply</label><textarea name="text" rows="4" maxlength="5000">${esc(l.draft || '')}</textarea>
<div class="row"><button>Send reply</button><button class="sec" formaction="/leads/${esc(l.id)}/draft">Draft reply with AI</button>${l.status === 'new' ? `<button class="sec" formaction="/leads/${esc(l.id)}/read">Mark read</button>` : ''}</div>${l.draft ? '<p class="mut small">AI draft - check and edit it before sending. Nothing is sent until you tap Send.</p>' : ''}</form>`}</div>`).join('') : '<p class="mut">No messages yet. When someone sends a form on your site, it shows up here and in your email.</p>'}`, { user: req.user, flash: req.query.f || '' }));
  }));
  const ownedLead = async (req) => {
    const l = await store.get('leads', req.params.id);
    if (!l || l.memberId !== req.member.id) throw Object.assign(new Error('Not found'), { status: 404 });
    return l;
  };
  app.post('/leads/:id/read', ...M, wrap(async (req, res) => { const l = await ownedLead(req); await store.update('leads', l.id, { status: 'read' }); res.redirect(303, '/leads#' + l.id); }));
  app.post('/leads/:id/draft', ...M, wrap(async (req, res) => {
    const l = await ownedLead(req);
    const s = await store.get('sites', l.siteId);
    const r = await ai.text({ memberId: req.member.id, task: 'lead-reply', prompt: `Draft a short, friendly email reply from ${s?.details?.businessName || 'the business'} to this ${l.kind} request. Use only facts from the business info. Don't promise prices, dates or availability that aren't given; say the business will confirm. Sign off with the business name.\nBUSINESS INFO: ${JSON.stringify(s?.details || {})}\nREQUEST from ${l.name}: ${l.message} ${l.date ? `(wants ${l.date} ${l.time})` : ''}` });
    if (!r.ok) return res.redirect(303, `/leads?f=${encodeURIComponent(r.reason)}#${l.id}`);
    await store.update('leads', l.id, { draft: r.text.slice(0, 5000), status: l.status === 'new' ? 'read' : l.status });
    res.redirect(303, '/leads#' + l.id);
  }));
  app.post('/leads/:id/send', ...M, wrap(async (req, res) => {
    const l = await ownedLead(req);
    const text = String(req.body.text || '').trim().slice(0, 5000);
    if (!text) return res.redirect(303, '/leads?f=' + encodeURIComponent('Write a reply first.') + '#' + l.id);
    const s = await store.get('sites', l.siteId);
    const r = await sendEmail({ to: l.email, kind: 'lead_reply', subject: `Re: your ${l.kind} request - ${s?.details?.businessName || ''}`, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p><p style="color:#666;font-size:12px">Reply to: ${esc(s?.details?.email || req.member.email)}</p>` });
    if (r.status !== 'sent') return res.redirect(303, `/leads?f=${encodeURIComponent('Not sent: ' + r.status.replace(/^not sent: /, ''))}#${l.id}`);
    await store.update('leads', l.id, { reply: { text, at: new Date().toISOString() }, status: 'replied' });
    await oracle(req.user.email, 'lead.replied', { lead: l.id });
    res.redirect(303, '/leads#' + l.id);
  }));

  // ---------- 64 stats + 38 PageSpeed ----------
  app.get('/sites/:id/stats', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    const rows = (await store.where('stats', 'siteId', s.id)).sort((a, b) => (a.day < b.day ? 1 : -1));
    const last30 = rows.filter((r) => r.day >= day(Date.now() - 30 * 864e5));
    const visits = last30.reduce((a, r) => a + r.visits, 0);
    const pages = {};
    for (const r of last30) for (const [k, v] of Object.entries(r.pages)) pages[k] = (pages[k] || 0) + v;
    const leads = (await store.where('leads', 'siteId', s.id)).filter((l) => !l.spam && l.at >= new Date(Date.now() - 30 * 864e5).toISOString()).length;
    const ps = s.pagespeed;
    const max = Math.max(1, ...last30.map((r) => r.visits));
    res.send(page('Stats', `<h1>${esc(s.details.businessName)} - last 30 days</h1><div class="row"><div class="card"><b style="font-size:28px">${visits}</b><br>visits</div><div class="card"><b style="font-size:28px">${leads}</b><br>form leads</div>
<div class="card"><b style="font-size:28px">${ps ? ps.score : '–'}</b><br>PageSpeed (mobile)${ps ? `<br><span class="mut small">${esc(ps.at.slice(0, 10))}</span>` : ''}</div></div>
<p class="mut small">Real visits only (search-engine bots are not counted). Zero until real people visit.</p>
<div class="card"><h2 style="margin-top:0">Visits per day</h2>${last30.length ? `<table>${last30.map((r) => `<tr><td>${esc(r.day)}</td><td style="width:60%"><div class="meter"><i style="width:${Math.round((r.visits / max) * 100)}%"></i></div></td><td>${r.visits}</td></tr>`).join('')}</table>` : '<p class="mut">No visits yet.</p>'}</div>
<div class="card"><h2 style="margin-top:0">Top pages</h2>${Object.keys(pages).length ? `<table>${Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>` : '<p class="mut">No visits yet.</p>'}</div>
<form method="post" action="/sites/${s.id}/pagespeed"><button class="sec"${s.published ? '' : ' disabled'}>Run PageSpeed test</button>${s.published ? '' : ' <span class="mut">Publish first.</span>'}</form><p><a href="/dashboard">Back</a></p>`, { user: req.user, flash: req.query.f || '' }));
  }));
  app.post('/sites/:id/pagespeed', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    const url = require('../publicSite').canonicalFor(s, null);
    try {
      const key = process.env.PAGESPEED_API_KEY ? `&key=${encodeURIComponent(process.env.PAGESPEED_API_KEY)}` : '';
      const r = await fetch(`${process.env.PAGESPEED_URL || 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'}?url=${encodeURIComponent(url)}&strategy=mobile&category=performance${key}`, { signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      const score = Math.round((j.lighthouseResult?.categories?.performance?.score ?? NaN) * 100);
      if (!Number.isFinite(score)) throw new Error('no score');
      await store.update('sites', s.id, { pagespeed: { score, at: new Date().toISOString() } });
      res.redirect(303, `/sites/${s.id}/stats`);
    } catch { res.redirect(303, `/sites/${s.id}/stats?f=${encodeURIComponent('PageSpeed could not test the site right now. Try again later.')}`); }
  }));

  // ---------- 44 custom domains ----------
  app.get('/sites/:id/domain', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    const ip = domains.lbIp();
    const mine = (await store.where('domains', 'siteId', s.id)).filter((d) => d.status !== 'removed');
    const free = process.env.SUBDOMAINS_LIVE === 'yes' ? `<p>Free address: <a href="https://${esc(s.slug)}.${esc(config.domain)}/">${esc(s.slug)}.${esc(config.domain)}</a></p>` : `<p>Free address <b>${esc(s.slug)}.${esc(config.domain)}</b>: Coming soon.</p>`;
    res.send(page('Domain', `<h1>Web address for ${esc(s.details.businessName)}</h1><div class="card">${free}<p>Backup address (always on): <a href="/s/${esc(s.slug)}/">${esc(config.baseUrl.replace(/^https?:\/\//, ''))}/s/${esc(s.slug)}</a></p></div>
<div class="card"><h2 style="margin-top:0">Your own domain</h2>${!ip ? '<p><b>Coming soon.</b> Custom domains turn on once our load balancer is ready.</p>' : `
${mine.map((d) => `<p><b>${esc(d.host)}</b> - <span class="${d.status === 'verified' ? 'ok' : 'warn'}">${d.status === 'verified' ? 'Connected' : 'Waiting for DNS'}</span></p>${d.status !== 'verified' ? `<ol><li>Sign in where you bought <b>${esc(d.host)}</b> (GoDaddy, Namecheap, Google Domains, etc.).</li><li>Open <b>DNS settings</b>.</li><li>Add an <b>A record</b>: Host/Name <code>@</code>, Value <code>${esc(ip)}</code>. Delete other A records for @.</li><li>For www: add a <b>CNAME</b>: Host <code>www</code>, Value <code>${esc(d.host)}</code>.</li><li>Wait 10-60 minutes, then tap Check.</li></ol><form method="post" action="/sites/${s.id}/domain/${esc(d.id)}/verify"><button>Check now</button></form>` : ''}`).join('')}
${mine.length ? '' : `<form method="post" action="/sites/${s.id}/domain"><label for="h">Domain</label><input id="h" name="host" placeholder="mybusiness.com" required><button>Add domain</button></form>`}`}
<p class="mut small">HTTPS is free and renews automatically.</p></div><p><a href="/dashboard">Back</a></p>`, { user: req.user, flash: req.query.f || '' }));
  }));
  app.post('/sites/:id/domain', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    if (!domains.lbIp()) return res.redirect(303, `/sites/${s.id}/domain`);
    try { await domains.add(req.member, s, req.body.host); res.redirect(303, `/sites/${s.id}/domain`); } catch (e) { res.redirect(303, `/sites/${s.id}/domain?f=${encodeURIComponent(e.message)}`); }
  }));
  app.post('/sites/:id/domain/:did/verify', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    const d = await store.get('domains', req.params.did);
    if (!d || d.siteId !== s.id) return res.redirect(303, `/sites/${s.id}/domain`);
    const r = await domains.verify(d);
    res.redirect(303, `/sites/${s.id}/domain?f=${encodeURIComponent(r.msg)}`);
  }));

  // ---------- 47 backups: one-tap restore ----------
  app.get('/sites/:id/backups', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    const b = (await store.where('backups', 'siteId', s.id)).sort((x, y) => (x.day < y.day ? 1 : -1)).slice(0, 30);
    res.send(page('Backups', `<h1>Backups - ${esc(s.details.businessName)}</h1><p class="mut">A backup is made every day. Restoring puts your site back exactly as it was that day (you can undo it from History in the builder).</p>
<div class="card">${b.length ? `<table>${b.map((x) => `<tr><td>${esc(x.day)}</td><td>${x.published ? 'published' : 'draft'}</td><td><form method="post" action="/sites/${s.id}/backups/${esc(x.id)}/restore"><button class="sec">Restore</button></form></td></tr>`).join('')}</table>` : '<p class="mut">The first backup runs tonight.</p>'}</div><p><a href="/dashboard">Back</a></p>`, { user: req.user, flash: req.query.f || '' }));
  }));
  app.post('/sites/:id/backups/:bid/restore', ...M, wrap(async (req, res) => {
    const s = await ownedSite(req);
    const b = await store.get('backups', req.params.bid);
    if (!b || b.siteId !== s.id) return res.redirect(303, `/sites/${s.id}/backups`);
    await sites.saveDoc(req.member, s.id, b.doc, req.user.email, `Restored backup ${b.day}`);
    if (b.publishedDoc && s.published) await store.update('sites', s.id, { publishedDoc: docs.clean(b.publishedDoc) });
    await oracle(req.user.email, 'site.backup_restored', { site: s.id, day: b.day });
    res.redirect(303, `/sites/${s.id}/backups?f=${encodeURIComponent('Restored the ' + b.day + ' backup.')}`);
  }));

  // ---------- 62 Oracle profile ----------
  app.get('/profile', ...M, wrap(async (req, res) => {
    const m = req.member;
    const all = await store.where('sites', 'memberId', m.id);
    const log = (await store.all('oracle')).filter((l) => l.who === m.email || l.details?.member === m.id || l.details?.email === m.email).sort((a, b) => (a.when < b.when ? 1 : -1)).slice(0, 50);
    res.send(page('Profile', `<h1>Your profile</h1><div class="card"><p><b>${esc(m.email)}</b><br>Member since ${esc((m.createdAt || '').slice(0, 10))} · ${esc(m.status)}</p></div>
<div class="card"><h2 style="margin-top:0">All your sites</h2><ul>${all.map((s) => `<li><b>${esc(s.details.businessName)}</b> (${esc(s.slug)})${s.archived ? ' - removed (kept)' : ''}<br>${siteLinks(s)}</li>`).join('')}</ul></div>
<div class="card"><h2 style="margin-top:0">Activity</h2><div class="scroll"><table>${log.map((l) => `<tr><td>${esc(l.when.slice(0, 16).replace('T', ' '))}</td><td>${esc(l.what)}</td></tr>`).join('')}</table></div></div>`, { user: req.user }));
  }));

  // ---------- 89 data download / deletion request ----------
  app.get('/account/export', ...M, wrap(async (req, res) => {
    const m = { ...req.member };
    delete m.githubTokenBox;
    const s = await store.where('sites', 'memberId', m.id);
    const data = { exportedAt: new Date().toISOString(), member: m, sites: s.map(({ doc, publishedDoc, ...rest }) => ({ ...rest, doc, publishedDoc })), leads: await store.where('leads', 'memberId', m.id), aiUsage: await store.where('ai_usage', 'memberId', m.id) };
    await oracle(req.user.email, 'account.data_exported', {});
    res.setHeader('Content-Disposition', `attachment; filename="my-data-${day(Date.now())}.json"`);
    res.type('application/json').send(JSON.stringify(data, null, 2));
  }));
  app.post('/account/delete-request', ...M, wrap(async (req, res) => {
    if (req.body.confirm !== 'yes') return res.redirect(303, '/dashboard#data');
    const dup = (await store.where('approvals', 'memberId', req.member.id)).find((a) => a.type === 'delete' && a.status === 'pending');
    if (!dup) await store.add('approvals', { type: 'delete', status: 'pending', memberId: req.member.id, email: req.member.email, reason: 'Member asked to delete their account and sites', requestedAt: new Date().toISOString() });
    await oracle(req.user.email, 'account.delete_requested', {});
    res.send(page('Deletion requested', '<p>Your deletion request was sent for review. Nothing is deleted until it is approved, and you will get an email when it is done.</p><p><a href="/dashboard">Back</a></p>', { user: req.user }));
  }));

  // ---------- 68 help center + 79 support bot ----------
  app.get('/help', (req, res) => {
    res.send(page('Help', `<h1>Help center</h1><div class="card" id="ask"><h2 style="margin-top:0">Ask support</h2><p class="mut small">This is an AI support assistant. It can make mistakes. Tap "Talk to a person" anytime.</p>
<div id="hlog" aria-live="polite"></div><form id="hf"><label for="hq">Your question</label><input id="hq" name="q" maxlength="600" required><div class="row"><button>Ask</button><button class="sec" type="button" id="human">Talk to a person</button></div></form></div>
${GUIDES.map(([id, t, body]) => `<details class="card" id="${id}"><summary><b>${esc(t)}</b></summary><p>${esc(body)}</p></details>`).join('')}
<script>(()=>{const f=document.getElementById('hf'),o=document.getElementById('hlog');const add=(w,t)=>{const p=document.createElement('p');p.innerHTML='<b>'+w+':</b> ';p.append(t);o.append(p)};
f.onsubmit=async e=>{e.preventDefault();const q=f.q.value.trim();if(!q)return;add('You',q);f.q.value='';const r=await fetch('/help/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})}).then(r=>r.json()).catch(()=>({answer:'Something went wrong.'}));add('AI support',r.answer);if(r.handoff)add('Note','We sent your question to a person. You will get an email reply.')};
document.getElementById('human').onclick=async()=>{const q=f.q.value.trim()||[...o.querySelectorAll('p')].map(p=>p.textContent).join('\\n');if(!q){f.q.focus();return}const r=await fetch('/help/human',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})}).then(r=>r.json()).catch(()=>({}));add('Note',r.ok?'Sent to a person. You will get an email reply.':(r.error||'Please sign in first so we can reply to you.'))}})();</script>`, { user: req.user }));
  });
  app.post('/help/ask', json, wrap(async (req, res) => {
    if (!security.allow('help:' + security.ip(req), 8, 60e3)) return res.status(429).json({ answer: 'Too many questions. Please wait a minute.' });
    const q = String(req.body?.q || '').slice(0, 600);
    const m = req.member;
    const acct = m ? `Member status: ${m.status}${m.cancelAtPeriodEnd ? ' (cancelled, access until period end)' : ''}. Sites: ${(await memberSites(m)).length}.` : 'Not signed in.';
    const r = await ai.text({ memberId: m?.id, task: 'support', system: `You are ${config.brand}'s AI support assistant. Say you are an AI if asked. Answer ONLY from the help guides and plan facts below. If you can't answer, or the person wants a refund, deletion, billing change or a human, reply starting with "HANDOFF:" and a short note.`, prompt: `PLAN: ${config.disclosure}\nGUIDES:\n${GUIDES.map((g) => `${g[1]}: ${g[2]}`).join('\n')}\nACCOUNT: ${acct}\nQUESTION: ${q}` });
    if (!r.ok) {
      const g = GUIDES.find(([, t, b]) => q.toLowerCase().split(/\W+/).filter((w) => w.length > 3).some((w) => (t + ' ' + b).toLowerCase().includes(w)));
      return res.json({ answer: `AI support: Not connected.${g ? ` This guide may help: "${g[1]}": ${g[2]}` : ''} Tap "Talk to a person" for help.` });
    }
    if (/^HANDOFF:/i.test(r.text)) { await ticket(req, q, r.text); return res.json({ answer: r.text.replace(/^HANDOFF:\s*/i, ''), handoff: true }); }
    res.json({ answer: r.text });
  }));
  async function ticket(req, q, note = '') {
    const email = req.user?.email;
    if (!email) return false;
    const id = await store.add('support', { email, q: q.slice(0, 3000), note: note.slice(0, 500), at: new Date().toISOString(), status: 'open' });
    await sendEmail({ to: config.ownerEmail, kind: 'support_handoff', subject: `Support request from ${email}`, html: `<p><b>${esc(email)}</b> asked:</p><p>${esc(q).replace(/\n/g, '<br>')}</p>${note ? `<p class="mut">AI note: ${esc(note)}</p>` : ''}<p>Reply directly to them by email.</p>` });
    await oracle(email, 'support.handoff', { ticket: id });
    return true;
  }
  app.post('/help/human', json, wrap(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in first so we can reply to you, or email ' + config.ownerEmail });
    res.json({ ok: await ticket(req, String(req.body?.q || '')) });
  }));
}

module.exports = { mount, dashboardExtras, siteLinks, GUIDES };
