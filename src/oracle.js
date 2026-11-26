// The Oracle: one record of who did what, when. Members, sites, payments, bots.
const { store } = require('./store');

async function oracle(who, what, details = {}) {
  const entry = { who: who || 'system', what, details, when: new Date().toISOString() };
  await store.add('oracle', entry);
  return entry;
}

async function recent(limit = 100) {
  return store.all('oracle', { orderBy: 'when', desc: true, limit });
}

module.exports = { oracle, recent };
