// Bots (items 70-80, 97). Each run is recorded in "botruns" and the Oracle.
// Cloud Scheduler calls POST /cron/bot/:name with the CRON_SECRET header.
const crypto = require('crypto');
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const { sendEmail, esc } = require('./email');
const billing = require('./billing');
const docs = require('./doc');
const templates = require('./templates');
const ai = require('./ai');

// name -> minutes between runs (for the supervisor). Mirrors deploy script 2.
const SCHEDULE = { uptime: 5, backup: 1440, security: 60, payments: 1440, meta: 1440, links: 10080, indexer: 60, cost: 1440, owner_digest: 1440, newsletter: 10080, daily: 1440, supervisor: 15 };
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const owner = (subject, html, kind = 'owner_alert') => sendEmail({ to: config.ownerEmail, kind, subject, html });

async function liveSites() {
  const out = [];
  for (const s of await store.all('sites')) {
    if (s.archived || !s.published || !s.publishedDoc || s.ownerPaused) continue;
    const m = await store.get('members', s.memberId);
    if (billing.hostingAllowed(m)) out.push({ site: s, member: m });
  }
  return out;
}
const siteUrl = (s) => require('./publicSite').canonicalFor(s, null);

async function indexNowKey() {
  const cs = config.secret('CRON_SECRET');
  return cs ? crypto.createHash('sha256').update('indexnow:' + cs).digest('hex').slice(0, 32) : null;
}

// ---------- 71 Uptime ----------
async function uptime() {
  let up = 0, down = 0;
  const today = day();
  const agg = (await store.get('uptime_days', today)) || { day: today, checks: 0, ok: 0, platformChecks: 0, platformOk: 0 };
  let platformOk = false;
  try { platformOk = (await fetch(config.baseUrl + '/healthz', { signal: AbortSignal.timeout(10000) })).ok; } catch {}
  agg.platformChecks++; if (platformOk) agg.platformOk++;
  for (const { site } of await liveSites()) {
    let ok = false, code = 0;
    try { const r = await fetch(siteUrl(site), { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'ios-uptime-bot' } }); code = r.status; ok = r.ok; } catch { code = 0; }
    const prev = (await store.get('uptime', site.id)) || { siteId: site.id, fails: 0 };
    const cur = { siteId: site.id, slug: site.slug, up: ok, code, lastCheck: new Date().toISOString(), fails: ok ? 0 : (prev.fails || 0) + 1, downSince: ok ? null : prev.downSince || new Date().toISOString(), alerted: ok ? false : prev.alerted };
    if (!ok && cur.fails >= 2 && !cur.alerted) {
      await owner(`Site down: ${site.slug}`, `<p><b>${esc(site.slug)}</b> is not loading (${code || 'no answer'}) since ${esc(cur.downSince)}.</p><p>${esc(siteUrl(site))}</p>`);
      await oracle('bot:uptime', 'site.down', { site: site.id, code });
      cur.alerted = true;
    }
    if (ok && prev.alerted) { await owner(`Site back up: ${site.slug}`, `<p>${esc(site.slug)} is loading again.</p>`); await oracle('bot:uptime', 'site.up', { site: site.id }); }
    await store.set('uptime', site.id, cur);
    agg.checks++; if (ok) { agg.ok++; up++; } else down++;
  }
  await store.set('uptime_days', today, agg);
  return { platformOk, up, down };
}

// ---------- 72 Backups (daily) + weekly test-restore ----------
async function backup(now = Date.now()) {
  let saved = 0;
  const d = day(now);
  for (const s of await store.all('sites')) {
    if (s.archived || !s.doc) continue;
    await store.set('backups', `${s.id}_${d}`, { siteId: s.id, memberId: s.memberId, day: d, doc: s.doc, publishedDoc: s.publishedDoc || null, published: !!s.published, at: new Date(now).toISOString() });
    saved++;
  }
  let restoreTest = null;
  const last = (await store.all('botruns')).filter((r) => r.bot === 'backup' && r.summary?.restoreTest).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  if (!last || now - new Date(last.startedAt).getTime() > 6.5 * 864e5) {
    const all = (await store.all('backups')).filter((b) => b.day === d);
    if (all.length) {
      const b = all[crypto.randomInt(all.length)];
      try {
        const doc = docs.clean(b.doc);
        const t = await templates.getTemplate(doc.template);
        const html = require('./render').renderPage({ details: {} }, doc, doc.pages[0], { base: '/', template: t, preview: true });
        restoreTest = { ok: html.includes('</html>') && doc.pages.length === b.doc.pages.length, site: b.siteId };
      } catch (e) { restoreTest = { ok: false, site: b.siteId, error: e.message }; }
      if (!restoreTest.ok) await owner('Backup test-restore FAILED', `<p>Site ${esc(b.siteId)}: ${esc(restoreTest.error || 'mismatch')}</p>`);
    }
  }
  return { saved, restoreTest };
}

// ---------- 73 Security report ----------
async function security() {
  const s = require('./security').stats;
  const spam = (await store.all('leads')).filter((l) => l.spam && l.at > new Date(Date.now() - 36e5).toISOString()).length;
  return { blockedRequests: s.blocked, since: s.since, spamFormsLastHour: spam };
}

// ---------- 74 Payment check ----------
async function payments() {
  if (!billing.connected()) return { skipped: 'Payments: Not connected' };
  const st = billing.stripe();
  const p = await billing.prices();
  const subs = [];
  for await (const sub of st.subscriptions.list({ status: 'all', limit: 100, price: p.plan.id })) subs.push(sub);
  const members = await store.all('members');
  const flags = [];
  const byId = new Map(subs.map((x) => [x.id, x]));
  for (const m of members) {
    if (!m.subscriptionId) continue;
    const sub = byId.get(m.subscriptionId);
    if (!sub) { if (m.status === 'active') flags.push(`${m.email}: active here but subscription not found in Stripe`); continue; }
    const want = ['trialing', 'active'].includes(sub.status) ? 'active' : sub.status === 'past_due' ? 'past_due' : ['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status) ? 'ended' : 'incomplete';
    if (want !== m.status) flags.push(`${m.email}: here "${m.status}", Stripe "${sub.status}"`);
  }
  for (const sub of subs) {
    if (['trialing', 'active', 'past_due'].includes(sub.status) && !members.some((m) => m.subscriptionId === sub.id)) flags.push(`Stripe subscription ${sub.id} (${sub.status}) has no member here`);
  }
  if (flags.length) {
    await store.add('flags', { kind: 'payments', items: flags, at: new Date().toISOString(), status: 'open' });
    await owner(`Payment check: ${flags.length} mismatch${flags.length > 1 ? 'es' : ''}`, `<ul>${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><p>Nothing was changed. Review in the owner console.</p>`);
  }
  return { subscriptions: subs.length, members: members.length, mismatches: flags.length };
}

// ---------- 75 Meta tags: 7 per page, fix small issues ----------
const SEVEN = [['title', /<title>[^<]{3,}<\/title>/], ['description', /<meta name="description" content="[^"]{10,}"/], ['keywords', /<meta name="keywords" content="[^"]+"/], ['robots', /<meta name="robots" content="[^"]+"/], ['canonical', /<link rel="canonical" href="[^"]+"/], ['viewport', /<meta name="viewport" content="[^"]+"/], ['social', /<meta property="og:title" content="[^"]+"/]];
async function meta() {
  let pages = 0, fixed = 0, missing = 0;
  for (const { site } of await liveSites()) {
    const doc = structuredClone(site.publishedDoc);
    const t = await templates.getTemplate(doc.template);
    let changed = false;
    for (const p of doc.pages) {
      const m = p.meta || (p.meta = {});
      const text = docs.docText(doc, [p]).split('\n').filter((l) => !l.startsWith('#')).join(' ').trim();
      if (m.title && m.title.length > 70) { m.title = m.title.slice(0, 67) + '...'; changed = true; }
      if ((!m.description || m.description.length < 10) && text.length >= 10) { m.description = text.slice(0, 160); changed = true; }
      if (m.description && m.description.length > 170) { m.description = m.description.slice(0, 167) + '...'; changed = true; }
      const html = require('./render').renderPage(site, doc, p, { base: '/', template: t, canonicalBase: siteUrl(site) });
      pages++;
      for (const [, re] of SEVEN) if (!re.test(html)) missing++;
    }
    if (changed) {
      fixed++;
      const clean = docs.clean(doc);
      await store.update('sites', site.id, { publishedDoc: clean, doc: mergeMeta(site.doc, clean) });
      await oracle('bot:meta', 'meta.fixed', { site: site.id });
    }
  }
  return { pages, sitesFixed: fixed, missingTags: missing };
}
function mergeMeta(draft, pub) {
  const d = structuredClone(draft);
  for (const p of d.pages) { const q = pub.pages.find((x) => x.id === p.id); if (q) p.meta = { ...q.meta, ...Object.fromEntries(Object.entries(p.meta || {}).filter(([, v]) => v)) }; }
  return d;
}

// ---------- 76 Broken links (weekly) ----------
async function links() {
  let checked = 0, fixed = 0, broken = 0;
  for (const { site, member } of await liveSites()) {
    const doc = structuredClone(site.publishedDoc);
    const slugs = new Set(doc.pages.map((p) => p.slug));
    const bad = [];
    let changed = false;
    for (const p of doc.pages) for (const s of p.sections) {
      const b = s.data.button;
      if (!b?.href) continue;
      checked++;
      if (/^https:\/\//.test(b.href)) {
        let ok = false;
        try { const r = await fetch(b.href, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) }); ok = r.status < 400 || r.status === 405; } catch {}
        if (!ok) { bad.push(b.href); broken++; }
      } else if (!/^(mailto:|tel:|#)/.test(b.href) && !slugs.has(b.href.replace(/^\//, ''))) {
        b.href = slugs.has('contact') ? 'contact' : ''; changed = true; fixed++;
      }
    }
    if (changed) {
      const clean = docs.clean(doc);
      await store.update('sites', site.id, { publishedDoc: clean });
      await oracle('bot:links', 'links.fixed', { site: site.id });
    }
    if (bad.length && member) await sendEmail({ to: member.email, kind: 'broken_links', subject: `Broken links on ${site.details?.businessName || site.slug}`, html: `<p>These links on your site don't work:</p><ul>${bad.map((u) => `<li>${esc(u)}</li>`).join('')}</ul><p>Fix them in the <a href="${config.baseUrl}/sites/${site.id}/builder">builder</a>.</p>` });
  }
  return { checked, fixedInternal: fixed, brokenExternal: broken };
}

// ---------- 77 Indexer (IndexNow) ----------
async function indexer() {
  const key = await indexNowKey();
  const queue = (await store.all('index_queue')).filter((q) => !q.done);
  if (!queue.length) return { submitted: 0 };
  if (!key) return { skipped: 'CRON_SECRET not connected', waiting: queue.length };
  const byHost = new Map();
  for (const q of queue) {
    const s = await store.get('sites', q.siteId);
    if (!s?.publishedDoc) { await store.update('index_queue', q.id, { done: true, skipped: 'unpublished' }); continue; }
    const base = siteUrl(s);
    const host = new URL(base).host;
    if (!byHost.has(host)) byHost.set(host, { base: new URL(base).origin, urls: [], ids: [] });
    const h = byHost.get(host);
    h.urls.push(...s.publishedDoc.pages.map((p) => base + p.slug));
    h.ids.push(q.id);
  }
  let submitted = 0;
  const endpoint = process.env.INDEXNOW_URL || 'https://api.indexnow.org/indexnow';
  for (const [host, h] of byHost) {
    if (/^(localhost|127\.)/.test(host)) { for (const id of h.ids) await store.update('index_queue', id, { done: true, skipped: 'local' }); continue; }
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation: `${h.base}/${key}.txt`, urlList: h.urls.slice(0, 10000) }), signal: AbortSignal.timeout(15000) });
      if (r.ok || r.status === 202) { submitted += h.urls.length; for (const id of h.ids) await store.update('index_queue', id, { done: true, at2: new Date().toISOString() }); }
    } catch {}
  }
  return { submitted };
}

// ---------- 78 Cost watchdog ----------
async function cost() {
  const spend = await ai.monthSpend();
  const budget = Number(process.env.AI_BUDGET_USD || 50);
  const pct = budget ? Math.round((spend.usd / budget) * 100) : 0;
  const month = new Date().toISOString().slice(0, 7);
  const st = (await store.get('cost_state', month)) || { month, warned: 0 };
  for (const level of [80, 100]) {
    if (pct >= level && st.warned < level) {
      await owner(`AI spend at ${pct}% of budget`, `<p>AI this month: <b>$${spend.usd.toFixed(2)}</b> of $${budget.toFixed(2)} (${spend.calls} calls).</p><p>Members' monthly AI allowance caps each account. Google Cloud's own budget alerts (set by deploy script 3) cover hosting spend.</p>`);
      st.warned = level;
    }
  }
  await store.set('cost_state', month, st);
  return { aiUsd: spend.usd, budgetUsd: budget, pct, cloudSpend: 'Google Cloud budget alerts email you directly (script 3)' };
}

// ---------- 97 Daily owner email ----------
async function owner_digest(now = Date.now()) {
  const since = new Date(now - 864e5).toISOString();
  const log = (await store.all('oracle')).filter((l) => l.when >= since);
  const n = (w) => log.filter((l) => l.what === w);
  const joined = n('member.joined'), cancels = n('member.cancel.requested'), failed = n('payment.failed');
  const down = (await store.all('uptime')).filter((u) => !u.up);
  const holds = (await store.all('approvals')).filter((a) => a.status === 'pending');
  const flags = (await store.all('flags')).filter((f) => f.status === 'open');
  const html = `<h2>Daily report</h2><ul><li>New members: <b>${joined.length}</b>${joined.length ? ' (' + joined.map((j) => esc(j.details.email)).join(', ') + ')' : ''}</li>
<li>Cancellations: <b>${cancels.length}</b></li><li>Failed payments: <b>${failed.length}</b></li><li>Sites down now: <b>${down.length}</b>${down.length ? ' (' + down.map((d) => esc(d.slug)).join(', ') + ')' : ''}</li>
<li>Waiting for your approval: <b>${holds.length}</b></li><li>Open flags: <b>${flags.length}</b></li></ul><p><a href="${config.baseUrl}/owner">Open the Admin Command Center</a></p>`;
  await owner(`Daily report: ${joined.length} new, ${cancels.length} cancelled, ${failed.length} failed payments`, html, 'owner_digest');
  return { newMembers: joined.length, cancellations: cancels.length, failedPayments: failed.length, sitesDown: down.length };
}

// ---------- 70 Weekly member newsletter ----------
function unsubToken(email) { return require('./auth').sign({ email, u: 1 }, 'unsub'); }
async function newsletter() {
  const features = require('./features');
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const news = (await store.all('news')).filter((n) => n.at >= weekAgo);
  const whatsNew = news.filter((n) => n.kind !== 'ai');
  const aiNews = news.filter((n) => n.kind === 'ai');
  const coming = features.filter((f) => !require('./features').isLive(f));
  if (!whatsNew.length && !aiNews.length) return { skipped: 'nothing new this week' };
  const members = (await store.all('members')).filter((m) => m.status !== 'ended' && !m.marketingOptOut);
  let sent = 0, blocked = 0;
  for (const m of members) {
    let unsub;
    try { unsub = `${config.baseUrl}/unsubscribe?t=${encodeURIComponent(unsubToken(m.email))}`; } catch { blocked++; continue; }
    const r = await sendEmail({
      to: m.email, kind: 'newsletter', marketing: true, unsubscribeUrl: unsub, subject: `This week at ${config.brand}`,
      html: `<h2>What's new</h2>${whatsNew.length ? `<ul>${whatsNew.map((n) => `<li><b>${esc(n.title)}</b> ${esc(n.body)}</li>`).join('')}</ul>` : '<p>No new features this week.</p>'}
${coming.length ? `<h2>What's coming</h2><ul>${coming.map((f) => `<li>${esc(f.label)}</li>`).join('')}</ul>` : ''}
${aiNews.length ? `<h2>AI news</h2><ul>${aiNews.map((n) => `<li><b>${esc(n.title)}</b> ${esc(n.body)}${n.link ? ` <a href="${esc(n.link)}">Source</a>` : ''}</li>`).join('')}</ul>` : ''}`,
    });
    if (r.status === 'sent') sent++; else if (r.status.startsWith('blocked')) blocked++;
  }
  return { members: members.length, sent, blocked };
}

// ---------- 80 Supervisor (no zombie bots; backup twin takes over) ----------
async function supervisor(now = Date.now()) {
  const runs = await store.all('botruns');
  const late = [];
  for (const [bot, mins] of Object.entries(SCHEDULE)) {
    if (bot === 'supervisor') continue;
    const last = runs.filter((r) => r.bot === bot && r.finishedAt).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
    const stuck = runs.find((r) => r.bot === bot && !r.finishedAt && now - new Date(r.startedAt).getTime() > 30 * 60e3 && !r.abandoned);
    if (stuck) await store.update('botruns', stuck.id, { abandoned: true, abandonedAt: new Date(now).toISOString() });
    const first = (await store.get('bot_registry', bot))?.firstSeen;
    const ref = last ? new Date(last.startedAt).getTime() : first ? new Date(first).getTime() : now;
    if (!first) await store.set('bot_registry', bot, { bot, firstSeen: new Date(now).toISOString() });
    if (now - ref > mins * 1.5 * 60e3 + 5 * 60e3 || stuck || (last && !last.ok)) late.push(bot);
  }
  for (const bot of late) {
    await oracle('bot:supervisor', 'bot.twin_takeover', { bot });
    await run(bot, 'twin');
  }
  if (late.length) await owner(`Supervisor: ${late.length} bot${late.length > 1 ? 's' : ''} late - backup twin ran them`, `<p>${late.map(esc).join(', ')}</p>`);
  return { checked: Object.keys(SCHEDULE).length - 1, tookOver: late };
}

const BOTS = { uptime, backup, security, payments, meta, links, indexer, cost, owner_digest, newsletter, supervisor, daily: () => require('./jobs').daily() };

async function run(name, by = 'scheduler') {
  const fn = BOTS[name];
  if (!fn) throw Object.assign(new Error('unknown bot'), { status: 404 });
  const startedAt = new Date().toISOString();
  const id = await store.add('botruns', { bot: name, by, startedAt, finishedAt: null, ok: null });
  let summary, ok = true;
  try { summary = await fn(); } catch (e) { ok = false; summary = { error: e.message }; }
  await store.update('botruns', id, { finishedAt: new Date().toISOString(), ok, summary });
  await oracle('bot:' + name, 'bot.ran', { ok, by, ...(summary && typeof summary === 'object' ? summary : {}) });
  return { bot: name, ok, summary };
}

module.exports = { run, BOTS, SCHEDULE, indexNowKey, unsubToken, liveSites };
