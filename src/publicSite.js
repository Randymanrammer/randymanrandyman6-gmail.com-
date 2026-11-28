// Serving member sites (items 27, 41-43, 44, 46, 49, 50, 51, 55, 64).
// Same handler for [site].DOMAIN, verified custom domains and DOMAIN/s/[site].
const express = require('express');
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const { sendEmail, esc } = require('./email');
const sites = require('./sites');
const templates = require('./templates');
const security = require('./security');
const docs = require('./doc');
const ai = require('./ai');

const BOT_UA = /bot|crawl|spider|slurp|preview|monitor|uptime|lighthouse|headless/i;
const subdomainsLive = () => process.env.SUBDOMAINS_LIVE === 'yes';

function canonicalFor(site, host) {
  if (host) return `https://${host}/`;
  return subdomainsLive() ? `https://${site.slug}.${config.domain}/` : `${config.baseUrl}/s/${site.slug}/`;
}

async function countVisit(site, slug, req) {
  if (BOT_UA.test(req.headers['user-agent'] || '') || req.query.preview) return;
  const day = new Date().toISOString().slice(0, 10);
  const id = `${site.id}_${day}`;
  const cur = (await store.get('stats', id)) || { siteId: site.id, memberId: site.memberId, day, visits: 0, pages: {} };
  cur.visits++;
  const k = slug || 'home';
  cur.pages[k] = (cur.pages[k] || 0) + 1;
  await store.set('stats', id, cur);
}

const urlencoded = express.urlencoded({ extended: false, limit: '50kb' });

// rest: path inside the site, without leading slash. host: custom/subdomain host or null.
async function handle(site, rest, req, res, { base, host }) {
  const st = await sites.liveState(site);
  if (!st.live) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(st.reason === 'missing' ? 404 : 503).send(sites.offlinePage(st.reason));
  }
  const doc = site.publishedDoc;
  const template = await templates.getTemplate(doc.template);
  const canonicalBase = canonicalFor(site, host);
  const opts = { base, canonicalBase, template };
  const path = rest.replace(/\/+$/, '');

  if (req.method === 'POST' && path === 'f') return urlencoded(req, res, () => lead(site, req, res, base).catch((e) => res.status(500).send('Error')));
  if (req.method === 'POST' && path === 'assistant') return urlencoded(req, res, () => assistant(site, doc, req, res).catch(() => res.json({ answer: 'Sorry, I could not answer right now.' })));
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed');

  // Item 50: 301 redirects set by the member.
  const r = doc.settings.redirects.find((x) => x.from.replace(/\/+$/, '') === '/' + path);
  if (r) return res.redirect(301, /^https:/.test(r.to) ? r.to : base + r.to.replace(/^\//, ''));

  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600'); // item 46: CDN-cacheable
  if (path === 'robots.txt') {
    return res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${canonicalBase}sitemap.xml\n`);
  }
  if (path === 'sitemap.xml') {
    const last = (site.publishedAt || site.updatedAt || '').slice(0, 10);
    const urls = doc.pages.filter((p) => (p.meta?.robots || 'index').startsWith('index')).map((p) => p.slug);
    const es = doc.translations?.es ? urls.map((u) => 'es/' + u) : [];
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...urls, ...es].map((u) => `<url><loc>${esc(canonicalBase + u)}</loc>${last ? `<lastmod>${last}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>`);
  }
  if (path === 'privacy') return res.send(require('./render').privacyPage(site, doc, opts));
  const key = await require('./bots').indexNowKey();
  if (key && path === `${key}.txt`) return res.type('text/plain').send(key);

  let lang = 'en', slug = path;
  if ((path === 'es' || path.startsWith('es/')) && doc.translations?.es) { lang = 'es'; slug = path.slice(3); }
  const html = sites.renderSite(site, { pageSlug: slug, lang, base, canonicalBase, template });
  if (!html) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).send(require('./render').notFoundPage(site, doc, opts));
  }
  countVisit(site, slug, req).catch(() => {});
  res.send(html);
}

async function lead(site, req, res, base) {
  const b = req.body || {};
  const spam = security.spamCheck(req, b);
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const row = {
    siteId: site.id, memberId: site.memberId, kind: ['contact', 'quote', 'booking'].includes(b.kind) ? b.kind : 'contact',
    name: clip(b.name, 120), email: clip(b.email, 160), phone: clip(b.phone, 40), date: clip(b.date, 20), time: clip(b.time, 20),
    message: clip(b.message, 3000), at: new Date().toISOString(), status: 'new', spam: !!spam, spamReason: spam || null,
  };
  const thanks = (msg) => res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Thank you</title><style>body{font:18px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#8cf}}</style></head><body><div><h1>${esc(msg)}</h1><p><a href="${esc(base)}">Back to the site</a></p></div></body></html>`);
  if (spam === 'rate') return res.status(429).send('Too many messages. Please wait a minute.');
  if (!row.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return res.status(400).send('Please give your name and a valid email. <a href="javascript:history.back()">Back</a>');
  const id = await store.add('leads', row);
  if (spam) { await oracle('bot:security', 'lead.spam_blocked', { site: site.id, reason: spam }); return thanks('Thanks! Your message was sent.'); }
  await oracle('visitor', 'lead.received', { site: site.id, lead: id, kind: row.kind });
  const m = await store.get('members', site.memberId);
  if (m) {
    await sendEmail({
      to: m.email, kind: 'lead_alert', subject: `New ${row.kind} request from ${row.name} (${site.details?.businessName || site.slug})`,
      html: `<p><b>${esc(row.name)}</b> &lt;${esc(row.email)}&gt;${row.phone ? ` · ${esc(row.phone)}` : ''}</p>${row.date ? `<p>Wants: ${esc(row.date)} ${esc(row.time)}</p>` : ''}<p>${esc(row.message).replace(/\n/g, '<br>')}</p><p><a href="${config.baseUrl}/leads">Open your leads inbox</a></p>`,
    });
  }
  thanks(row.kind === 'booking' ? 'Thanks! Your booking request was sent. We will confirm with you.' : 'Thanks! Your message was sent.');
}

// Item 51: answers visitors ONLY from this site's own content, says it's an AI.
async function assistant(site, doc, req, res) {
  if (!site.assistant) return res.status(404).json({ answer: 'Not available.' });
  if (!security.allow('assist:' + security.ip(req), 10, 60e3)) return res.status(429).json({ answer: 'Too many questions. Please wait a minute.' });
  const q = String(req.body.q || '').slice(0, 500);
  if (!q.trim()) return res.json({ answer: 'Please type a question.' });
  const r = await ai.text({
    memberId: site.memberId, task: 'site-assistant',
    system: `You are the AI assistant on the website of ${site.details?.businessName || 'this business'}. Answer ONLY from the website content below. If the answer is not there, say you don't know and suggest using the contact details or form. Keep answers under 80 words. You are an AI; say so if asked.`,
    prompt: `WEBSITE CONTENT:\n${docs.docText(doc).slice(0, 12000)}\n\nVISITOR QUESTION: ${q}`,
  });
  res.json({ answer: r.ok ? r.text : r.reason === 'AI: Not connected' ? 'The AI assistant is not connected yet. Please use the contact details on this site.' : 'Sorry, the AI assistant cannot answer right now. Please use the contact details on this site.' });
}

// Host-based routing: [site].DOMAIN and verified custom domains.
async function hostRouter(req, res, next) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
  const suffix = '.' + config.domain;
  let site = null;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    if (!sub || ['www', 'app', 'status'].includes(sub)) return next();
    site = await sites.siteBySlug(sub);
    if (!site) return res.status(404).send(sites.offlinePage('missing'));
  } else if (host && host !== config.domain && !host.endsWith('.run.app') && !['localhost', '127.0.0.1'].includes(host) && !host.startsWith('127.')) {
    const d = (await store.where('domains', 'host', host)).find((x) => x.status === 'verified');
    if (!d) return next();
    site = await store.get('sites', d.siteId);
  } else return next();
  if (req.path.startsWith('/a/')) return next(); // shared asset route
  return handle(site, req.path.replace(/^\/+/, ''), req, res, { base: '/', host });
}

function mount(app) {
  app.use((req, res, next) => hostRouter(req, res, next).catch(next));
  app.all('/s/:slug{/*rest}', async (req, res, next) => {
    try {
      const slug = String(req.params.slug).toLowerCase();
      const site = await sites.siteBySlug(slug);
      if (!site) return res.status(404).send(sites.offlinePage('missing'));
      await handle(site, (req.params.rest || []).join('/'), req, res, { base: `/s/${slug}/`, host: null });
    } catch (e) { next(e); }
  });
}

module.exports = { mount, handle, canonicalFor };
