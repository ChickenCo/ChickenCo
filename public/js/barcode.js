// Phone-side copy of server/barcode.js, so scans can be matched while there's no signal.
function expandUpcE(upce) {
  const ns = upce[0];
  const d = upce.slice(1, 7);
  const check = upce[7];
  let body;
  switch (d[5]) {
    case '0': case '1': case '2': body = `${d.slice(0, 2)}${d[5]}0000${d.slice(2, 5)}`; break;
    case '3': body = `${d.slice(0, 3)}00000${d.slice(3, 5)}`; break;
    case '4': body = `${d.slice(0, 4)}00000${d[4]}`; break;
    default: body = `${d.slice(0, 5)}0000${d[5]}`;
  }
  return `${ns}${body}${check}`;
}

export function normalizeBarcode(raw, format = '') {
  let text = String(raw || '').trim();
  if (!text) return null;
  const ai = text.match(/^\(01\)(\d{14})/) || (text.length >= 16 && /^01\d{14}/.test(text) && [null, text.slice(2, 16)]);
  if (ai) return ai[1];
  if (!/^\d+$/.test(text)) return text.toUpperCase();
  if (text.length === 8 && /upc.?e/i.test(format)) text = expandUpcE(text);
  if (text.length <= 14) return text.padStart(14, '0');
  return text;
}
