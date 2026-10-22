// Nightly backups. A copy of the database is kept on the disk (last 7) and, when configured,
// uploaded to outside storage that speaks the S3 protocol: Backblaze B2, Cloudflare R2, Amazon S3, Wasabi...
//
//   BACKUP_S3_ENDPOINT  e.g. https://s3.us-west-004.backblazeb2.com
//   BACKUP_S3_BUCKET    bucket name
//   BACKUP_S3_KEY_ID    access key id
//   BACKUP_S3_SECRET    secret access key
//   BACKUP_S3_REGION    e.g. us-west-004 (R2 uses "auto"; default us-east-1)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');

const DIR = path.join(DATA_DIR, 'backups');
const KEEP = 7;
const EVERY = 24 * 3600000;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// AWS Signature Version 4 for one request. `headers` must include everything to sign except the ones added here.
function signRequest({ method, url, region, keyId, secret, body = '', headers = {}, date = new Date(), payloadHash }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const hash = payloadHash || sha256(body);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host, 'x-amz-content-sha256': hash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [method, encodePath(u.pathname), query, names.map((k) => `${k}:${all[k]}\n`).join(''), names.join(';'), hash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const offsite = () => {
  const e = process.env;
  return e.BACKUP_S3_ENDPOINT && e.BACKUP_S3_BUCKET && e.BACKUP_S3_KEY_ID && e.BACKUP_S3_SECRET
    ? { endpoint: e.BACKUP_S3_ENDPOINT.replace(/\/+$/, ''), bucket: e.BACKUP_S3_BUCKET, keyId: e.BACKUP_S3_KEY_ID,
      secret: e.BACKUP_S3_SECRET, region: e.BACKUP_S3_REGION || 'us-east-1' }
    : null;
};

async function upload(file, name) {
  const cfg = offsite();
  const body = fs.readFileSync(file);
  const url = `${cfg.endpoint}/${cfg.bucket}/${name}`;
  const headers = signRequest({ method: 'PUT', url, region: cfg.region, keyId: cfg.keyId, secret: cfg.secret, body,
    headers: { 'content-type': 'application/octet-stream' } });
  delete headers.host;
  const res = await fetch(url, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

let running = false;
async function runBackup(reason = 'nightly') {
  if (running) return getSetting('backup_status', null);
  running = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `pick-${stamp}.db`;
  const status = { at: Date.now(), reason, file: name, local: false, offsite: offsite() ? 'pending' : 'not set up', error: null };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, name);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    status.local = true;
    status.size = fs.statSync(file).size;
    // Keep the newest 7 on the disk.
    fs.readdirSync(DIR).filter((f) => /^pick-.*\.db$/.test(f)).sort().reverse().slice(KEEP)
      .forEach((f) => fs.rmSync(path.join(DIR, f), { force: true }));
    if (offsite()) {
      await upload(file, name);
      status.offsite = 'uploaded';
    }
  } catch (err) {
    status.error = err.message;
    if (status.offsite === 'pending') status.offsite = 'failed';
    console.error('Backup failed:', err.message);
  } finally {
    running = false;
  }
  setSetting('backup_status', status);
  return status;
}

let scheduled = false;

// Checks every 30 minutes; backs up when the last good backup is over a day old.
function schedule() {
  scheduled = true;
  const tick = () => {
    const last = getSetting('backup_status', null);
    const ok = last && last.local && !last.error;
    if (!ok || Date.now() - last.at > EVERY) runBackup('nightly');
  };
  setTimeout(tick, 60000);
  setInterval(tick, 30 * 60000).unref();
}

// Also back up as soon as all trucks are loaded (only on the running server, not in tests).
function afterDayEnd() { if (scheduled) runBackup('all trucks loaded'); }

const status = () => ({ ...getSetting('backup_status', {}), offsiteConfigured: !!offsite(), keep: KEEP });

module.exports = { runBackup, schedule, status, signRequest, afterDayEnd };
