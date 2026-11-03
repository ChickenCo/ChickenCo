// Reads the first sheet of an .xlsx file into rows of cell values. Just enough for VIP exports:
// an .xlsx is a zip of XML files, so this reads the zip directory, inflates the sheet and shared
// strings, and pulls out the cells.
const zlib = require('node:zlib');

function unzip(buf, wanted) {
  // End of central directory record: in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('This .xlsx file is damaged');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      files[name] = method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function readXlsx(buf) {
  const files = unzip(buf, (name) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name));
  // First sheet, as named in the workbook.
  let sheetPath = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort()[0];
  const wb = files['xl/workbook.xml']?.toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels']?.toString('utf8');
  const firstId = wb && (wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || [])[1];
  const target = firstId && rels && (rels.match(new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`)) || [])[1];
  if (target) sheetPath = `xl/${target.replace(/^\/?xl\//, '')}`;
  if (!sheetPath || !files[sheetPath]) throw new Error('No worksheet found in this .xlsx file');

  const shared = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  const xml = files[sheetPath].toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const inner = cm[2] || '';
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str' || type === 'e') value = v != null ? decode(v) : '';
      else if (type === 'b') value = v === '1';
      else if (v != null) value = Number(v);
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (c) => (c === undefined ? '' : c)));
  }
  return rows;
}

const isXlsx = (buf) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

module.exports = { readXlsx, isXlsx };
