// Bluetooth ring / handheld scanners (e.g. the SA1200) in keyboard (HID) mode "type" the barcode
// very fast and then press Enter. This tells that burst apart from a person typing and hands the
// code to whichever screen is listening, so pickers don't have to tap anything before scanning.

// ms allowed between characters. Bluetooth can pause briefly in the middle of a barcode, so this is
// generous; a scan still has to end in Enter, and in text boxes it has to be a long run of digits.
const MAX_GAP = 250;
const MIN_LENGTH = 4;    // item codes are 5 digits, barcodes 8+

let handler = null;
let buffer = '';
let last = 0;
let burstStart = 0;
let slowest = 0;
// The last few scans, for the scanner test under My account (helps tell scanner problems from app problems).
export const recent = [];
let burstTarget = null;  // an input the burst landed in by accident
let burstStartValue = '';
const listeners = new Set();

const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
// Fields where typing a code is the point: the "Type a code" boxes.
const codeField = (el) => el && /^(code|raw)$/.test(el.name || '');

const sink = document.createElement('input');
sink.id = 'scanSink';
sink.setAttribute('inputmode', 'none'); // no on-screen keyboard
sink.setAttribute('autocomplete', 'off');
sink.setAttribute('aria-hidden', 'true');
sink.tabIndex = -1;
sink.className = 'scan-sink';
document.body.appendChild(sink);

const sinkWanted = () => { try { return localStorage.getItem('wedge-sink') === '1'; } catch { return false; } };
export const setSinkMode = (on) => { try { localStorage.setItem('wedge-sink', on ? '1' : '0'); } catch { /* ignore */ } refocus(); };
export const sinkMode = sinkWanted;

// Some scanners only type into a focused text box; this keeps an invisible one ready (Settings › Scanner).
function refocus() {
  if (!handler || !sinkWanted()) return;
  const a = document.activeElement;
  if (!a || a === document.body || a === sink) sink.focus({ preventScroll: true });
}
setInterval(refocus, 1000);

function reset() { buffer = ''; burstTarget = null; burstStartValue = ''; slowest = 0; }

// Some scanners add a symbology prefix like "]E0" (AIM identifier) or stray control characters.
const cleanCode = (s) => s.replace(/^\][A-Za-z][0-9A-Za-z]/, '').replace(/[\x00-\x1f]/g, '').trim();

function emit(code, stats) {
  recent.unshift({ code, at: Date.now(), ...stats });
  recent.length = Math.min(recent.length, 15);
  listeners.forEach((fn) => fn(code));
  if (handler) handler(code);
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const now = performance.now();
  const gap = now - last;
  if (gap > MAX_GAP) reset();
  else if (buffer) slowest = Math.max(slowest, gap);
  last = now;
  const target = e.target;
  const inField = editable(target) && target !== sink;

  if (e.key === 'Enter' || e.key === 'Tab') {
    const code = cleanCode(buffer);
    // In a text box, only a long run of digits counts as a scan, so fast typing isn't mistaken for one.
    const isScan = code.length >= MIN_LENGTH && (!inField || /^\d{8,}$/.test(code));
    if (!isScan) { reset(); return; }
    if (inField && codeField(target)) { reset(); return; } // scanning into "Type a code" just submits it
    e.preventDefault();
    e.stopPropagation();
    if (burstTarget) burstTarget.value = burstStartValue; // undo what the scanner typed into e.g. a quantity box
    sink.value = '';
    const wasInField = inField && !codeField(target);
    const stats = { ms: Math.round(now - burstStart), slowest: Math.round(slowest) };
    reset();
    if (wasInField && target.name === 'qty') {
      // A quantity popup is open: don't let the barcode become a quantity.
      document.dispatchEvent(new CustomEvent('wedge-blocked', { detail: code }));
      return;
    }
    emit(code, stats);
    return;
  }

  if (e.key.length !== 1) return;
  if (!buffer) burstStart = now;
  if (!buffer && inField) { burstTarget = target; burstStartValue = target.value; }
  buffer += e.key;
  if (!inField) e.preventDefault(); // keep stray characters from scrolling or typing elsewhere
}, true);

// The active screen's scan handler (one at a time). Returns a function that removes it.
export function onScan(fn) {
  handler = fn;
  refocus();
  return () => { if (handler === fn) handler = null; };
}

export const offScan = () => { handler = null; };

// Extra listeners (the scanner test on the Settings page).
export function watch(fn) { listeners.add(fn); return () => listeners.delete(fn); }
