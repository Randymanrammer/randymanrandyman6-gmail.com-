// The site document: pages made of sections. Built ONLY from what the member
// typed in (item 22: no made-up facts). Everything coming back from the
// browser goes through clean(), which keeps plain text only.
const crypto = require('crypto');

const SECTION_TYPES = {
  hero: 'Hero banner', about: 'About', services: 'Services', pricing: 'Pricing', gallery: 'Gallery',
  map: 'Map', faq: 'FAQ', reviews: 'Reviews (real ones only)', hours: 'Hours', contact: 'Contact details',
  form: 'Form (contact, quote or booking)', text: 'Text block', menu: 'Menu', sponsored: 'Sponsored / ad (disclosed)',
};

const sid = () => 's' + crypto.randomBytes(4).toString('hex');
const t = (v, n = 2000) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);

function parseDetails(b) {
  const menu = lines(b.menu).slice(0, 60).map((l) => {
    const m = l.match(/^(.*?)\s+[-–]\s+(\$?\d[\d.,]*)\s*(.*)$/);
    return m ? { name: t(m[1], 80), price: t(m[2], 20), text: t(m[3], 200) } : { name: t(l, 80), price: '', text: '' };
  });
  const faqs = lines(b.faqs).slice(0, 30).map((l) => {
    const i = l.indexOf('?');
    return i > 0 ? { q: t(l.slice(0, i + 1), 200), a: t(l.slice(i + 1), 800) } : null;
  }).filter((x) => x && x.a);
  return {
    businessName: t(b.businessName, 80), tagline: t(b.tagline, 140), description: t(b.description, 2000),
    services: lines(b.services).slice(0, 30).map((x) => t(x, 120)),
    phone: t(b.phone, 40), email: t(b.email, 120), address: t(b.address, 200), hours: t(b.hours, 400),
    menu, faqs, takesBookings: b.takesBookings === 'yes' || b.takesBookings === true,
  };
}

function sectionFor(type, d) {
  const data = {
    hero: { heading: d.businessName || '', text: d.tagline || '', image: null, button: d.phone || d.email ? { label: 'Contact us', href: 'contact' } : null },
    about: { heading: 'About us', text: d.description || '' },
    services: { heading: 'Services', items: (d.services || []).map((name) => ({ name, text: '' })) },
    pricing: { heading: 'Pricing', items: [] },
    gallery: { heading: 'Gallery', images: [] },
    map: { heading: 'Find us', address: d.address || '' },
    faq: { heading: 'Questions', items: d.faqs || [] },
    reviews: { heading: 'Reviews', items: [] },
    hours: { heading: 'Hours', text: d.hours || '' },
    contact: { heading: 'Contact', phone: d.phone || '', email: d.email || '', address: d.address || '', hours: d.hours || '' },
    form: { heading: 'Send us a message', kind: 'contact', intro: '' },
    text: { heading: '', text: '' },
    menu: { heading: 'Menu', items: d.menu || [] },
    sponsored: { heading: '', text: '', disclosure: 'Sponsored' },
  }[type];
  if (!data) throw new Error('unknown section ' + type);
  return { id: sid(), type, data };
}

// Does a section have anything real in it? Empty ones are skipped on live sites.
function hasContent(s) {
  const d = s.data || {};
  switch (s.type) {
    case 'services': case 'pricing': case 'faq': case 'reviews': case 'menu': return (d.items || []).length > 0;
    case 'gallery': return (d.images || []).length > 0;
    case 'map': return !!d.address;
    case 'contact': return !!(d.phone || d.email || d.address || d.hours);
    case 'form': return true;
    case 'hero': return !!(d.heading || d.text || d.image);
    default: return !!(d.text || d.heading);
  }
}

// Item 22: build the pages that fit this business from its real details.
function buildDoc(details, template) {
  const d = details;
  const home = template.sections.map((ty) => sectionFor(ty, d)).filter(hasContent);
  const pages = [{ id: 'home', slug: '', title: 'Home', nav: true, sections: home }];
  if (d.description) pages.push({ id: 'about', slug: 'about', title: 'About', nav: true, sections: [sectionFor('about', d)] });
  if (d.services.length) pages.push({ id: 'services', slug: 'services', title: 'Services', nav: true, sections: [sectionFor('services', d)] });
  if (d.menu.length) pages.push({ id: 'menu', slug: 'menu', title: 'Menu', nav: true, sections: [sectionFor('menu', d)] });
  if (d.takesBookings) {
    const f = sectionFor('form', d); f.data = { heading: 'Book an appointment', kind: 'booking', intro: '' };
    pages.push({ id: 'booking', slug: 'booking', title: 'Booking', nav: true, sections: [f] });
  }
  if (d.faqs.length) pages.push({ id: 'faq', slug: 'faq', title: 'FAQ', nav: true, sections: [sectionFor('faq', d)] });
  const contact = [sectionFor('contact', d), sectionFor('form', d)];
  if (d.address) contact.push(sectionFor('map', d));
  pages.push({ id: 'contact', slug: 'contact', title: 'Contact', nav: true, sections: contact.filter(hasContent) });
  for (const p of pages) p.meta = {};
  return {
    v: 1, template: template.id,
    theme: { colors: null, headingFont: template.theme.headingFont, bodyFont: template.theme.bodyFont, logo: null, mode: 'auto' },
    pages,
    settings: { redirects: [], notFound: { heading: 'Page not found', text: 'Sorry, that page is not here.' }, lang: 'en' },
  };
}

// ---------- clean() — the only way browser data gets into a doc ----------
const ASSET_RE = /^\/a\/[A-Za-z0-9_-]{4,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const SLUG = /^[a-z0-9-]{0,40}$/;
function img(v) {
  if (!v || typeof v !== 'object' || !ASSET_RE.test(String(v.src || ''))) return null;
  return { src: v.src, alt: t(v.alt, 200), aiMade: !!v.aiMade, rightsConfirmed: !!v.rightsConfirmed };
}
function link(v) {
  if (!v || typeof v !== 'object') return null;
  const href = t(v.href, 300);
  if (!/^(https:\/\/|mailto:|tel:|#|[a-z0-9-]*$)/i.test(href)) return null;
  return { label: t(v.label, 60), href };
}
function items(v, fields, max = 60) {
  return (Array.isArray(v) ? v : []).slice(0, max).map((x) => {
    const o = {};
    for (const [k, n] of Object.entries(fields)) o[k] = typeof n === 'number' ? t(x?.[k], n) : !!x?.[k];
    return o;
  });
}
function cleanSection(s) {
  if (!s || !SECTION_TYPES[s.type]) return null;
  const d = s.data || {};
  const base = { heading: t(d.heading, 160) };
  let data;
  switch (s.type) {
    case 'hero': data = { ...base, text: t(d.text, 400), image: img(d.image), button: link(d.button) }; break;
    case 'services': data = { ...base, items: items(d.items, { name: 120, text: 600 }) }; break;
    case 'pricing': case 'menu': data = { ...base, items: items(d.items, { name: 120, price: 30, text: 400 }) }; break;
    case 'gallery': data = { ...base, images: (Array.isArray(d.images) ? d.images : []).slice(0, 40).map(img).filter(Boolean) }; break;
    case 'map': data = { ...base, address: t(d.address, 200) }; break;
    case 'faq': data = { ...base, items: items(d.items, { q: 200, a: 1200 }, 40) }; break;
    case 'reviews': data = { ...base, items: items(d.items, { name: 80, text: 800, source: 200, date: 30, attestedReal: true }, 40) }; break;
    case 'contact': data = { ...base, phone: t(d.phone, 40), email: t(d.email, 120), address: t(d.address, 200), hours: t(d.hours, 400) }; break;
    case 'form': data = { ...base, kind: ['contact', 'quote', 'booking'].includes(d.kind) ? d.kind : 'contact', intro: t(d.intro, 400) }; break;
    case 'sponsored': data = { ...base, text: t(d.text, 2000), disclosure: t(d.disclosure, 80) }; break;
    default: data = { ...base, text: t(d.text, 4000) };
  }
  return { id: /^s[0-9a-f]{8}$/.test(s.id) ? s.id : sid(), type: s.type, data };
}
function cleanMeta(m = {}) {
  return {
    title: t(m.title, 70), description: t(m.description, 170), keywords: t(m.keywords, 200),
    robots: ['index,follow', 'noindex,nofollow', 'noindex,follow'].includes(m.robots) ? m.robots : '',
    ogImage: ASSET_RE.test(String(m.ogImage || '')) ? m.ogImage : '',
  };
}
function cleanPages(pages) {
  const seen = new Set();
  const out = (Array.isArray(pages) ? pages : []).slice(0, 20).map((p, i) => {
    let slug = i === 0 ? '' : t(p.slug, 40).toLowerCase();
    if (!SLUG.test(slug) || seen.has(slug) || (i > 0 && !slug)) slug = 'page-' + i;
    seen.add(slug);
    return {
      id: t(p.id, 40) || 'p' + i, slug, title: t(p.title, 60) || 'Page', nav: p.nav !== false,
      sections: (Array.isArray(p.sections) ? p.sections : []).slice(0, 40).map(cleanSection).filter(Boolean),
      meta: cleanMeta(p.meta),
    };
  });
  if (!out.length) out.push({ id: 'home', slug: '', title: 'Home', nav: true, sections: [], meta: cleanMeta() });
  return out;
}
function clean(doc) {
  if (!doc || typeof doc !== 'object') throw Object.assign(new Error('Bad site data'), { status: 400 });
  const th = doc.theme || {};
  const col = (c) => (c && HEX.test(c.bg) && HEX.test(c.fg) && HEX.test(c.acc) && HEX.test(c.card) ? { bg: c.bg, fg: c.fg, acc: c.acc, card: c.card } : null);
  const colors = th.colors ? { light: col(th.colors.light), dark: col(th.colors.dark) } : null;
  const font = (f) => require('./templates').FONTS.includes(f) ? f : 'system-ui';
  const out = {
    v: 1, template: t(doc.template, 40) || 'advisory',
    theme: {
      colors: colors && (colors.light || colors.dark) ? colors : null,
      headingFont: font(th.headingFont), bodyFont: font(th.bodyFont),
      logo: img(th.logo), mode: ['auto', 'light', 'dark'].includes(th.mode) ? th.mode : 'auto',
    },
    pages: cleanPages(doc.pages),
    settings: {
      redirects: (Array.isArray(doc.settings?.redirects) ? doc.settings.redirects : []).slice(0, 100)
        .map((r) => ({ from: '/' + t(r.from, 200).replace(/^\/+/, ''), to: t(r.to, 300) }))
        .filter((r) => r.from.length > 1 && /^(\/|https:\/\/)/.test(r.to)),
      notFound: { heading: t(doc.settings?.notFound?.heading, 120) || 'Page not found', text: t(doc.settings?.notFound?.text, 600) },
      lang: 'en',
    },
  };
  if (doc.translations?.es) out.translations = { es: { pages: cleanPages(doc.translations.es.pages), at: t(doc.translations.es.at, 40) } };
  if (JSON.stringify(out).length > 300000) throw Object.assign(new Error('Site is too big. Remove some sections.'), { status: 413 });
  return out;
}

// Plain text of a doc (for AI assistant, Governor, search).
function docText(doc, pages = doc.pages) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (!/^\/a\//.test(v) && v.length > 1) out.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!['src', 'href', 'id', 'kind', 'type'].includes(k)) walk(x);
  };
  for (const p of pages) { out.push(`# ${p.title}`); p.sections.forEach((s) => walk(s.data)); }
  return out.join('\n');
}

module.exports = { SECTION_TYPES, parseDetails, buildDoc, sectionFor, hasContent, clean, cleanSection, docText, sid };
