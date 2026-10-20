// Draws a UPC-A barcode as SVG (used for printable test labels).
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));

export function upcSvg(digits) {
  if (!/^\d{12}$/.test(digits)) return '';
  const bits = `101${[...digits.slice(0, 6)].map((d) => L[d]).join('')}01010${[...digits.slice(6)].map((d) => R[d]).join('')}101`;
  const quiet = 9;
  const width = bits.length + quiet * 2;
  let x = quiet;
  let rects = '';
  [...bits].forEach((b, i) => {
    // Guard bars run longer, like on a printed label.
    const guard = i < 3 || (i >= 45 && i < 50) || i >= 92;
    if (b === '1') rects += `<rect x="${x}" y="0" width="1" height="${guard ? 56 : 50}"/>`;
    x += 1;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 64" class="upc" role="img" aria-label="UPC ${digits}">
    <rect width="${width}" height="64" fill="#fff"/><g fill="#000">${rects}</g>
    <text x="${width / 2}" y="63" font-size="8" text-anchor="middle" font-family="monospace" fill="#000">${digits}</text></svg>`;
}
