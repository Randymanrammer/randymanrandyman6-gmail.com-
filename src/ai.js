// All AI runs here, on the server (item 60). Keys never reach the browser.
// Item 59: monthly allowance per member, counted in "AI credits":
//   1 credit per text request, 10 per image. Default 300 credits/month.
// Missing GEMINI_API_KEY -> every AI feature says "AI: Not connected".
const config = require('./config');
const { store } = require('./store');
const { oracle } = require('./oracle');

const BASE = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const IMAGE_MODEL = () => process.env.IMAGEN_MODEL || 'imagen-4.0-generate-001';
const ALLOWANCE = () => Number(process.env.AI_MONTHLY_CREDITS || 300);
// Rough cost per call for the cost watchdog (USD); adjustable without code changes.
const COST = { text: Number(process.env.AI_COST_TEXT_USD || 0.002), image: Number(process.env.AI_COST_IMAGE_USD || 0.04) };

const month = (d = new Date()) => d.toISOString().slice(0, 7);
const connected = () => config.has('GEMINI_API_KEY');

async function usage(memberId, m = month()) {
  const u = await store.get('ai_usage', `${memberId}_${m}`);
  return { used: u?.credits || 0, allowance: ALLOWANCE(), month: m };
}
async function charge(memberId, kind, credits) {
  const id = `${memberId}_${month()}`;
  const cur = await store.get('ai_usage', id);
  const row = { memberId, month: month(), credits: (cur?.credits || 0) + credits, calls: (cur?.calls || 0) + 1, costUsd: +((cur?.costUsd || 0) + COST[kind]).toFixed(4) };
  await store.set('ai_usage', id, row);
}

async function call(path, body) {
  const r = await fetch(`${BASE()}/v1beta/models/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.secret('GEMINI_API_KEY') },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw Object.assign(new Error(`AI service error ${r.status}`), { status: 502 });
  return r.json();
}

const RULES = 'Rules: Use ONLY facts given to you. Never invent facts, numbers, prices, reviews, awards, credentials or testimonials. If something is unknown, leave it out. Plain text, no markdown, no HTML.';

// kind: 'text'. Returns { ok, text, data, reason }
async function text({ memberId, task, prompt, json = false, system = '' }) {
  if (!connected()) return { ok: false, reason: 'AI: Not connected' };
  if (memberId) {
    const u = await usage(memberId);
    if (u.used + 1 > u.allowance) return { ok: false, reason: `Monthly AI allowance used (${u.used} of ${u.allowance}). It resets on the 1st.` };
  }
  try {
    const out = await call(`${MODEL()}:generateContent`, {
      systemInstruction: { parts: [{ text: `${system}\n${RULES}`.trim() }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048, ...(json ? { responseMimeType: 'application/json' } : {}) },
    });
    const t = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (memberId) await charge(memberId, 'text', 1);
    await oracle(memberId ? 'member:' + memberId : 'system', 'ai.used', { task, credits: memberId ? 1 : 0 });
    if (json) { try { return { ok: true, data: JSON.parse(t) }; } catch { return { ok: false, reason: 'AI gave an unreadable answer. Try again.' }; } }
    return { ok: true, text: t };
  } catch (e) {
    return { ok: false, reason: e.status ? e.message : 'AI is not reachable right now.' };
  }
}

// Item 53: Imagen. Returns { ok, bytes(Buffer), mime }
async function image({ memberId, prompt }) {
  if (!connected()) return { ok: false, reason: 'AI: Not connected' };
  const u = await usage(memberId);
  if (u.used + 10 > u.allowance) return { ok: false, reason: `Monthly AI allowance used (${u.used} of ${u.allowance}).` };
  try {
    const out = await call(`${IMAGE_MODEL()}:predict`, { instances: [{ prompt: `${prompt}. No text, no logos, no real people, no brand marks.` }], parameters: { sampleCount: 1, aspectRatio: '16:9' } });
    const b64 = out.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return { ok: false, reason: 'No image came back. Try a different description.' };
    await charge(memberId, 'image', 10);
    await oracle('member:' + memberId, 'ai.used', { task: 'image', credits: 10 });
    return { ok: true, bytes: Buffer.from(b64, 'base64'), mime: out.predictions[0].mimeType || 'image/png' };
  } catch (e) {
    return { ok: false, reason: e.status ? e.message : 'AI is not reachable right now.' };
  }
}

async function monthSpend(m = month()) {
  const rows = (await store.all('ai_usage')).filter((r) => r.month === m);
  return { usd: +rows.reduce((a, r) => a + (r.costUsd || 0), 0).toFixed(2), calls: rows.reduce((a, r) => a + (r.calls || 0), 0) };
}

module.exports = { connected, text, image, usage, monthSpend, ALLOWANCE };
