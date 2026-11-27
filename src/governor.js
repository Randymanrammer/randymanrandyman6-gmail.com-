// Governor (items 39, 81-83, 87, 88, 90): checks a site (or template) before
// it publishes. Outcomes:
//   pass  - publish
//   warn  - publish allowed; member sees advice
//   block - member must fix the listed errors first
//   hold  - likely adult/hate/scam/illegal or copyrighted: waits for owner review
// Every decision is logged (Oracle + "governor" collection).
const { store } = require('./store');
const { oracle } = require('./oracle');
const { contrast, themeColors } = require('./render');

const W = (arr) => new RegExp('(^|[^a-z0-9])(' + arr.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|') + ')(?=$|[^a-z0-9])', 'i');
const BANNED = {
  adult: W(['porn', 'porno', 'xxx', 'escort service', 'escorts', 'onlyfans', 'nude photos', 'camgirl', 'sex cam', 'adult content']),
  hate: W(['white power', 'heil hitler', 'ethnic cleansing', 'race war', 'kill all', 'gas the', 'subhuman']),
  scam: W(['guaranteed returns', 'double your money', 'get rich quick', 'send bitcoin', 'gift card payment', 'pay with gift cards', 'risk-free investment', 'miracle cure', 'wire transfer only', 'crypto doubling', 'recover your lost funds']),
  illegal: W(['buy cocaine', 'buy heroin', 'buy meth', 'fake id', 'fake ids', 'counterfeit', 'no prescription needed', 'stolen goods', 'hacked accounts', 'carding', 'cloned cards', 'unlicensed pharmacy']),
};
const FAKE_BADGES = W(['as seen on', 'bbb accredited', 'award winning', 'award-winning', 'voted best', 'rated #1', '#1 rated', 'number one rated', 'top rated', 'certified best', 'official partner of', 'google verified', 'trusted by millions']);
const CLAIMS = W(['guaranteed results', '100% satisfaction', 'best in town', 'best in the city', 'best in the state', 'best in the country', 'lowest prices guaranteed', 'cheapest', 'cures', 'clinically proven']);
const AD_WORDS = W(['affiliate link', 'sponsored by', 'paid partnership', 'use my code', 'use code', 'commission', 'we earn from']);
const COPY_SIGNS = /(getty|shutterstock|istock|alamy|adobe ?stock|dreamstime|depositphotos|watermark)/i;
const TESTIMONIAL = /["“][^"”]{20,}["”]\s*[-–—]\s*[A-Z][a-z]+/;
const VAGUE_LINK = W(['click here', 'here', 'read more', 'link']);

function textOf(s) {
  const out = [];
  const walk = (v, k) => {
    if (typeof v === 'string') { if (!['src', 'href', 'kind', 'id'].includes(k)) out.push(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
    else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walk(x, kk);
  };
  walk(s.data);
  return out.join('\n');
}

async function check(site, doc, { template } = {}) {
  const issues = [];
  const add = (level, code, msg, where = '') => issues.push({ level, code, msg, where });
  const allPages = [...doc.pages, ...(doc.translations?.es?.pages || [])];
  const assets = new Map();
  for (const p of allPages) {
    for (const s of p.sections) {
      const where = `${p.title} › ${s.type}`;
      const txt = textOf(s);
      for (const [cat, re] of Object.entries(BANNED)) {
        const m = txt.match(re);
        if (m) add('hold', 'banned.' + cat, `Possible ${cat} content ("${m[2]}"). The owner must review this site before it can go live.`, where);
      }
      const fb = txt.match(FAKE_BADGES);
      if (fb) add('error', 'ftc.badge', `"${fb[2]}" is a badge or award claim. Remove it unless you can prove it (FTC rules).`, where);
      const cl = txt.match(CLAIMS);
      if (cl) add('warn', 'ftc.claim', `"${cl[2]}" is a strong claim. Only keep it if you can back it up.`, where);
      if (s.type !== 'reviews' && TESTIMONIAL.test(txt)) add('error', 'ftc.testimonial', 'This looks like a customer quote. Put real reviews in a Reviews section with where they came from.', where);
      if (s.type === 'reviews') {
        s.data.items.forEach((r, i) => {
          if (!r.attestedReal) add('error', 'ftc.review.unconfirmed', `Review ${i + 1}: confirm it is a real customer review (no fake reviews).`, where);
          if (!r.source) add('error', 'ftc.review.source', `Review ${i + 1}: add where it came from (e.g. "Google review").`, where);
        });
      }
      if (s.type === 'sponsored' && !String(s.data.disclosure || '').trim()) add('error', 'ftc.ad.disclosure', 'Sponsored sections need a clear label like "Sponsored" or "Ad".', where);
      if (s.type !== 'sponsored' && AD_WORDS.test(txt)) add('error', 'ftc.ad.hidden', 'This mentions a paid or affiliate deal. Move it into a "Sponsored" section so the ad is clearly disclosed.', where);
      if (/lyrics/i.test(txt) || /©\s*\d{4}\s+(?!.*\b(we|us|our)\b)/i.test(txt)) add('warn', 'copyright.text', 'This may include someone else\'s copyrighted text. Only use words you wrote or have rights to.', where);
      const imgs = [s.data.image, ...(s.data.images || [])].filter(Boolean);
      for (const im of imgs) {
        if (!im.alt) add('error', 'a11y.alt', 'An image has no description (alt text). Tap it and describe what it shows.', where);
        if (!im.rightsConfirmed && !im.aiMade) add('error', 'rights.unconfirmed', 'Confirm you have the rights to this image.', where);
        assets.set(im.src.split('/').pop(), where);
      }
      if (s.type !== 'form' && s.data.heading === '' && ['services', 'faq', 'gallery', 'pricing', 'menu'].includes(s.type)) add('warn', 'a11y.heading', 'This section has no heading. Headings help screen readers and search.', where);
      if (s.data.button && VAGUE_LINK.test(s.data.button.label || '') && (s.data.button.label || '').length < 12) add('warn', 'a11y.linktext', 'Use a button label that says where it goes (not "click here").', where);
    }
  }
  if (doc.theme.logo) {
    if (!doc.theme.logo.alt) add('error', 'a11y.alt', 'Your logo needs a description (alt text).', 'Brand kit');
    assets.set(doc.theme.logo.src.split('/').pop(), 'Brand kit');
  }
  // Copyright signs in uploaded file names (item 87).
  for (const [id, where] of assets) {
    const a = await store.get('assets', id);
    if (a && COPY_SIGNS.test(a.originalName || '')) add('hold', 'copyright.image', `Image "${a.originalName}" looks like stock or watermarked art. The owner will review it.`, where);
  }
  // Contrast after automatic fixes (item 37/88).
  if (template) {
    const c = themeColors(template, doc.theme);
    for (const [mode, p] of Object.entries(c)) if (contrast(p.fg, p.bg) < 4.5) add('error', 'a11y.contrast', `Text is hard to read in ${mode} mode. Pick darker/lighter brand colors.`, 'Brand kit');
  }
  const d = site.details || {};
  if (!d.phone && !d.email && !d.address && !allPages.some((p) => p.sections.some((s) => s.type === 'form'))) add('warn', 'biz.contact', 'Add a way for customers to reach you (phone, email, address or a form).', 'Site');
  const status = issues.some((i) => i.level === 'hold') ? 'hold' : issues.some((i) => i.level === 'error') ? 'block' : issues.length ? 'warn' : 'pass';
  return { status, pass: status === 'pass' || status === 'warn', issues };
}

async function decide(site, doc, actor, opts = {}) {
  const r = await check(site, doc, opts);
  const at = new Date().toISOString();
  await store.add('governor', { siteId: site.id || null, templateId: opts.templateId || null, status: r.status, issues: r.issues, at, actor });
  await oracle('bot:governor', 'governor.' + r.status, { site: site.id || null, template: opts.templateId || null, issues: r.issues.length, by: actor });
  return r;
}

module.exports = { check, decide, BANNED };
