// Data store. Firestore on Cloud Run; in-memory only for local tests.
const crypto = require('crypto');
const config = require('./config');

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}

class MemoryStore {
  constructor() { this.cols = new Map(); }
  _c(col) { if (!this.cols.has(col)) this.cols.set(col, new Map()); return this.cols.get(col); }
  async get(col, id) { const d = this._c(col).get(id); return d ? structuredClone(d) : null; }
  async set(col, id, data) { this._c(col).set(id, structuredClone({ ...data, id })); return id; }
  async update(col, id, patch) {
    const cur = this._c(col).get(id);
    if (!cur) throw new Error(`not found: ${col}/${id}`);
    this._c(col).set(id, structuredClone({ ...cur, ...patch, id }));
  }
  async add(col, data) { const id = newId(col.slice(0, 3)); await this.set(col, id, data); return id; }
  // Create only if the id is free. Returns true if this call created it.
  async claim(col, id, data) { if (this._c(col).has(id)) return false; await this.set(col, id, data); return true; }
  async where(col, field, value) {
    return [...this._c(col).values()].filter((d) => d[field] === value).map((d) => structuredClone(d));
  }
  async all(col, { orderBy, desc, limit } = {}) {
    let rows = [...this._c(col).values()].map((d) => structuredClone(d));
    if (orderBy) rows.sort((a, b) => (a[orderBy] > b[orderBy] ? 1 : -1) * (desc ? -1 : 1));
    return limit ? rows.slice(0, limit) : rows;
  }
}

class FirestoreStore {
  constructor() {
    const { Firestore } = require('@google-cloud/firestore');
    this.db = new Firestore({ ignoreUndefinedProperties: true });
  }
  async get(col, id) { const s = await this.db.collection(col).doc(id).get(); return s.exists ? { ...s.data(), id } : null; }
  async set(col, id, data) { await this.db.collection(col).doc(id).set({ ...data, id }); return id; }
  async update(col, id, patch) { await this.db.collection(col).doc(id).update(patch); }
  async add(col, data) { const id = newId(col.slice(0, 3)); await this.set(col, id, data); return id; }
  // Create only if the id is free (atomic in Firestore). Returns true if this call created it.
  async claim(col, id, data) {
    try { await this.db.collection(col).doc(id).create({ ...data, id }); return true; } catch (e) { if (e.code === 6) return false; throw e; }
  }
  async where(col, field, value) {
    const q = await this.db.collection(col).where(field, '==', value).get();
    return q.docs.map((d) => ({ ...d.data(), id: d.id }));
  }
  async all(col, { orderBy, desc, limit } = {}) {
    let q = this.db.collection(col);
    if (orderBy) q = q.orderBy(orderBy, desc ? 'desc' : 'asc');
    if (limit) q = q.limit(limit);
    const r = await q.get();
    return r.docs.map((d) => ({ ...d.data(), id: d.id }));
  }
}

const store = config.store === 'firestore' ? new FirestoreStore() : new MemoryStore();
module.exports = { store, newId };
