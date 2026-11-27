// Member sites: create (with plan limits), archive, publish, render.
// Pages are built ONLY from the business details the member typed in.
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const billing = require('./billing');
const { esc } = require('./email');
const docs = require('./doc');
const templates = require('./templates');
const render = require('./render');

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'owner', 'mail', 'status', 'help', 'login', 'billing', 'dashboard', 's', 'static', 'cdn']);

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Returns {needsConfirm, message} when a 4th+ site needs the $25 confirm tap.
async function createSite(member, body, actor) {
  if (!billing.hostingAllowed(member) || member.status !== 'active') {
    throw Object.assign(new Error('Your membership is not active. Rejoin to build sites.'), { status: 402 });
  }
  const details = docs.parseDetails(body);
  if (!details.businessName) throw Object.assign(new Error('Business name is required.'), { status: 400 });
  const slug = slugify(body.siteName || details.businessName);
  if (!slug || slug.length < 3 || RESERVED.has(slug)) throw Object.assign(new Error('Pick a different site name (3+ letters, not reserved).'), { status: 400 });
  if ((await store.where('sites', 'slug', slug)).length) throw Object.assign(new Error(`"${slug}" is taken. Try another site name.`), { status: 409 });

  const count = (await billing.activeSites(member)).length;
  const willBeExtra = count >= config.plan.includedSites;
  if (willBeExtra && body.confirmExtra !== 'yes') {
    const startsNote = member.subscriptionStatus === 'trialing' && member.trialEnd
      ? `Billing for it starts with your first monthly bill on ${billing.fmtDate(member.trialEnd)}.`
      : 'You will be charged the prorated amount today, then $25/month on your regular bill.';
    return { needsConfirm: true, message: `$25/month for this site. ${startsNote}`, slug };
  }
  const now = new Date().toISOString();
  const template = await templates.getTemplate(String(body.template || 'advisory'));
  const doc = docs.buildDoc(details, template);
  const id = await store.add('sites', {
    memberId: member.id, slug, details, published: false, archived: false, ownerPaused: false,
    createdAt: now, updatedAt: now, extraAtCreation: willBeExtra, templateChosen: !!body.template, doc, publishedDoc: null, assistant: false,
  });
  await addVersion(id, doc, 'Site created');
  await oracle(actor, 'site.created', { member: member.id, site: id, slug, extra: willBeExtra });
  if (willBeExtra) {
    try {
      await billing.setExtraSites(member, (await billing.extraSitesNeeded(member)), actor);
    } catch (e) {
      await store.update('sites', id, { archived: true, archivedAt: new Date().toISOString(), archivedReason: 'extra-site billing failed' });
      await oracle('system', 'site.archived', { site: id, reason: 'extra-site billing failed' });
      throw Object.assign(new Error('Could not add the $25 site to your plan. Check your card on the Billing page.'), { status: 402 });
    }
  }
  return { site: await store.get('sites', id) };
}

async function getOwnedSite(member, id) {
  const s = await store.get('sites', id);
  if (!s || s.memberId !== member.id) throw Object.assign(new Error('Site not found'), { status: 404 });
  return s;
}

// Remove = take off the plan. Kept (archived), never deleted.
async function removeSite(member, id, actor) {
  const s = await getOwnedSite(member, id);
  if (s.archived) return s;
  await store.update('sites', id, { archived: true, published: false, archivedAt: new Date().toISOString(), archivedReason: 'removed by member' });
  await oracle(actor, 'site.removed', { member: member.id, site: id, slug: s.slug });
  if (member.subscriptionId && member.status !== 'ended') {
    const need = await billing.extraSitesNeeded(member);
    if (need !== (member.extraSitesBilled || 0)) await billing.setExtraSites(member, need, actor);
  }
  return s;
}

async function setPublished(member, id, published, actor) {
  if (published) return publish(member, id, actor);
  const s = await getOwnedSite(member, id);
  if (s.archived) throw Object.assign(new Error('That site was removed.'), { status: 400 });
  await store.update('sites', id, { published: !!published, updatedAt: new Date().toISOString(), publishedAt: published ? new Date().toISOString() : s.publishedAt || null });
  await oracle(actor, published ? 'site.published' : 'site.unpublished', { member: member.id, site: id, slug: s.slug });
}

async function siteBySlug(slug) {
  const r = await store.where('sites', 'slug', slug);
  return r[0] || null;
}

// Is the site live right now? Membership ended / grace over -> offline, but kept.
async function liveState(site) {
  if (!site || site.archived) return { live: false, reason: 'missing' };
  if (site.ownerPaused) return { live: false, reason: 'paused' };
  const m = await store.get('members', site.memberId);
  if (!billing.hostingAllowed(m)) return { live: false, reason: 'offline' };
  if (!site.published) return { live: false, reason: 'draft' };
  return { live: true };
}

// Legacy sites (made before the builder) get a doc from their details.
async function ensureDoc(site) {
  if (site.doc) return site.doc;
  const d = { menu: [], faqs: [], takesBookings: false, ...site.details };
  const doc = docs.buildDoc(d, await templates.getTemplate('advisory'));
  await store.update('sites', site.id, { doc, publishedDoc: site.published ? doc : null });
  site.doc = doc; if (site.published) site.publishedDoc = doc;
  return doc;
}

// ---------- Versions (item 24) ----------
const MAX_VERSIONS = 60;
async function addVersion(siteId, doc, note) {
  await store.add('versions', { siteId, doc, note: String(note || '').slice(0, 120), at: new Date().toISOString() });
}
// All versions are kept (nothing is deleted); the builder shows the newest 60.
async function versions(siteId) {
  return (await store.where('versions', 'siteId', siteId)).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_VERSIONS);
}
async function saveDoc(member, id, rawDoc, actor, note = 'Edit') {
  const s = await getOwnedSite(member, id);
  if (s.archived) throw Object.assign(new Error('That site was removed.'), { status: 400 });
  const doc = docs.clean(rawDoc);
  await store.update('sites', id, { doc, updatedAt: new Date().toISOString() });
  await addVersion(id, doc, note);
  await oracle(actor, 'site.edited', { member: member.id, site: id, note });
  return doc;
}
async function restoreVersion(member, id, versionId, actor) {
  const v = await store.get('versions', versionId);
  if (!v || v.siteId !== id) throw Object.assign(new Error('Version not found'), { status: 404 });
  return saveDoc(member, id, v.doc, actor, 'Restored version from ' + v.at.slice(0, 16).replace('T', ' '));
}

// ---------- Publish (items 29, 30, 81) ----------
function floorPlan(doc) {
  return { template: doc.template, theme: { headingFont: doc.theme.headingFont, bodyFont: doc.theme.bodyFont, mode: doc.theme.mode, hasLogo: !!doc.theme.logo },
    pages: doc.pages.map((p) => ({ title: p.title, slug: p.slug, sections: p.sections.map((x) => x.type) })) };
}
async function publish(member, id, actor) {
  const s = await getOwnedSite(member, id);
  if (s.archived) throw Object.assign(new Error('That site was removed.'), { status: 400 });
  const doc = await ensureDoc(s);
  const template = await templates.getTemplate(doc.template);
  const gov = await require('./governor').decide(s, doc, actor, { template });
  if (gov.status === 'block') return { published: false, governor: gov };
  if (gov.status === 'hold') {
    await store.update('sites', id, { governorHold: { at: new Date().toISOString(), issues: gov.issues } });
    const dup = (await store.where('approvals', 'siteId', id)).find((a) => a.type === 'governor' && a.status === 'pending');
    if (!dup) await store.add('approvals', { type: 'governor', status: 'pending', siteId: id, memberId: member.id, email: member.email, reason: gov.issues.filter((i) => i.level === 'hold').map((i) => i.msg).join(' | '), requestedAt: new Date().toISOString() });
    return { published: false, held: true, governor: gov };
  }
  const now = new Date().toISOString();
  await store.update('sites', id, { publishedDoc: doc, published: true, publishedAt: now, updatedAt: now, governorHold: null });
  await oracle(actor, 'site.published', { member: member.id, site: id, slug: s.slug });
  await store.add('floorplans', { siteId: id, memberId: member.id, plan: floorPlan(doc), at: now });
  await store.add('index_queue', { siteId: id, at: now, done: false });
  try { await require('./github').recordBuild({ ...s, publishedDoc: doc }, doc); } catch (e) { await oracle('system', 'buildrecord.failed', { site: id, error: e.message }); }
  return { published: true, governor: gov };
}
// Owner approves a held site (Governor review).
async function forcePublish(siteId, ownerEmail) {
  const s = await store.get('sites', siteId);
  const now = new Date().toISOString();
  await store.update('sites', siteId, { publishedDoc: s.doc, published: true, publishedAt: now, governorHold: null });
  await store.add('governor', { siteId, status: 'owner-approved', issues: [], at: now, actor: ownerEmail });
  await oracle(ownerEmail, 'governor.owner_approved', { site: siteId });
}

function renderSite(site, { pageSlug = '', lang = 'en', base, canonicalBase, edit = false, preview = false, template } = {}) {
  const doc = edit || preview ? site.doc : site.publishedDoc;
  if (!doc) return null;
  const pages = lang === 'es' && doc.translations?.es ? doc.translations.es.pages : doc.pages;
  const p = pages.find((x) => x.slug === pageSlug);
  if (!p) return null;
  return render.renderPage(site, doc, doc.pages.find((x) => x.id === p.id) || p, { edit, preview, base, canonicalBase, lang, template, assistant: !!site.assistant });
}

function offlinePage(reason) {
  const msg = reason === 'draft' ? 'This site is not published yet.' : reason === 'missing' ? 'There is no site at this address.' : 'This site is offline right now.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Site unavailable</title>
<style>body{font:17px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center;background:#fff;color:#222}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body><div><h1>${msg}</h1><p>Hosted by ${esc(config.brand)}</p></div></body></html>`;
}

module.exports = { createSite, removeSite, setPublished, siteBySlug, liveState, renderSite, offlinePage, getOwnedSite, slugify, ensureDoc, saveDoc, versions, restoreVersion, addVersion, publish, forcePublish, floorPlan, RESERVED };
