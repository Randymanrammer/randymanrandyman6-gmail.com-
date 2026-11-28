// Item 31: 10 starter templates. Item 36: every template has light + dark colors.
// Item 34: each has "Sample" demo content used ONLY on the labeled demo page,
// never copied into a member's site (members' sites use their real details).
// Item 40: the owner can add more from the owner console (stored in Firestore
// "templates"); those are merged with these built-ins.
const { store } = require('./store');

const T = (id, name, industry, light, dark, fonts, sections, extraPages, sample) => ({
  id, name, industry, builtIn: true,
  theme: { light, dark, headingFont: fonts[0], bodyFont: fonts[1], radius: fonts[2] ?? 12 },
  sections, extraPages, sample,
});

// colors: [bg, fg, accent, card]
const BUILT_IN = [
  T('bakery', 'Bakery & Restaurant', 'Food', ['#fffaf3', '#2b1d12', '#b4471b', '#f6ead9'], ['#17110c', '#f5ebe0', '#ff8a5c', '#241a12'], ['Playfair Display', 'Lato', 16],
    ['hero', 'about', 'services', 'gallery', 'hours', 'map', 'contact'], ['menu', 'faq'],
    { businessName: 'Sample Bakery', tagline: 'Sample text: fresh bread every morning', services: ['Sample: sourdough', 'Sample: pastries', 'Sample: custom cakes'] }),
  T('dental', 'Dental Clinic', 'Health', ['#f7fbff', '#0f2233', '#0b72b9', '#e8f2fb'], ['#0b141c', '#e7f0f8', '#5bb4f5', '#13212d'], ['Montserrat', 'Open Sans', 14],
    ['hero', 'services', 'about', 'faq', 'hours', 'map', 'contact'], ['booking', 'faq'],
    { businessName: 'Sample Dental', tagline: 'Sample text: gentle family dentistry', services: ['Sample: cleanings', 'Sample: whitening', 'Sample: crowns'] }),
  T('freight', 'Freight & Logistics', 'Transport', ['#f6f7f9', '#111418', '#d35400', '#e9ecf0'], ['#0d0f12', '#eceff3', '#ff8f3d', '#181c22'], ['Oswald', 'Roboto', 6],
    ['hero', 'services', 'about', 'pricing', 'contact'], ['faq'],
    { businessName: 'Sample Freight Co.', tagline: 'Sample text: regional and long-haul shipping', services: ['Sample: full truckload', 'Sample: LTL', 'Sample: warehousing'] }),
  T('detailing', 'Auto Detailing', 'Automotive', ['#f8f8f8', '#141414', '#c8102e', '#ececec'], ['#0c0c0c', '#f0f0f0', '#ff4d64', '#1a1a1a'], ['Bebas Neue', 'Inter', 8],
    ['hero', 'services', 'pricing', 'gallery', 'contact'], ['booking', 'faq'],
    { businessName: 'Sample Detailing', tagline: 'Sample text: showroom shine, mobile service', services: ['Sample: interior detail', 'Sample: ceramic coating', 'Sample: paint correction'] }),
  T('advisory', 'Advisory & Consulting', 'Professional', ['#fbfbfd', '#16181d', '#3a4fb0', '#eef0f7'], ['#0e0f13', '#eceef4', '#8b9cff', '#181a22'], ['Merriweather', 'Source Sans 3', 10],
    ['hero', 'about', 'services', 'faq', 'contact'], ['faq'],
    { businessName: 'Sample Advisors', tagline: 'Sample text: clear advice for growing businesses', services: ['Sample: strategy', 'Sample: operations', 'Sample: finance'] }),
  T('salon', 'Salon & Barber', 'Beauty', ['#fff8fa', '#2a1620', '#a8326e', '#f7e6ee'], ['#160c11', '#f6e9ef', '#ff7ab8', '#24141c'], ['DM Serif Display', 'Nunito', 20],
    ['hero', 'services', 'pricing', 'gallery', 'hours', 'contact'], ['booking', 'faq'],
    { businessName: 'Sample Salon', tagline: 'Sample text: cuts, color and shaves', services: ['Sample: haircut', 'Sample: color', 'Sample: beard trim'] }),
  T('home', 'Home Services', 'Trades', ['#f7faf7', '#132015', '#2e7d32', '#e6f0e7'], ['#0c120d', '#e8f1e9', '#72d077', '#172119'], ['Poppins', 'Roboto', 12],
    ['hero', 'services', 'about', 'faq', 'contact'], ['faq'],
    { businessName: 'Sample Home Pros', tagline: 'Sample text: plumbing, electrical and repairs', services: ['Sample: repairs', 'Sample: installs', 'Sample: inspections'] }),
  T('realestate', 'Real Estate', 'Property', ['#fbfaf7', '#1b1a17', '#8a6d1f', '#f1ede2'], ['#11100d', '#f1eee6', '#e0bb57', '#1d1b16'], ['Cormorant Garamond', 'Work Sans', 4],
    ['hero', 'about', 'gallery', 'services', 'contact'], ['faq'],
    { businessName: 'Sample Realty', tagline: 'Sample text: buying and selling, made simple', services: ['Sample: buyer representation', 'Sample: listings', 'Sample: home valuations'] }),
  T('fitness', 'Fitness', 'Health', ['#f8fafc', '#0f141a', '#e4572e', '#eaeff4'], ['#0a0d11', '#edf1f5', '#ff7b54', '#151a21'], ['Archivo Black', 'Inter', 14],
    ['hero', 'services', 'pricing', 'hours', 'contact'], ['booking', 'faq'],
    { businessName: 'Sample Fitness', tagline: 'Sample text: classes and personal training', services: ['Sample: group classes', 'Sample: personal training', 'Sample: open gym'] }),
  T('retail', 'Retail Shop', 'Retail', ['#fdfcfb', '#1c1917', '#7c3aed', '#f3f0fb'], ['#110f0e', '#f1efed', '#b694ff', '#1c1924'], ['Rubik', 'Karla', 12],
    ['hero', 'about', 'gallery', 'hours', 'map', 'contact'], ['faq'],
    { businessName: 'Sample Shop', tagline: 'Sample text: local goods and gifts', services: ['Sample: gifts', 'Sample: home goods', 'Sample: local makers'] }),
];

// Item 32: 5 skins for the builder's own look (not member sites).
const SKINS = {
  classic: { name: 'Classic', bg: '#f7f8fb', fg: '#12151c', acc: '#0a66c2', card: '#ffffff', line: '#e3e6ee' },
  midnight: { name: 'Midnight', bg: '#0e1015', fg: '#eceef3', acc: '#4ea1ff', card: '#171a21', line: '#2a2f3a' },
  forest: { name: 'Forest', bg: '#f3f7f2', fg: '#13201a', acc: '#2e7d32', card: '#ffffff', line: '#d6e3d4' },
  sunset: { name: 'Sunset', bg: '#fff7f2', fg: '#2a160d', acc: '#c2410c', card: '#ffffff', line: '#f1dccd' },
  contrast: { name: 'High contrast', bg: '#ffffff', fg: '#000000', acc: '#0000c8', card: '#ffffff', line: '#000000' },
};

const FONTS = ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Work Sans', 'Karla', 'Rubik', 'Source Sans 3',
  'Playfair Display', 'Merriweather', 'DM Serif Display', 'Cormorant Garamond', 'Oswald', 'Bebas Neue', 'Archivo Black', 'system-ui'];

// Item 39: built-ins are offered only after they pass the Governor (checked once per process).
let builtInOk = null;
async function checkedBuiltIns() {
  if (builtInOk) return builtInOk;
  const governor = require('./governor');
  const { demoDoc } = require('./routes/builder');
  const ok = [];
  for (const t of BUILT_IN) { const { d, doc } = demoDoc(t); if ((await governor.check({ details: d }, doc, { template: t })).pass) ok.push(t); }
  builtInOk = ok;
  return ok;
}

async function allTemplates({ includeUnapproved = false } = {}) {
  const base = includeUnapproved ? BUILT_IN : await checkedBuiltIns();
  let custom = [];
  try { custom = await store.all('templates'); } catch { custom = []; }
  const ok = custom.filter((t) => includeUnapproved || t.governor?.pass);
  return [...base, ...ok];
}
async function getTemplate(id) {
  return (await allTemplates({ includeUnapproved: true })).find((t) => t.id === id) || BUILT_IN.find((t) => t.id === 'advisory');
}

module.exports = { BUILT_IN, SKINS, FONTS, allTemplates, getTemplate, checkedBuiltIns };
