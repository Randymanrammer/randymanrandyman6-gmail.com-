// Renders a member site page from its doc.
// Items 25 (mobile-first), 36 (light/dark), 37 (accessible), 38 (fast),
// 45-50 (hosting bits), 53 (AI images labeled), 54 (7 meta tags), 83 (ad disclosure).
const config = require('./config');
const { esc } = require('./email');
const { hasContent } = require('./doc');

// ---------- Color contrast (item 37) ----------
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
function mix(a, b, w) {
  const p = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(p(a, i) * (1 - w) + p(b, i) * w).toString(16).padStart(2, '0')).join('');
}
// Nudge a color toward fg until it reaches the ratio against bg.
function fix(color, bg, fg, ratio) {
  let c = color;
  for (let w = 0.1; contrast(c, bg) < ratio && w <= 1; w += 0.1) c = mix(color, fg, w);
  return c;
}
function palette(colorsArr) {
  const [bg, fg0, acc0, card] = colorsArr;
  const fg = fix(fg0, bg, contrast(bg, '#000000') > contrast(bg, '#ffffff') ? '#000000' : '#ffffff', 7);
  const acc = fix(acc0, bg, fg, 4.5);
  const accfg = contrast(acc, '#ffffff') >= 4.5 ? '#ffffff' : '#000000';
  return { bg, fg, acc, card, accfg, mut: fix(mix(fg, bg, 0.35), bg, fg, 4.5) };
}
function themeColors(template, theme) {
  const ov = theme.colors || {};
  const L = ov.light ? [ov.light.bg, ov.light.fg, ov.light.acc, ov.light.card] : template.theme.light;
  const D = ov.dark ? [ov.dark.bg, ov.dark.fg, ov.dark.acc, ov.dark.card] : template.theme.dark;
  return { light: palette(L), dark: palette(D) };
}
const vars = (p) => `--bg:${p.bg};--fg:${p.fg};--acc:${p.acc};--accfg:${p.accfg};--card:${p.card};--mut:${p.mut}`;

function fontLink(fonts) {
  const fam = [...new Set(fonts)].filter((f) => f && f !== 'system-ui');
  if (!fam.length) return '';
  const q = fam.map((f) => 'family=' + f.replace(/ /g, '+') + ':wght@400;700').join('&');
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${q}&display=swap">`;
}
const ff = (f) => (f && f !== 'system-ui' ? `'${f}',` : '') + 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';

// ---------- Sections ----------
const nl = (s) => esc(s).replace(/\n/g, '<br>');
function E(edit, path) { return edit ? ` data-edit="${esc(path)}"` : ''; }
function image(im, { edit, path, eager, cls = '' }) {
  if (!im) return edit ? `<button type="button" class="addimg" data-edit-img="${esc(path)}">+ Add image</button>` : '';
  const tag = `<img src="${esc(im.src)}" alt="${esc(im.alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" class="${cls}"${edit ? ` data-edit-img="${esc(path)}"` : ''}>`;
  return im.aiMade ? `<figure class="aimg">${tag}<figcaption>AI-made image</figcaption></figure>` : tag;
}
function href(base, h) {
  if (!h) return '#';
  if (/^(https:|mailto:|tel:|#)/.test(h)) return h;
  return base + h;
}
function list(items, edit, p, fn) { return items.map((x, i) => fn(x, `${p}.items.${i}`)).join(''); }

function section(s, ctx, idx) {
  const { edit, base, pi } = ctx;
  if (!edit && !hasContent(s)) return '';
  const d = s.data;
  const P = `pages.${pi}.sections.${idx}.data`;
  const h2 = (txt, tag = 'h2') => (txt || edit ? `<${tag}${E(edit, P + '.heading')}>${esc(txt)}</${tag}>` : '');
  const wrap = (inner, cls = '') => `<section id="${esc(s.id)}" class="sec sec-${s.type} ${cls}"${edit ? ` data-sec="${idx}" data-label="${esc(s.type)}"` : ''}>${inner}</section>`;
  switch (s.type) {
    case 'hero':
      return wrap(`<div class="hero">${image(d.image, { edit, path: P + '.image', eager: true, cls: 'heroimg' })}<div class="herotxt">${h2(d.heading, idx === 0 ? 'h1' : 'h2')}
${d.text || edit ? `<p class="lead"${E(edit, P + '.text')}>${esc(d.text)}</p>` : ''}${d.button ? `<p><a class="btn" href="${esc(href(base, d.button.href))}">${esc(d.button.label)}</a></p>` : ''}</div></div>`);
    case 'services':
      return wrap(`${h2(d.heading)}<div class="grid">${list(d.items, edit, P, (x, p) => `<div class="card"><h3${E(edit, p + '.name')}>${esc(x.name)}</h3>${x.text || edit ? `<p${E(edit, p + '.text')}>${nl(x.text)}</p>` : ''}</div>`)}</div>`);
    case 'pricing': case 'menu':
      return wrap(`${h2(d.heading)}<ul class="plist">${list(d.items, edit, P, (x, p) => `<li><span><b${E(edit, p + '.name')}>${esc(x.name)}</b>${x.text || edit ? `<br><span class="mut"${E(edit, p + '.text')}>${esc(x.text)}</span>` : ''}</span><span class="price"${E(edit, p + '.price')}>${esc(x.price)}</span></li>`)}</ul>${edit && !d.items.length ? '<p class="mut">Add your real items in the chat, e.g. "add price Haircut - $25".</p>' : ''}`);
    case 'gallery':
      return wrap(`${h2(d.heading)}<div class="gal">${d.images.map((im, i) => image(im, { edit, path: `${P}.images.${i}` })).join('')}${edit ? `<button type="button" class="addimg" data-edit-img="${P}.images.${d.images.length}">+ Add photo</button>` : ''}</div>`);
    case 'map':
      return wrap(`${h2(d.heading)}<p${E(edit, P + '.address')}>${nl(d.address)}</p>${d.address && !edit ? `<iframe class="map" title="Map: ${esc(d.address)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${encodeURIComponent(d.address)}&output=embed"></iframe>` : ''}`);
    case 'faq':
      return wrap(`${h2(d.heading)}${list(d.items, edit, P, (x, p) => `<details class="card"${edit ? ' open' : ''}><summary${E(edit, p + '.q')}>${esc(x.q)}</summary><p${E(edit, p + '.a')}>${nl(x.a)}</p></details>`)}`);
    case 'reviews': {
      const real = d.items.filter((r) => r.attestedReal && r.source);
      if (!real.length && !edit) return '';
      return wrap(`${h2(d.heading)}<div class="grid">${real.map((r) => `<blockquote class="card"><p>${nl(r.text)}</p><footer>- ${esc(r.name)}${r.source ? `, <span class="mut">${esc(r.source)}</span>` : ''}${r.date ? ` <span class="mut">(${esc(r.date)})</span>` : ''}</footer></blockquote>`).join('')}</div>${edit ? '<p class="mut">Only real reviews you can show a source for. Add them in the chat: "add review".</p>' : ''}`);
    }
    case 'hours':
      return wrap(`${h2(d.heading)}<p${E(edit, P + '.text')}>${nl(d.text)}</p>`);
    case 'contact':
      return wrap(`${h2(d.heading)}<div class="grid">
${d.phone || edit ? `<div class="card"><b>Phone</b><br><a href="tel:${esc(d.phone.replace(/[^0-9+]/g, ''))}"${E(edit, P + '.phone')}>${esc(d.phone)}</a></div>` : ''}
${d.email || edit ? `<div class="card"><b>Email</b><br><a href="mailto:${esc(d.email)}"${E(edit, P + '.email')}>${esc(d.email)}</a></div>` : ''}
${d.address || edit ? `<div class="card"><b>Address</b><br><span${E(edit, P + '.address')}>${nl(d.address)}</span></div>` : ''}
${d.hours || edit ? `<div class="card"><b>Hours</b><br><span${E(edit, P + '.hours')}>${nl(d.hours)}</span></div>` : ''}</div>`);
    case 'form': {
      const id = (n) => `${s.id}-${n}`;
      const f = (n, label, type = 'text', req = false) => `<label for="${id(n)}">${label}${req ? ' *' : ''}</label><input id="${id(n)}" name="${n}" type="${type}"${req ? ' required' : ''} maxlength="200" autocomplete="${n === 'phone' ? 'tel' : n}">`;
      return wrap(`${h2(d.heading)}${d.intro || edit ? `<p${E(edit, P + '.intro')}>${esc(d.intro)}</p>` : ''}
<form class="card lead-form" method="post" action="${esc(base)}f"${edit ? ' onsubmit="return false"' : ''}>
<input type="hidden" name="kind" value="${esc(d.kind)}"><input type="hidden" name="section" value="${esc(s.id)}"><input type="hidden" name="ts" value="__TS__">
<div class="hp" aria-hidden="true"><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
${f('name', 'Name', 'text', true)}${f('email', 'Email', 'email', true)}${f('phone', 'Phone', 'tel')}
${d.kind === 'booking' ? `${f('date', 'Preferred date', 'date', true)}${f('time', 'Preferred time', 'time')}` : ''}
<label for="${id('message')}">${d.kind === 'quote' ? 'What do you need a quote for?' : 'Message'}${d.kind === 'booking' ? '' : ' *'}</label><textarea id="${id('message')}" name="message" rows="4" maxlength="3000"${d.kind === 'booking' ? '' : ' required'}></textarea>
<p class="mut small">By sending, you agree we can contact you about your request. <a href="${esc(base)}privacy">Privacy</a></p>
<button class="btn" type="submit">${d.kind === 'booking' ? 'Request booking' : d.kind === 'quote' ? 'Get a quote' : 'Send'}</button></form>`);
    }
    case 'sponsored':
      return wrap(`<div class="card ad"><p class="disc"><b${E(edit, P + '.disclosure')}>${esc(d.disclosure || 'Sponsored')}</b></p>${h2(d.heading, 'h3')}<p${E(edit, P + '.text')}>${nl(d.text)}</p></div>`);
    default:
      return wrap(`${h2(d.heading)}<p${E(edit, P + '.text')}>${nl(d.text)}</p>`);
  }
}

const CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 var(--bf)}h1,h2,h3{font-family:var(--hf);line-height:1.15}
h1{font-size:clamp(30px,7vw,52px);margin:.2em 0}h2{font-size:clamp(24px,5vw,34px)}a{color:var(--acc)}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--card);padding:8px;z-index:9}
:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
header.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:12px 16px;max-width:1040px;margin:auto}
header.top .name{font-family:var(--hf);font-weight:700;font-size:20px;color:var(--fg);text-decoration:none;margin-right:auto;display:flex;gap:8px;align-items:center}
header.top .name img{height:36px;width:auto}nav.menu{display:flex;flex-wrap:wrap;gap:4px 14px}nav.menu a{text-decoration:none;padding:8px 2px}nav.menu a[aria-current]{font-weight:700;text-decoration:underline}
.tog{background:none;border:1px solid var(--mut);color:var(--fg);border-radius:99px;padding:6px 10px;min-height:36px;cursor:pointer}
main{max-width:1040px;margin:auto;padding:0 16px}.sec{padding:28px 0}
.hero{display:grid;gap:18px;align-items:center}@media(min-width:760px){.hero:has(img){grid-template-columns:1.1fr 1fr}}
.heroimg,.gal img{width:100%;height:auto;border-radius:var(--r);display:block}.lead{font-size:1.2em;color:var(--mut)}
.btn{display:inline-block;background:var(--acc);color:var(--accfg);border:0;border-radius:var(--r);padding:12px 20px;font:inherit;font-weight:700;text-decoration:none;min-height:44px;cursor:pointer}
.card{background:var(--card);border-radius:var(--r);padding:18px;margin:0 0 12px}.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
.gal{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))}.mut{color:var(--mut)}.small{font-size:14px}
.plist{list-style:none;padding:0}.plist li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--fg) 15%,transparent)}.price{font-weight:700;white-space:nowrap}
.map{width:100%;height:320px;border:0;border-radius:var(--r)}details summary{cursor:pointer;font-weight:700;min-height:28px}
blockquote{margin:0}label{display:block;font-weight:600;font-size:15px}input,textarea{width:100%;padding:11px;border:1px solid var(--mut);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;margin:4px 0 12px}
.hp{position:absolute;left:-5000px}.aimg{margin:0}.aimg figcaption{font-size:12px;color:var(--mut)}.ad{border:2px dashed var(--mut)}.disc{text-transform:uppercase;letter-spacing:.06em;font-size:13px;margin:0}
footer.foot{max-width:1040px;margin:30px auto 0;padding:20px 16px;color:var(--mut);font-size:14px;border-top:1px solid color-mix(in srgb,var(--fg) 15%,transparent)}
.ai-btn{position:fixed;right:14px;bottom:14px;z-index:5}.ai-box{position:fixed;right:14px;bottom:70px;width:min(360px,calc(100vw - 28px));max-height:70vh;overflow:auto;z-index:5;box-shadow:0 6px 30px #0004}
img{max-width:100%}`;

const EDIT_CSS = `[data-sec]{outline:1px dashed color-mix(in srgb,var(--acc) 60%,transparent);position:relative;margin:6px 0}[data-sec]::before{content:attr(data-label);position:absolute;top:0;right:0;font:11px system-ui;background:var(--acc);color:var(--accfg);padding:1px 6px;border-radius:0 0 0 6px}
[data-edit]{cursor:text;min-width:2ch;display:inline-block;min-height:1em}[data-edit]:empty::after{content:"tap to add";color:var(--mut);font-style:italic}[data-edit]:hover,[data-edit]:focus{outline:2px solid var(--acc);outline-offset:2px}[data-edit-img]{cursor:pointer}
.addimg{border:2px dashed var(--mut);background:none;color:var(--fg);padding:18px;border-radius:var(--r);cursor:pointer;min-height:44px;font:inherit}`;

// Item 23: tap text to edit, tap image to change. Talks to the builder via postMessage.
const EDIT_JS = `(()=>{const send=m=>parent.postMessage(Object.assign({ios:1},m),location.origin);
document.addEventListener('click',e=>{const a=e.target.closest('a');if(a)e.preventDefault();
const im=e.target.closest('[data-edit-img]');if(im){send({type:'img',path:im.dataset.editImg});return}
const el=e.target.closest('[data-edit]');if(el&&!el.isContentEditable){el.contentEditable='plaintext-only';el.focus()}},true);
document.addEventListener('focusout',e=>{const el=e.target;if(el.dataset&&el.dataset.edit!==undefined&&el.isContentEditable){el.contentEditable='false';send({type:'edit',path:el.dataset.edit,value:el.innerText.replace(/\\u00a0/g,' ').trim()})}});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&e.target.isContentEditable&&!/text|a$/.test(e.target.dataset.edit)){e.preventDefault();e.target.blur()}});})();`;

const TOGGLE_JS = `(()=>{const r=document.documentElement,b=document.getElementById('tog');let m;try{m=localStorage.getItem('mode')}catch{}if(m)r.dataset.mode=m;
const dark=()=>r.dataset.mode?r.dataset.mode==='dark':matchMedia('(prefers-color-scheme:dark)').matches;const lab=()=>{b.textContent=dark()?'Light mode':'Dark mode';b.setAttribute('aria-pressed',dark())};lab();
b.onclick=()=>{r.dataset.mode=dark()?'light':'dark';try{localStorage.setItem('mode',r.dataset.mode)}catch{}lab()}})();`;

const ASSIST_JS = `(()=>{const b=document.getElementById('aib'),x=document.getElementById('aix'),f=x.querySelector('form'),o=x.querySelector('.log');
b.onclick=()=>{x.hidden=!x.hidden;if(!x.hidden)f.q.focus()};f.onsubmit=async e=>{e.preventDefault();const q=f.q.value.trim();if(!q)return;f.q.value='';
o.insertAdjacentHTML('beforeend','<p><b>You:</b> '+q.replace(/[<>&]/g,'')+'</p>');const r=await fetch(f.action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'q='+encodeURIComponent(q)}).then(r=>r.json()).catch(()=>({answer:'Sorry, I could not answer right now.'}));
const p=document.createElement('p');p.innerHTML='<b>AI assistant:</b> ';p.append(r.answer);o.append(p);o.scrollTop=1e9}})();`;

// opts: { edit, base, pageSlug, lang, canonicalBase, assistant, template, preview }
function renderPage(site, doc, page, opts) {
  const { edit = false, base, template, lang = 'en', canonicalBase = '' } = opts;
  const pages = lang === 'es' && doc.translations?.es ? doc.translations.es.pages : doc.pages;
  const pi = Math.max(0, pages.findIndex((p) => p.id === page.id));
  const pg = pages[pi] || page;
  const colors = themeColors(template, doc.theme);
  const d = site.details || {};
  const name = d.businessName || pages[0]?.sections.find((s) => s.type === 'hero')?.data.heading || 'Site';
  const m = pg.meta || {};
  const firstText = pg.sections.map((s) => s.data.text || s.data.intro || '').find(Boolean) || d.tagline || '';
  const title = m.title || (pi === 0 ? `${name}${d.tagline ? ' - ' + d.tagline : ''}` : `${pg.title} - ${name}`).slice(0, 70);
  const desc = m.description || String(firstText).slice(0, 160);
  const langBase = lang === 'es' ? base + 'es/' : base;
  const canonical = canonicalBase ? canonicalBase + (lang === 'es' ? 'es/' : '') + pg.slug : '';
  const ogImg = m.ogImage || pages[0]?.sections.find((s) => s.type === 'hero')?.data.image?.src || '';
  const robots = opts.preview || edit ? 'noindex,nofollow' : (m.robots || 'index,follow');
  const hasForm = doc.pages.some((p) => p.sections.some((s) => s.type === 'form'));
  const mode = doc.theme.mode;
  const T = lang === 'es' ? { skip: 'Saltar al contenido', priv: 'Privacidad', host: 'Alojado por', sw: 'English' } : { skip: 'Skip to content', priv: 'Privacy', host: 'Hosted by', sw: 'Español' };
  const body = pg.sections.map((s, i) => section(s, { edit, base: langBase, pi }, i)).join('');
  return `<!doctype html><html lang="${lang}"${mode !== 'auto' ? ` data-mode="${mode}"` : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="keywords" content="${esc(m.keywords || [name, ...(d.services || []).slice(0, 5)].join(', '))}">
<meta name="robots" content="${robots}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}${ogImg && canonicalBase ? `<meta property="og:image" content="${esc(new URL(ogImg, canonicalBase).href)}">` : ''}<meta name="twitter:card" content="${ogImg ? 'summary_large_image' : 'summary'}">
${doc.translations?.es && canonicalBase ? `<link rel="alternate" hreflang="en" href="${esc(canonicalBase + pg.slug)}"><link rel="alternate" hreflang="es" href="${esc(canonicalBase + 'es/' + pg.slug)}">` : ''}
${fontLink([doc.theme.headingFont, doc.theme.bodyFont])}
<style>:root{${vars(colors.light)};--hf:${ff(doc.theme.headingFont)};--bf:${ff(doc.theme.bodyFont)};--r:${template.theme.radius ?? 12}px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-mode=light]){${vars(colors.dark)}}}:root[data-mode=dark]{${vars(colors.dark)}}:root[data-mode=light]{${vars(colors.light)}}
${CSS}${edit ? EDIT_CSS : ''}</style></head><body>
<a class="skip" href="#main">${T.skip}</a>
<header class="top"><a class="name" href="${esc(langBase)}">${doc.theme.logo ? `<img src="${esc(doc.theme.logo.src)}" alt="${esc(doc.theme.logo.alt || name)}" width="36" height="36">` : ''}${esc(name)}</a>
<nav class="menu" aria-label="Main">${pages.filter((p) => p.nav).map((p) => `<a href="${esc(langBase + p.slug)}"${p.id === pg.id ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('')}</nav>
<button class="tog" id="tog" type="button" aria-pressed="false">Dark mode</button></header>
<main id="main">${body}</main>
<footer class="foot"><p>&copy; ${new Date().getUTCFullYear()} ${esc(name)}${hasForm ? ` · <a href="${esc(base)}privacy">${T.priv}</a>` : ''}${doc.translations?.es ? ` · <a href="${esc(lang === 'es' ? base + pg.slug : base + 'es/' + pg.slug)}" hreflang="${lang === 'es' ? 'en' : 'es'}">${T.sw}</a>` : ''}</p><p class="small">${T.host} ${esc(config.brand)}</p></footer>
${opts.assistant && !edit ? `<button class="btn ai-btn" id="aib" type="button" aria-controls="aix">Ask our AI assistant</button><div class="card ai-box" id="aix" hidden role="dialog" aria-label="AI assistant"><p class="small mut">This is an AI assistant. It answers only from this website and can make mistakes.</p><div class="log" aria-live="polite"></div><form action="${esc(base)}assistant"><label for="aiq">Your question</label><input id="aiq" name="q" maxlength="500"><button class="btn">Ask</button></form></div><script>${ASSIST_JS}</script>` : ''}
<script>${TOGGLE_JS}</script>${edit ? `<script>${EDIT_JS}</script>` : ''}
</body></html>`.replace(/__TS__/g, String(Date.now()));
}

function notFoundPage(site, doc, opts) {
  const nf = doc.settings.notFound;
  const page = { id: '__404', slug: '__404', title: nf.heading, nav: false, meta: { robots: 'noindex,nofollow' }, sections: [{ id: 's00000000', type: 'text', data: { heading: nf.heading, text: nf.text } }] };
  const d2 = { ...doc, pages: [...doc.pages, page], translations: undefined };
  return renderPage(site, d2, page, { ...opts, lang: 'en' });
}

function privacyPage(site, doc, opts) {
  const d = site.details || {};
  const contact = d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : 'the contact details on this site';
  const page = { id: '__privacy', slug: 'privacy', title: 'Privacy', nav: false, meta: {}, sections: [{ id: 's00000001', type: 'text', data: { heading: 'Privacy', text: '' } }] };
  const html = renderPage(site, { ...doc, pages: [...doc.pages, page], translations: undefined }, page, { ...opts, lang: 'en' });
  return html.replace(/<main id="main">[\s\S]*<\/main>/, `<main id="main"><section class="sec"><h1>Privacy</h1>
<p>When you send a form on this site, ${esc(d.businessName || 'we')} receives your name, email, phone and message so we can answer you. We don't sell it. This site sets no tracking cookies; it counts page visits without identifying you.</p>
<p>To see or delete what you sent us, contact ${contact}.</p><p class="small mut">This site is hosted by ${esc(config.brand)} (${esc(config.businessName)}).</p></section></main>`);
}

module.exports = { renderPage, notFoundPage, privacyPage, contrast, themeColors, palette };
