// Camera QR scanner. Uses the browser's native BarcodeDetector when present
// (Android Chrome) and falls back to jsQR everywhere else (iPhone Safari).
const Scanner = (() => {
  const overlay = document.getElementById('scanner');
  const video = document.getElementById('scanVideo');
  const status = document.getElementById('scanStatus');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let detector = null;
  let onCode = null;
  let paused = false;
  let running = false;
  let lastCode = '';
  let lastAt = 0;

  document.getElementById('scanClose').onclick = () => close();

  if ('BarcodeDetector' in window) {
    try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
  }

  async function open(handler) {
    onCode = handler;
    overlay.hidden = false;
    setStatus('Starting camera…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      setStatus(cameraError(err), true);
      return false;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    running = true;
    paused = false;
    setStatus('Point the camera at a QR code');
    loop();
    return true;
  }

  function close() {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    overlay.hidden = true;
  }

  // Pause decoding (e.g. while a quantity prompt is open) without stopping the camera.
  function pause() { paused = true; }
  function resume() { paused = false; lastAt = Date.now(); }

  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle('error', !!isError);
  }

  function cameraError(err) {
    if (!window.isSecureContext) return 'Camera needs a secure (https://) connection. Use "Type SKU" instead.';
    if (err && err.name === 'NotAllowedError') return 'Camera permission was denied. Allow camera access in your browser settings, or use "Type SKU".';
    if (err && err.name === 'NotFoundError') return 'No camera found. Use "Type SKU" instead.';
    return 'Could not start the camera. Use "Type SKU" instead.';
  }

  async function decode() {
    if (detector) {
      const codes = await detector.detect(video);
      return codes.length ? codes[0].rawValue : null;
    }
    // Downscale for speed; QR codes on labels are still easily readable at this size.
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return code ? code.data : null;
  }

  async function loop() {
    if (!running) return;
    if (!paused && video.readyState >= 2 && video.videoWidth) {
      try {
        const text = await decode();
        const now = Date.now();
        // Ignore the same code held in front of the camera for a moment.
        if (text && (text !== lastCode || now - lastAt > 2000)) {
          lastCode = text;
          lastAt = now;
          if (onCode) onCode(text);
        }
      } catch (e) { console.warn('decode failed', e); }
    }
    setTimeout(() => requestAnimationFrame(loop), 120);
  }

  return { open, close, pause, resume, setStatus, get isOpen() { return running; } };
})();
