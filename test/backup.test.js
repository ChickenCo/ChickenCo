// Backups: request signing matches Amazon's published example, and local copies rotate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-backup-'));
process.env.DATA_DIR = DATA_DIR;
const { signRequest, runBackup, status } = require('../server/backup');

test('S3 request signing matches the AWS Signature V4 example (GET Object)', () => {
  // From the AWS docs "Signature Calculations for the Authorization Header", example GET Object.
  const h = signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    region: 'us-east-1',
    keyId: 'AKIAIOSFODNN7EXAMPLE',
    secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    headers: { Range: 'bytes=0-9' },
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(h.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
    + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('backs up to the disk and keeps the newest 7', async () => {
  for (let i = 0; i < 9; i++) {
    const s = await runBackup('test');
    assert.equal(s.local, true);
    assert.equal(s.error, null);
    await new Promise((r) => setTimeout(r, 1100)); // file names are per second
  }
  const files = fs.readdirSync(path.join(DATA_DIR, 'backups'));
  assert.equal(files.length, 7);
  assert.equal(status().offsite, 'not set up');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
