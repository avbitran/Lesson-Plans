// Tables kept as tabs of a Google Sheet. One row per record, one column per
// field. JSON fields come last and are split over several columns because a
// cell holds at most 50,000 characters.

const SCHEMAS = {
  students: ['id', 'name', 'className', 'readAloud:bool', 'voiceAnswers:bool', 'extraTimePct:num'],
  teachers: ['id'],
  tests: ['id', 'ownerId', 'title', 'status', 'updatedAt:num', 'data:json:8'],
  attempts: [
    'id', 'testId', 'studentId', 'status', 'startedAt:num', 'deadlineAt:num', 'submittedAt:num', 'submitReason',
    'score:num', 'maxScore:num', 'returnedAt:num', 'clientId', 'violations:num', 'feedback',
    'answers:json:4', 'grading:json:2', 'snapshot:json:8',
  ],
  events: ['id', 'attemptId', 'at:num', 'type', 'detail', 'counted:bool'],
  recordings: ['id', 'attemptId', 'questionId', 'fileId', 'mime', 'size:num', 'duration:num', 'createdAt:num'],
};
const JSON_CHUNK = 45000;

function parseSchema(spec) {
  const fields = [];
  let col = 1;
  for (const s of spec) {
    const [name, type = 'str', n] = s.split(':');
    const width = type === 'json' ? Number(n) : 1;
    fields.push({ name, type, col, width });
    col += width;
  }
  const light = fields.filter((f) => f.type !== 'json');
  return { fields, width: col - 1, lightWidth: light.length ? light[light.length - 1].col : 0 };
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
    const s = cells.join('');
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }
  const v = cells[0];
  if (f.type === 'bool') return v === true || v === 'TRUE' || v === 'true';
  if (f.type === 'num') return v === '' || v === null ? null : Number(v);
  return v === null || v === undefined ? '' : String(v);
}

class SheetStore {
  constructor(ss) {
    this.ss = ss;
    this.sheets = {};
    this.cache = {};
  }

  sheet(table) {
    if (this.sheets[table]) return this.sheets[table];
    const schema = PARSED[table];
    let sh = this.ss.getSheetByName(table);
    if (!sh) {
      sh = this.ss.insertSheet(table);
      const header = [];
      for (const f of schema.fields) for (let i = 0; i < f.width; i++) header.push(f.width > 1 ? `${f.name}#${i + 1}` : f.name);
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
      // Plain text, so Sheets never turns a class like "10-3" into a date.
      for (const f of schema.fields)
        if (f.type === 'str' || f.type === 'json') sh.getRange(1, f.col, sh.getMaxRows(), f.width).setNumberFormat('@');
    }
    this.sheets[table] = sh;
    return sh;
  }

  rowToObject(table, row, light) {
    const obj = {};
    for (const f of PARSED[table].fields) {
      if (light && f.type === 'json') continue;
      obj[f.name] = decodeField(f, row.slice(f.col - 1, f.col - 1 + f.width));
    }
    return obj;
  }

  objectToRow(table, obj) {
    const row = [];
    for (const f of PARSED[table].fields) row.push.apply(row, encodeField(f, obj[f.name]));
    return row;
  }

  // light = skip the JSON columns (much faster for big tables).
  all(table, light) {
    const key = table + (light ? ':light' : '');
    if (this.cache[key]) return this.cache[key];
    const sh = this.sheet(table);
    const n = sh.getLastRow() - 1;
    const schema = PARSED[table];
    const width = light ? schema.lightWidth : schema.width;
    const rows = n > 0 ? sh.getRange(2, 1, n, width).getValues() : [];
    const out = rows.filter((r) => r[0] !== '').map((r) => this.rowToObject(table, r, light));
    this.cache[key] = out;
    return out;
  }

  rowIndex(table, id) {
    const sh = this.sheet(table);
    const n = sh.getLastRow() - 1;
    if (n <= 0) return -1;
    const ids = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
    return -1;
  }

  get(table, id) {
    const r = this.rowIndex(table, id);
    if (r < 0) return null;
    const row = this.sheet(table).getRange(r, 1, 1, PARSED[table].width).getValues()[0];
    return this.rowToObject(table, row, false);
  }

  insert(table, obj) {
    const rec = Object.assign({}, obj, { id: obj.id || newId() });
    this.sheet(table).appendRow(this.objectToRow(table, rec));
    this.cache = {};
    return rec;
  }

  // Writes only the given fields, so an autosave and a warning arriving at
  // the same moment never overwrite each other.
  update(table, id, fields) {
    const r = this.rowIndex(table, id);
    if (r < 0) throw new HttpError(404, 'Record not found.');
    const sh = this.sheet(table);
    for (const f of PARSED[table].fields) {
      if (!(f.name in fields) || f.name === 'id') continue;
      sh.getRange(r, f.col, 1, f.width).setValues([encodeField(f, fields[f.name])]);
    }
    this.cache = {};
  }

  remove(table, id) {
    const r = this.rowIndex(table, id);
    if (r > 0) this.sheet(table).deleteRow(r);
    this.cache = {};
  }

  removeWhere(table, pred) {
    const sh = this.sheet(table);
    const n = sh.getLastRow() - 1;
    if (n <= 0) return;
    const rows = sh.getRange(2, 1, n, PARSED[table].lightWidth || 1).getValues();
    for (let i = rows.length - 1; i >= 0; i--) if (pred(this.rowToObject(table, rows[i], true))) sh.deleteRow(i + 2);
    this.cache = {};
  }
}

if (typeof module !== 'undefined') module.exports = { SCHEMAS, PARSED, parseSchema };
