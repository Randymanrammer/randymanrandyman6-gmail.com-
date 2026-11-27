// Member sites: create (with plan limits), archive, publish, render.
// Pages are built ONLY from the business details the member typed in.
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const billing = require('./billing');
const { esc } = require('./email');

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'owner', 'mail', 'status', 'help', 'login', 'billing', 'dashboard', 's', 'static', 'cdn']);

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function cleanDetails(b) {
  const t = (v, n = 300) => String(v || '').trim().slice(0, n);
  return {
    businessName: t(b.businessName, 80),
    tagline: t(b.tagline, 140),
    description: t(b.description, 2000),
    services: t(b.services, 2000).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30),
    phone: t(b.phone, 40),
    email: t(b.email, 120),
    address: t(b.address, 200),
    hours: t(b.hours, 400),
  };
}

// Returns {needsConfirm, message} when a 4th+ site needs the $25 confirm tap.
async function createSite(member, body, actor) {
  if (!billing.hostingAllowed(member) || member.status !== 'active') {
    throw Object.assign(new Error('Your membership is not active. Rejoin to build sites.'), { status: 402 });
  }
  const details = cleanDetails(body);
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
  // Reserve the address atomically so two people can't grab the same one at once.
  if (!(await store.claim('slugs', slug, { memberId: member.id, at: now }))) throw Object.assign(new Error(`"${slug}" is taken. Try another site name.`), { status: 409 });
  const id = await store.add('sites', {
    memberId: member.id, slug, details, published: false, archived: false, ownerPaused: false,
    createdAt: now, updatedAt: now, extraAtCreation: willBeExtra,
  });
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

function renderSite(site) {
  const d = site.details;
  const nl = (s) => esc(s).replace(/\n/g, '<br>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.businessName)}</title>${d.tagline ? `<meta name="description" content="${esc(d.tagline)}">` : ''}
<style>
:root{--bg:#fff;--fg:#14171f;--mut:#5b6170;--acc:#0b6bcb;--card:#f4f6fa}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#eef0f4;--mut:#a3a9b6;--acc:#5aa9ff;--card:#191c23}}
*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header,section,footer{padding:28px 16px;max-width:900px;margin:auto}h1{font-size:clamp(28px,6vw,44px);line-height:1.15;margin:.2em 0}
.tag{color:var(--mut);font-size:1.15em}.card{background:var(--card);border-radius:12px;padding:18px}ul{padding-left:1.2em}
a{color:var(--acc)}.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}footer{color:var(--mut);font-size:14px}
</style></head><body>
<header><h1>${esc(d.businessName)}</h1>${d.tagline ? `<p class="tag">${esc(d.tagline)}</p>` : ''}</header>
${d.description ? `<section><h2>About</h2><p>${nl(d.description)}</p></section>` : ''}
${d.services.length ? `<section><h2>Services</h2><ul>${d.services.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
${d.phone || d.email || d.address || d.hours ? `<section><h2>Contact</h2><div class="grid">
${d.phone ? `<div class="card"><b>Phone</b><br><a href="tel:${esc(d.phone.replace(/[^0-9+]/g, ''))}">${esc(d.phone)}</a></div>` : ''}
${d.email ? `<div class="card"><b>Email</b><br><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></div>` : ''}
${d.address ? `<div class="card"><b>Address</b><br>${nl(d.address)}</div>` : ''}
${d.hours ? `<div class="card"><b>Hours</b><br>${nl(d.hours)}</div>` : ''}
</div></section>` : ''}
<footer>&copy; ${new Date().getUTCFullYear()} ${esc(d.businessName)}</footer>
</body></html>`;
}

function offlinePage(reason) {
  const msg = reason === 'draft' ? 'This site is not published yet.' : reason === 'missing' ? 'There is no site at this address.' : 'This site is offline right now.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Site unavailable</title>
<style>body{font:17px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center;background:#fff;color:#222}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body><div><h1>${msg}</h1><p>Hosted by ${esc(config.brand)}</p></div></body></html>`;
}

module.exports = { createSite, removeSite, setPublished, siteBySlug, liveState, renderSite, offlinePage, getOwnedSite, slugify };
