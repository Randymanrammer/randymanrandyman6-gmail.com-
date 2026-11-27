// GitHub: item 30 (members export their site's code to their own GitHub) and
// item 98 (every published site saved to the owner's build-records repo).
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');
const render = require('./render');
const templates = require('./templates');

const API = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const RECORDS_REPO = () => process.env.BUILD_RECORDS_REPO || ''; // e.g. Randymanrammer/ios-build-records

async function gh(token, method, path, body) {
  const r = await fetch(API() + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'instant-online-success', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok && !(method === 'GET' && r.status === 404)) throw Object.assign(new Error(`GitHub ${r.status}: ${j.message || ''}`.trim()), { status: r.status });
  return { status: r.status, body: j };
}

// Static copy of a published site: one index.html per page + assets.
async function exportFiles(site, doc) {
  const template = await templates.getTemplate(doc.template);
  const files = [];
  const ids = new Set();
  JSON.stringify(doc).replace(/\/a\/([A-Za-z0-9_-]{4,40})/g, (_, id) => ids.add(id));
  for (const p of doc.pages) {
    const html = render.renderPage(site, doc, p, { base: '/', template, canonicalBase: '' });
    files.push({ path: p.slug ? `${p.slug}/index.html` : 'index.html', content: Buffer.from(html) });
  }
  for (const id of ids) {
    const a = await store.get('assets', id);
    if (a) files.push({ path: `a/${id}`, content: Buffer.from(a.data, 'base64') });
  }
  files.push({ path: 'README.md', content: Buffer.from(`# ${site.details?.businessName || site.slug}\n\nExported from ${config.brand}. Static HTML: open index.html or host on any static host.\n`) });
  return files;
}

async function putFiles(token, repo, files, message) {
  for (const f of files) {
    const path = `/repos/${repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const cur = await gh(token, 'GET', path);
    await gh(token, 'PUT', path, { message, content: f.content.toString('base64'), ...(cur.status === 200 && cur.body.sha ? { sha: cur.body.sha } : {}) });
  }
}

// Item 30 - member export to their own GitHub (their token, sealed at rest).
async function exportToMember(member, site, repoName) {
  if (!member.githubTokenBox) throw Object.assign(new Error('Connect your GitHub first.'), { status: 400 });
  const token = require('./secretbox').open(member.githubTokenBox);
  const me = await gh(token, 'GET', '/user');
  if (me.status !== 200) throw Object.assign(new Error('Your GitHub token did not work. Connect it again.'), { status: 400 });
  const name = String(repoName || site.slug).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 90);
  const repo = `${me.body.login}/${name}`;
  const exists = await gh(token, 'GET', `/repos/${repo}`);
  if (exists.status === 404) await gh(token, 'POST', '/user/repos', { name, private: true, description: `Website: ${site.details?.businessName || site.slug}` });
  const doc = site.publishedDoc || site.doc;
  await putFiles(token, repo, await exportFiles(site, doc), `Export from ${config.brand}`);
  await oracle(member.email, 'site.exported.github', { site: site.id, repo });
  return repo;
}

// Item 98 - owner's build-records repo (GITHUB_TOKEN + BUILD_RECORDS_REPO).
async function recordBuild(site, doc) {
  const token = config.secret('GITHUB_TOKEN');
  if (!token || !RECORDS_REPO()) return { skipped: 'not connected' };
  const day = new Date().toISOString().slice(0, 10);
  const files = (await exportFiles(site, doc)).filter((f) => !f.path.startsWith('a/')).map((f) => ({ ...f, path: `sites/${site.slug}/${f.path}` }));
  files.push({ path: `sites/${site.slug}/site.json`, content: Buffer.from(JSON.stringify({ site: site.id, slug: site.slug, publishedAt: new Date().toISOString(), doc }, null, 1)) });
  await putFiles(token, RECORDS_REPO(), files, `Publish ${site.slug} ${day}`);
  await oracle('system', 'buildrecord.saved', { site: site.id, repo: RECORDS_REPO() });
  return { saved: true };
}

module.exports = { exportFiles, exportToMember, recordBuild, RECORDS_REPO };
