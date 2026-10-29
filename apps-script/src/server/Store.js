// Tables kept as tabs of a Google Sheet: one row per record, one column per
// field. Columns are found by their header name, so a newer version can add
// fields (they are appended at the end) without moving anything that is
// already there. JSON fields are split over several columns (name#1, name#2,
// ...) because a cell holds at most 50,000 characters.

const SCHEMAS = {
  students: ['id', 'name', 'className', 'readAloud:bool', 'voiceAnswers:bool', 'extraTimePct:num', 'createdAt:num'],
  teachers: ['id', 'name', 'addedAt:num'],
  classes: ['id', 'ownerId', 'name', 'joinCode', 'joinMode', 'classroomId', 'createdAt:num'],
  members: ['id', 'classId', 'studentId', 'status', 'addedAt:num'],
  tests: ['id', 'ownerId', 'title', 'status', 'updatedAt:num', 'data:json:8', 'sharedWith'],
  attempts: [
    'id', 'testId', 'studentId', 'status', 'startedAt:num', 'deadlineAt:num', 'submittedAt:num', 'submitReason',
    'score:num', 'maxScore:num', 'returnedAt:num', 'clientId', 'violations:num', 'feedback',
    'answers:json:4', 'grading:json:2', 'snapshot:json:8',
  ],
  events: ['id', 'attemptId', 'at:num', 'type', 'detail', 'counted:bool'],
  recordings: ['id', 'attemptId', 'questionId', 'fileId', 'mime', 'size:num', 'duration:num', 'createdAt:num'],
  // Natural-voice read-aloud audio: id = hash of voice + text; parts = [{ fileId, mime }].
  audio: ['id', 'provider', 'voice', 'chars:num', 'createdAt:num', 'parts:json:1'],
};
const JSON_CHUNK = 45000;

function parseSchema(spec) {
  return spec.map((s) => {
    const [name, type = 'str', n] = s.split(':');
    const width = type === 'json' ? Number(n) : 1;
    const headers = [];
    for (let i = 1; i <= width; i++) headers.push(width > 1 || type === 'json' ? `${name}#${i}` : name);
    return { name, type, width, headers };
  });
}

const PARSED = {};
for (const t of Object.keys(SCHEMAS)) PARSED[t] = parseSchema(SCHEMAS[t]);

function newId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function encodeField(f, v) {
  if (f.type === 'json') {
    const s = v === undefined || v === null ? '' : JSON.stringify(v);
    if (s.length > JSON_CHUNK * f.width) throw new HttpError(413, `Too much data in ${f.name}. Make the test shorter or split it.`);
    const out = [];
    for (let i = 0; i < f.width; i++) out.push(s.slice(i * JSON_CHUNK, (i + 1) * JSON_CHUNK));
    return out;
  }
  if (v === undefined || v === null) return [''];
  if (f.type === 'bool') return [v ? true : false];
  if (f.type === 'num') return [Number(v)];
  return [String(v)];
}

function decodeField(f, cells) {
  if (f.type === 'json') {
    const s = cells.map((c) => (c === undefined || c === null ? '' : String(c))).join('');
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }
  const v = cells[0];
  if (f.type === 'bool') return v === true || v === 'TRUE' || v === 'true';
  if (f.type === 'num') return v === '' || v === null || v === undefined ? null : Number(v);
  return v === null || v === undefined ? '' : String(v);
}

class SheetStore {
  // headerCache (optional): remembers each tab's header row between requests
  // (Apps Script's CacheService), saving two Sheets calls per tab. Its keys
  // must change whenever the code changes, since a new version may add columns.
  constructor(ss, headerCache) {
    this.ss = ss;
    this.layouts = {};
    this.cache = {};
    this.headerCache = headerCache || null;
    this.cachedHeaders = null;
  }

  cachedHeader(table) {
    if (!this.headerCache) return null;
    if (!this.cachedHeaders) {
      try {
        this.cachedHeaders = this.headerCache.getAll(Object.keys(SCHEMAS)) || {};
      } catch (e) {
        this.cachedHeaders = {};
      }
    }
    const v = this.cachedHeaders[table];
    try {
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  }

  // Where each field lives in this table's tab. Creates the tab, and any
  // missing columns (appended at the end), the first time it's needed.
  layout(table) {
    if (this.layouts[table]) return this.layouts[table];
    const fields = PARSED[table];
    let sh = this.ss.getSheetByName(table);
    let header = null;
    let fromCache = false;
    if (!sh) {
      sh = this.ss.insertSheet(table);
      sh.setFrozenRows(1);
      header = [];
    } else {
      // A cached header is only trusted if it already has every column.
      const cached = this.cachedHeader(table);
      if (cached && fields.every((f) => f.headers.every((n) => cached.indexOf(n) >= 0 || (f.type === 'json' && f.width === 1 && cached.indexOf(f.name) >= 0)))) {
        header = cached;
        fromCache = true;
      }
    }
    if (!header) {
      const lastCol = sh.getLastColumn();
      header = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    }
    const at = {};
    header.forEach((name, i) => {
      if (name && !(name in at)) at[name] = i + 1;
    });
    // A one-column JSON field was headed plain "name" before this version.
    for (const f of fields) if (f.type === 'json' && f.width === 1 && !(f.headers[0] in at) && f.name in at) at[f.headers[0]] = at[f.name];
    const missing = [];
    for (const f of fields) for (const name of f.headers) if (!(name in at)) missing.push({ f, name });
    if (missing.length) {
      const first = header.length + 1;
      const need = header.length + missing.length;
      if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
      sh.getRange(1, first, 1, missing.length).setValues([missing.map((m) => m.name)]).setFontWeight('bold');
      missing.forEach((m, i) => {
        at[m.name] = first + i;
        // Plain text, so Sheets never turns a class like "10-3" into a date.
        if (m.f.type === 'str' || m.f.type === 'json') sh.getRange(1, first + i, sh.getMaxRows(), 1).setNumberFormat('@');
      });
    }
    if (this.headerCache) {
      const full = header.concat(missing.map((m) => m.name));
      try {
        this.headerCache.put(table, JSON.stringify(full));
      } catch (e) {
        // The cache is only a speed-up.
      }
    }
    const cols = {};
    for (const f of fields) cols[f.name] = f.headers.map((n) => at[n]);
    const lightCols = fields.filter((f) => f.type !== 'json').map((f) => cols[f.name][0]);
    const width = Math.max(header.length + missing.length, 1);
    const l = { sh, fields, cols, width, lightWidth: Math.max(...lightCols), idCol: cols.id[0], fromCache, header: header.concat(missing.map((m) => m.name)) };
    this.layouts[table] = l;
    return l;
  }

  sheet(table) {
    return this.layout(table).sh;
  }

  // Before writing, make sure a cached header still matches the sheet (in
  // case someone moved columns by hand); if not, map the columns again.
  fresh(table) {
    const l = this.layout(table);
    if (!l.fromCache) return l;
    const lastCol = l.sh.getLastColumn();
    const real = lastCol > 0 ? l.sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    if (real.length === l.header.length && real.every((x, i) => x === l.header[i])) {
      l.fromCache = false;
      return l;
    }
    delete this.layouts[table];
    this.cachedHeaders = Object.assign({}, this.cachedHeaders, { [table]: JSON.stringify(real) });
    const saved = this.headerCache;
    this.headerCache = null; // map from the sheet itself this time
    try {
      return this.layout(table);
    } finally {
      this.headerCache = saved;
      try {
        if (saved) saved.put(table, JSON.stringify(this.layouts[table].header));
      } catch (e) {}
    }
  }

  rowToObject(table, row, light) {
    const l = this.layout(table);
    const obj = {};
    for (const f of l.fields) {
      if (light && f.type === 'json') continue;
      obj[f.name] = decodeField(f, l.cols[f.name].map((c) => row[c - 1]));
    }
    return obj;
  }

  objectToRow(table, obj) {
    const l = this.layout(table);
    const row = new Array(l.width).fill('');
    for (const f of l.fields) {
      const cells = encodeField(f, obj[f.name]);
      l.cols[f.name].forEach((c, i) => (row[c - 1] = cells[i]));
    }
    return row;
  }

  // light = skip the JSON columns (much faster for big tables).
  all(table, light) {
    const key = table + (light ? ':light' : '');
    if (this.cache[key]) return this.cache[key];
    const l = this.layout(table);
    const n = l.sh.getLastRow() - 1;
    const width = light ? l.lightWidth : l.width;
    const rows = n > 0 ? l.sh.getRange(2, 1, n, width).getValues() : [];
    const out = rows.filter((r) => r[l.idCol - 1] !== '' && r[l.idCol - 1] !== null).map((r) => this.rowToObject(table, r, light));
    this.cache[key] = out;
    return out;
  }

  rowIndex(table, id) {
    const l = this.layout(table);
    const n = l.sh.getLastRow() - 1;
    if (n <= 0) return -1;
    const ids = l.sh.getRange(2, l.idCol, n, 1).getValues();
    for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
    return -1;
  }

  get(table, id) {
    const r = this.rowIndex(table, id);
    if (r < 0) return null;
    const l = this.layout(table);
    return this.rowToObject(table, l.sh.getRange(r, 1, 1, l.width).getValues()[0], false);
  }

  insert(table, obj) {
    const rec = Object.assign({}, obj, { id: obj.id || newId() });
    this.fresh(table).sh.appendRow(this.objectToRow(table, rec));
    this.cache = {};
    return rec;
  }

  // Writes only the given fields, so an autosave and a warning arriving at
  // the same moment never overwrite each other.
  update(table, id, fields) {
    this.fresh(table);
    const r = this.rowIndex(table, id);
    if (r < 0) throw new HttpError(404, 'Record not found.');
    const l = this.layout(table);
    for (const f of l.fields) {
      if (!(f.name in fields) || f.name === 'id') continue;
      const cells = encodeField(f, fields[f.name]);
      const cols = l.cols[f.name];
      const contiguous = cols.every((c, i) => c === cols[0] + i);
      if (contiguous) l.sh.getRange(r, cols[0], 1, cols.length).setValues([cells]);
      else cols.forEach((c, i) => l.sh.getRange(r, c, 1, 1).setValues([[cells[i]]]));
    }
    this.cache = {};
  }

  remove(table, id) {
    this.fresh(table);
    const r = this.rowIndex(table, id);
    if (r > 0) this.sheet(table).deleteRow(r);
    this.cache = {};
  }

  removeWhere(table, pred) {
    const l = this.fresh(table);
    const n = l.sh.getLastRow() - 1;
    if (n <= 0) return;
    const rows = l.sh.getRange(2, 1, n, l.lightWidth).getValues();
    for (let i = rows.length - 1; i >= 0; i--) if (pred(this.rowToObject(table, rows[i], true))) l.sh.deleteRow(i + 2);
    this.cache = {};
  }
}

if (typeof module !== 'undefined') module.exports = { SCHEMAS, PARSED, parseSchema, SheetStore, encodeField, decodeField };
