// Camera barcode scanner for iPhone (works in any modern browser).
// Decoding is done by zxing-cpp compiled to WebAssembly (vendor/zxing).
const overlay = document.getElementById('scanner');
const video = document.getElementById('scanVideo');
const statusEl = document.getElementById('scanStatus');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const READER_OPTIONS = {
  formats: ['EANUPC', 'ITF', 'Code128', 'DataBar'],
  tryHarder: true,
  maxNumberOfSymbols: 1,
};

ZXingWASM.prepareZXingModule({
  overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? '/vendor/zxing/zxing_reader.wasm' : prefix + p) },
});

let stream = null;
let onCode = null;
let onManual = null;
let paused = false;
let running = false;
let lastText = '';
let lastAt = 0;

document.getElementById('scanClose').onclick = () => close();
document.getElementById('scanManual').onclick = async () => {
  if (!onManual) return;
  pause();
  await onManual();
  resume();
};

export function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `scan-status ${kind}`;
}

function cameraError(err) {
  if (!window.isSecureContext) return 'The camera needs a secure (https) connection. Tap "Type code" instead.';
  if (err && err.name === 'NotAllowedError') return 'Camera access is blocked. On iPhone: Settings › Safari › Camera › Allow. Or tap "Type code".';
  if (err && err.name === 'NotFoundError') return 'No camera found. Tap "Type code" instead.';
  return 'Could not start the camera. Tap "Type code" instead.';
}

// handler(text, format) is called for each new barcode; manual() is called by the "Type code" button.
export async function open(handler, manual) {
  onCode = handler;
  onManual = manual;
  overlay.hidden = false;
  setStatus('Starting camera…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    setStatus(cameraError(err), 'error');
    return false;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  running = true;
  paused = false;
  lastText = '';
  setStatus('Line up the barcode inside the box');
  loop();
  return true;
}

export function close() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  overlay.hidden = true;
  onCode = null;
  onManual = null;
}

export const isOpen = () => !overlay.hidden;

// Pause decoding (e.g. while a quantity prompt is open) without stopping the camera.
export function pause() { paused = true; }
export function resume() { paused = false; lastAt = Date.now(); }

async function decodeFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // Read the middle band of the picture (where the on-screen box is); 1D barcodes are wide, not tall.
  const cropW = Math.round(vw * 0.9);
  const cropH = Math.round(vh * 0.5);
  const scale = Math.min(1, 1280 / cropW);
  canvas.width = Math.round(cropW * scale);
  canvas.height = Math.round(cropH * scale);
  ctx.drawImage(video, (vw - cropW) / 2, (vh - cropH) / 2, cropW, cropH, 0, 0, canvas.width, canvas.height);
  const results = await ZXingWASM.readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), READER_OPTIONS);
  return results.find((r) => r.isValid) || null;
}

async function loop() {
  while (running) {
    if (!paused && video.readyState >= 2 && video.videoWidth) {
      try {
        const r = await decodeFrame();
        const now = Date.now();
        // Ignore the same barcode held in front of the camera for a moment.
        if (r && running && !paused && (r.text !== lastText || now - lastAt > 2500)) {
          lastText = r.text;
          lastAt = now;
          paused = true;
          try { await onCode?.(r.text, r.format); } finally { if (running) resume(); }
        }
      } catch (e) { console.warn('decode failed', e); }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}
