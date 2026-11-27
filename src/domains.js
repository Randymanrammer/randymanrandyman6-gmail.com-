// Item 44: custom domains. Shows "Coming soon" until LB_IP (the load
// balancer's IP from deploy script 3) is set. Verification checks the
// domain's DNS A record points at LB_IP. When CERT_MAP is set and the app
// runs on Google Cloud, it asks Certificate Manager for a free, auto-renewing
// Google-managed certificate for the domain (item 45).
const dns = require('dns').promises;
const { store } = require('./store');
const { oracle } = require('./oracle');

const lbIp = () => process.env.LB_IP || '';
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalize(h) { return String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, ''); }

async function add(member, site, hostRaw) {
  const host = normalize(hostRaw);
  const cfg = require('./config');
  if (!HOST_RE.test(host) || host.endsWith('.' + cfg.domain) || host === cfg.domain) throw Object.assign(new Error('Enter a domain you own, like mybakery.com'), { status: 400 });
  const taken = (await store.where('domains', 'host', host)).find((d) => d.status !== 'removed');
  if (taken && taken.siteId !== site.id) throw Object.assign(new Error('That domain is already connected to another site.'), { status: 409 });
  if (taken) return taken;
  const id = await store.add('domains', { host, siteId: site.id, memberId: member.id, status: 'pending', at: new Date().toISOString() });
  await oracle(member.email, 'domain.added', { site: site.id, host });
  return store.get('domains', id);
}

async function verify(d, resolver = dns.resolve4) {
  if (!lbIp()) return { ok: false, msg: 'Custom domains are coming soon.' };
  let ips = [];
  try { ips = await resolver(d.host); } catch { ips = []; }
  if (!ips.includes(lbIp())) return { ok: false, msg: `Not yet. ${d.host} points to ${ips.join(', ') || 'nothing'}; it needs ${lbIp()}. DNS changes can take up to a few hours.` };
  await store.update('domains', d.id, { status: 'verified', verifiedAt: new Date().toISOString() });
  await oracle('system', 'domain.verified', { host: d.host, site: d.siteId });
  const cert = await requestCert(d.host).catch((e) => ({ ok: false, error: e.message }));
  await store.update('domains', d.id, { cert });
  return { ok: true, msg: cert.ok ? 'Connected! HTTPS is being set up and can take up to an hour.' : 'Connected! HTTPS setup is waiting on the owner (it will be turned on for you).' };
}

async function token() {
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('no metadata token');
  return (await r.json()).access_token;
}
async function requestCert(host) {
  const map = process.env.CERT_MAP; const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!map || !project) return { ok: false, error: 'CERT_MAP not set' };
  const t = await token();
  const id = 'ios-' + host.replace(/[^a-z0-9]/g, '-').slice(0, 55);
  const base = `https://certificatemanager.googleapis.com/v1/projects/${project}/locations/global`;
  const h = { Authorization: `Bearer ${t}`, 'content-type': 'application/json' };
  const c = await fetch(`${base}/certificates?certificateId=${id}`, { method: 'POST', headers: h, body: JSON.stringify({ managed: { domains: [host] } }) });
  const e = await fetch(`${base}/certificateMaps/${map}/certificateMapEntries?certificateMapEntryId=${id}`, { method: 'POST', headers: h, body: JSON.stringify({ hostname: host, certificates: [`projects/${project}/locations/global/certificates/${id}`] }) });
  return { ok: (c.ok || c.status === 409) && (e.ok || e.status === 409), cert: id };
}

module.exports = { add, verify, lbIp, normalize };
