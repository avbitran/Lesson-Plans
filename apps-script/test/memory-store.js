'use strict';
// In-memory stand-in for the Google Sheet (same interface as SheetStore).
const { PARSED } = require('../src/server/Store.js');

class MemoryStore {
  constructor() {
    this.tables = {};
    this.n = 0;
  }
  rows(t) {
    return (this.tables[t] ||= []);
  }
  strip(t, o, light) {
    const copy = structuredClone(o);
    if (light) for (const f of PARSED[t]) if (f.type === 'json') delete copy[f.name];
    return copy;
  }
  all(t, light) {
    return this.rows(t).map((o) => this.strip(t, o, light));
  }
  get(t, id) {
    const o = this.rows(t).find((x) => x.id === id);
    return o ? this.strip(t, o, false) : null;
  }
  insert(t, obj) {
    const rec = structuredClone({ ...obj, id: obj.id || `id${++this.n}` });
    this.rows(t).push(rec);
    return structuredClone(rec);
  }
  update(t, id, fields) {
    const o = this.rows(t).find((x) => x.id === id);
    if (!o) throw Object.assign(new Error('Record not found.'), { status: 404 });
    for (const k of Object.keys(fields)) if (PARSED[t].some((f) => f.name === k)) o[k] = structuredClone(fields[k]);
  }
  remove(t, id) {
    this.tables[t] = this.rows(t).filter((x) => x.id !== id);
  }
  removeWhere(t, pred) {
    this.tables[t] = this.rows(t).filter((x) => !pred(this.strip(t, x, true)));
  }
}

module.exports = { MemoryStore };
