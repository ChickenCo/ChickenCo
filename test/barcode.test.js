const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBarcode, displayBarcode } = require('../server/barcode');

test('UPC-A and EAN-13 of the same product match', () => {
  assert.equal(normalizeBarcode('018200007118'), '00018200007118');
  assert.equal(normalizeBarcode('0018200007118', 'EAN13'), '00018200007118');
});

test('case ITF-14 and GS1 (01) codes are kept as GTIN-14', () => {
  assert.equal(normalizeBarcode('10018200007115', 'ITF'), '10018200007115');
  assert.equal(normalizeBarcode('(01)10018200007115'), '10018200007115');
  assert.equal(normalizeBarcode('011001820000711517260101'), '10018200007115');
});

test('UPC-E expands to its UPC-A number', () => {
  assert.equal(normalizeBarcode('04252614', 'UPCE'), '00042100005264');
});

test('display drops GTIN padding', () => {
  assert.equal(displayBarcode('00018200007118'), '018200007118');
  assert.equal(displayBarcode('10018200007115'), '10018200007115');
});
