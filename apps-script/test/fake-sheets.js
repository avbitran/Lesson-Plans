'use strict';
// A small imitation of SpreadsheetApp's Sheet/Range, strict about bounds like
// the real one, for testing SheetStore against realistic sheets.

class FakeRange {
  constructor(sheet, r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols)
      throw new Error(`Range (${r},${c},${nr},${nc}) is outside the sheet (${sheet.maxRows}x${sheet.maxCols})`);
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.cells[this.r - 1 + i] || [];
      const vals = [];
      for (let j = 0; j < this.nc; j++) {
        const v = row[this.c - 1 + j];
        vals.push(v === undefined || v === null ? '' : v);
      }
      out.push(vals);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some((r) => r.length !== this.nc)) throw new Error('setValues: size mismatch');
    values.forEach((row, i) => {
      const target = (this.sheet.cells[this.r - 1 + i] ||= []);
      row.forEach((v, j) => (target[this.c - 1 + j] = v));
    });
    return this;
  }
  setNumberFormat() {
    return this;
  }
  setFontWeight() {
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    Object.assign(this, { name, cells: [], maxRows: 1000, maxCols: 26 });
  }
  getName() {
    return this.name;
  }
  getRange(r, c, nr = 1, nc = 1) {
    return new FakeRange(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.cells.length - 1; i >= 0; i--) if ((this.cells[i] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    for (const row of this.cells) if (row) row.forEach((v, j) => v !== '' && v !== undefined && v !== null && (max = Math.max(max, j + 1)));
    return max;
  }
  getMaxRows() {
    return this.maxRows;
  }
  getMaxColumns() {
    return this.maxCols;
  }
  insertColumnsAfter(after, n) {
    this.maxCols += n;
  }
  appendRow(row) {
    const r = this.getLastRow() + 1;
    if (row.length > this.maxCols) this.maxCols = row.length; // appendRow grows the sheet
    if (r > this.maxRows) this.maxRows = r;
    this.cells[r - 1] = row.slice();
  }
  deleteRow(r) {
    this.cells.splice(r - 1, 1);
  }
  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
  }
  getSheetByName(name) {
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name) {
    const s = new FakeSheet(name);
    this.sheets.push(s);
    return s;
  }
  getSheets() {
    return this.sheets;
  }
}

module.exports = { FakeSpreadsheet };
