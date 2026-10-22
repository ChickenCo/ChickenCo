// A fingerprint of the phone app's files. It changes whenever an update is deployed, so open
// phones can show "New version available" instead of running old code.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashDir(dir, hash) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) hashDir(file, hash);
    else hash.update(name).update(fs.readFileSync(file));
  }
  return hash;
}

const APP_VERSION = hashDir(path.join(__dirname, '..', 'public'), crypto.createHash('sha1')).digest('hex').slice(0, 12);

module.exports = { APP_VERSION };
