const path = require('node:path');
const express = require('express');
const auth = require('./auth');

auth.ensureAdmin();
const api = require('./api');

const app = express();
app.set('trust proxy', true); // behind the hosting provider's HTTPS proxy
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use('/api', express.json({ limit: '1mb' }), auth.loadUser, api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, {
  setHeaders(res, file) {
    // The service worker and app code must always be revalidated so phones get updates.
    if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    if (file.endsWith('.wasm')) res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Pick app running on http://localhost:${port}`));
