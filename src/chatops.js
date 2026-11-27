// Builder chat (item 21). Plain commands always work, even with AI not
// connected. Anything else goes to Gemini, which may only return edit
// operations that use the member's own words (no made-up facts).
const docs = require('./doc');
const ai = require('./ai');
const templates = require('./templates');

const TYPE_WORDS = {
  hero: 'hero|banner', about: 'about', services: 'services?', pricing: 'pric(e|es|ing)', gallery: 'gallery|photos', map: 'map',
  faq: 'faqs?|questions', reviews: 'reviews?|testimonials', hours: 'hours', contact: 'contact( details| info)?', form: '(contact |quote |booking )?form',
  text: 'text( block)?', menu: 'menu', sponsored: 'sponsored|ad',
};
function typeOf(word) {
  const w = String(word || '').trim().toLowerCase();
  for (const [t, re] of Object.entries(TYPE_WORDS)) if (new RegExp(`^(${re})( section)?$`).test(w)) return t;
  return null;
}
function findPage(doc, name, fallback) {
  const n = String(name || '').trim().toLowerCase();
  return doc.pages.find((p) => p.title.toLowerCase() === n || p.slug === n) || fallback;
}
function sectionOn(page, type) { return page.sections.find((s) => s.type === type); }
function ensure(page, type, d) {
  let s = sectionOn(page, type);
  if (!s) { s = docs.sectionFor(type, d); page.sections.push(s); }
  return s;
}

// Apply one op to doc (mutates). Returns a short description.
function apply(doc, op, ctx) {
  const page = findPage(doc, op.page, ctx.page);
  const d = ctx.details;
  switch (op.op) {
    case 'add_section': {
      const type = op.type;
      if (!docs.SECTION_TYPES[type]) return null;
      const s = docs.sectionFor(type, d);
      if (type === 'form' && op.kind) s.data.kind = op.kind, s.data.heading = { quote: 'Get a quote', booking: 'Book an appointment', contact: 'Send us a message' }[op.kind] || s.data.heading;
      if (op.heading) s.data.heading = String(op.heading);
      if (op.text !== undefined && 'text' in s.data) s.data.text = String(op.text);
      page.sections.push(s);
      return `Added ${docs.SECTION_TYPES[type]} to ${page.title}.`;
    }
    case 'remove_section': {
      const i = page.sections.findIndex((s) => s.type === op.type);
      if (i < 0) return `No ${op.type} section on ${page.title}.`;
      page.sections.splice(i, 1);
      return `Removed ${op.type} from ${page.title}.`;
    }
    case 'move_section': {
      const i = page.sections.findIndex((s) => s.type === op.type);
      const j = op.dir === 'up' ? i - 1 : op.dir === 'top' ? 0 : op.dir === 'bottom' ? page.sections.length - 1 : i + 1;
      if (i < 0 || j < 0 || j >= page.sections.length) return `Can't move that.`;
      const [s] = page.sections.splice(i, 1);
      page.sections.splice(j, 0, s);
      return `Moved ${op.type} ${op.dir}.`;
    }
    case 'add_page': {
      const title = String(op.title || '').slice(0, 60);
      if (!title) return null;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
      if (doc.pages.some((p) => p.slug === slug)) return `There is already a ${title} page.`;
      doc.pages.push({ id: 'p' + docs.sid().slice(1), slug, title, nav: true, sections: [docs.sectionFor('text', d)], meta: {} });
      doc.pages.at(-1).sections[0].data.heading = title;
      return `Added the ${title} page.`;
    }
    case 'remove_page': {
      const p = findPage(doc, op.title, null);
      if (!p || p === doc.pages[0]) return `Can't remove that page.`;
      doc.pages.splice(doc.pages.indexOf(p), 1);
      return `Removed the ${p.title} page. (Undo brings it back.)`;
    }
    case 'add_item': {
      const type = op.type;
      if (!['services', 'pricing', 'menu', 'faq', 'reviews'].includes(type)) return null;
      if (type === 'reviews' && !op.attestedReal) return 'Reviews must be real. Use: add real review Name | Where it came from | What they said';
      const s = ensure(page, type, d);
      const it = op.item || {};
      if (type === 'reviews') {
        s.data.items.push({ name: it.name || '', text: it.text || '', source: it.source || '', date: it.date || '', attestedReal: true });
      } else if (type === 'faq') s.data.items.push({ q: it.q || '', a: it.a || '' });
      else s.data.items.push({ name: it.name || '', price: it.price || '', text: it.text || '' });
      return `Added to ${docs.SECTION_TYPES[type]}.`;
    }
    case 'set_text': {
      const s = sectionOn(page, op.type || 'hero') || ensure(page, op.type || 'hero', d);
      if (!(op.field in s.data)) return null;
      s.data[op.field] = String(op.value || '');
      return `Updated ${op.type || 'hero'} ${op.field}.`;
    }
    case 'mode': doc.theme.mode = op.mode; return `Site color mode: ${op.mode}.`;
    case 'template': doc.template = op.id; return `Switched to the ${op.name} template. Your content stayed the same.`;
    case 'accent': {
      const c = doc.theme.colors || { light: null, dark: null };
      const t = ctx.template.theme;
      c.light = { ...(c.light || { bg: t.light[0], fg: t.light[1], card: t.light[3] }), acc: op.color };
      c.dark = c.dark || { bg: t.dark[0], fg: t.dark[1], acc: t.dark[2], card: t.dark[3] };
      doc.theme.colors = c;
      return `Accent color set to ${op.color}. (Adjusted automatically if needed for readability.)`;
    }
    default: return null;
  }
}

const HELP = `Things you can say:
• add gallery / add faq / add map / add pricing / add quote form / add booking form
• remove gallery · move faq up · move map to top
• add page Team · remove page Team
• add service Oil change
• add price Haircut - $25 · add menu item Croissant - $3.50
• add faq Do you deliver? Yes, within 10 miles.
• add real review Maria | Google review | Great service!
• change heading to ... · change tagline to ...
• use template salon · dark mode · light mode · accent #0055aa
Tap any text in the preview to edit it. Tap an image to change it.`;

function parse(msg, ctx) {
  const m = msg.trim();
  let r;
  if (/^(help|\?)$/i.test(m)) return { help: true };
  if ((r = m.match(/^add (quote|booking|contact) form$/i))) return [{ op: 'add_section', type: 'form', kind: r[1].toLowerCase() }];
  if ((r = m.match(/^add page (.+)$/i))) return [{ op: 'add_page', title: r[1] }];
  if ((r = m.match(/^remove page (.+)$/i))) return [{ op: 'remove_page', title: r[1] }];
  if ((r = m.match(/^add service (.+)$/i))) return [{ op: 'add_item', type: 'services', item: { name: r[1] } }];
  if ((r = m.match(/^add (price|menu item) (.+?)\s+[-–]\s+(\$?\d[\d.,]*)\s*(.*)$/i))) return [{ op: 'add_item', type: r[1].toLowerCase() === 'price' ? 'pricing' : 'menu', item: { name: r[2], price: r[3], text: r[4] } }];
  if ((r = m.match(/^add faq (.+?\?)\s*(.+)$/i))) return [{ op: 'add_item', type: 'faq', item: { q: r[1], a: r[2] } }];
  if ((r = m.match(/^add real review (.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/i))) return [{ op: 'add_item', type: 'reviews', attestedReal: true, item: { name: r[1], source: r[2], text: r[3] } }];
  if (/^add review/i.test(m)) return [{ op: 'add_item', type: 'reviews', attestedReal: false }];
  if ((r = m.match(/^(?:change|set) (heading|title|tagline) to (.+)$/i))) return [{ op: 'set_text', type: 'hero', field: r[1].toLowerCase() === 'tagline' ? 'text' : 'heading', value: r[2] }];
  if ((r = m.match(/^(dark|light|auto) mode$/i))) return [{ op: 'mode', mode: r[1].toLowerCase() }];
  if ((r = m.match(/^accent (#[0-9a-f]{6})$/i))) return [{ op: 'accent', color: r[1].toLowerCase() }];
  if ((r = m.match(/^(?:use|switch to) (?:the )?(.+?) template$|^use template (.+)$/i))) {
    const want = (r[1] || r[2]).toLowerCase();
    const t = ctx.allTemplates.find((x) => x.id === want || x.name.toLowerCase().includes(want));
    return t ? [{ op: 'template', id: t.id, name: t.name }] : { reply: `No template called "${want}". Try: ${ctx.allTemplates.map((x) => x.id).join(', ')}.` };
  }
  if ((r = m.match(/^(add|remove) (.+?)(?: (?:to|from|on) (?:the )?(.+?) page)?$/i))) {
    const type = typeOf(r[2]);
    if (type) return [{ op: r[1].toLowerCase() === 'add' ? 'add_section' : 'remove_section', type, page: r[3] }];
  }
  if ((r = m.match(/^move (.+?) (up|down|to top|to bottom)$/i))) {
    const type = typeOf(r[1]);
    if (type) return [{ op: 'move_section', type, dir: r[2].replace('to ', '').toLowerCase() }];
  }
  return null;
}

const AI_OPS = new Set(['add_section', 'remove_section', 'move_section', 'add_page', 'set_text', 'add_item', 'mode']);
// Returns { reply, doc|null }
async function chat({ member, site, doc, pageId, message }) {
  const ctx = {
    details: { menu: [], faqs: [], ...site.details },
    page: doc.pages.find((p) => p.id === pageId) || doc.pages[0],
    allTemplates: await templates.allTemplates(),
    template: await templates.getTemplate(doc.template),
  };
  const next = structuredClone(doc);
  let ops = parse(String(message || '').slice(0, 1000), ctx);
  if (ops?.help) return { reply: HELP, doc: null };
  if (ops?.reply) return { reply: ops.reply, doc: null };
  let aiReply = '';
  if (!ops) {
    const r = await ai.text({
      memberId: member.id, task: 'builder-chat', json: true,
      system: 'You edit a small-business website by returning JSON operations. Only use words the member gave you or that already exist on the site. Never invent prices, reviews, awards, credentials, phone numbers or facts.',
      prompt: `Allowed ops: add_section{type,page?,heading?,text?}, remove_section{type,page?}, move_section{type,dir:up|down|top|bottom}, add_page{title}, set_text{type,field:heading|text,value}, add_item{type:services|pricing|menu|faq,item}, mode{mode}.
Section types: ${Object.keys(docs.SECTION_TYPES).join(', ')}. Pages: ${doc.pages.map((p) => p.title).join(', ')}. Current page: ${ctx.page.title}.
Site content:\n${docs.docText(doc).slice(0, 6000)}\n\nMember says: ${message}\n\nReturn {"reply":"short friendly answer","ops":[...]}. If the request needs facts you don't have, ask the member for them in reply and return no ops.`,
    });
    if (!r.ok) return { reply: r.reason === 'AI: Not connected' ? `AI chat: Not connected. Plain commands still work.\n\n${HELP}` : r.reason, doc: null };
    ops = (Array.isArray(r.data.ops) ? r.data.ops : []).filter((o) => o && typeof o === 'object' && AI_OPS.has(o.op) && !(o.op === 'add_item' && o.type === 'reviews')).slice(0, 10);
    aiReply = String(r.data.reply || '').slice(0, 600);
  }
  const said = ops.map((o) => apply(next, o, ctx)).filter(Boolean);
  if (JSON.stringify(next) === JSON.stringify(doc)) return { reply: said.join('\n') || aiReply || `I didn't change anything. Say "help" to see what I can do.`, doc: null };
  if (!said.length) return { reply: aiReply || `I didn't change anything. Say "help" to see what I can do.`, doc: null };
  return { reply: [aiReply, ...said].filter(Boolean).join('\n'), doc: docs.clean(next) };
}

module.exports = { chat, parse, apply, HELP };
