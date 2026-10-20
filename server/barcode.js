// Turns whatever a scanner reads into a 14-digit GTIN so the same product matches no matter
// which symbology was printed: UPC-A (12), EAN-13 (13), UPC-E (8), case ITF-14 / GS1 (14).

function expandUpcE(upce) {
  // upce: 8 digits = number system + 6 data digits + check digit
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

function normalizeBarcode(raw, format = '') {
  let text = String(raw || '').trim();
  if (!text) return null;
  // GS1 element strings, e.g. "(01)00012345678905" or "0100012345678905..."
  const ai = text.match(/^\(01\)(\d{14})/) || (text.length >= 16 && /^01\d{14}/.test(text) && [null, text.slice(2, 16)]);
  if (ai) return ai[1];
  if (!/^\d+$/.test(text)) return text.toUpperCase(); // non-numeric codes are kept as-is
  if (text.length === 8 && /upc.?e/i.test(format)) text = expandUpcE(text);
  if (text.length <= 14) return text.padStart(14, '0');
  return text;
}

// Shorter form for showing on screen (drops the GTIN-14 padding).
function displayBarcode(gtin) {
  return /^\d{14}$/.test(gtin) && gtin.startsWith('00') ? gtin.slice(2) : gtin;
}

module.exports = { normalizeBarcode, displayBarcode, expandUpcE };
