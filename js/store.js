// Local data store. Everything lives in the phone's localStorage for this demo;
// swapping this module for API calls is the path to multi-device sync later.
const Store = (() => {
  const KEY = 'chickenco.pick.v1';

  const empty = () => ({ items: [], orders: [], settings: { pin: '1234' } });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...empty(), ...JSON.parse(raw) };
    } catch (e) { console.warn('Could not read saved data', e); }
    return empty();
  }

  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const normSku = (s) => String(s || '').trim().toUpperCase();

  // ---- Items (catalog) ----
  const items = () => state.items.slice().sort((a, b) => a.sku.localeCompare(b.sku));
  const item = (sku) => state.items.find((i) => i.sku === normSku(sku));

  function saveItem(data, originalSku) {
    const sku = normSku(data.sku);
    if (!sku) throw new Error('SKU is required');
    if (!String(data.name || '').trim()) throw new Error('Item name is required');
    const clash = item(sku);
    if (clash && sku !== normSku(originalSku)) throw new Error(`SKU ${sku} already exists`);
    const record = { sku, name: data.name.trim(), location: (data.location || '').trim() };
    const idx = state.items.findIndex((i) => i.sku === normSku(originalSku || sku));
    if (idx >= 0) {
      state.items[idx] = record;
      // Keep open pick sheets pointing at the renamed SKU.
      if (originalSku && normSku(originalSku) !== sku) {
        state.orders.forEach((o) => o.lines.forEach((l) => { if (l.sku === normSku(originalSku)) l.sku = sku; }));
      }
    } else {
      state.items.push(record);
    }
    save();
    return record;
  }

  function deleteItem(sku) {
    state.items = state.items.filter((i) => i.sku !== normSku(sku));
    save();
  }

  // Accepts "sku,name,location" lines (header row optional). Returns counts.
  function importItemsCsv(text) {
    let added = 0, updated = 0, skipped = 0;
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const [sku, name, location] = line.split(/,|\t/).map((s) => s.trim().replace(/^"|"$/g, ''));
      if (/^sku$/i.test(sku)) return; // header row
      if (!sku || !name) { skipped++; return; }
      const existed = !!item(sku);
      try {
        saveItem({ sku, name, location }, existed ? sku : undefined);
        existed ? updated++ : added++;
      } catch { skipped++; }
    });
    return { added, updated, skipped };
  }

  // ---- Orders (pick sheets) ----
  const orders = () => state.orders.slice().sort((a, b) => b.createdAt - a.createdAt);
  const order = (id) => state.orders.find((o) => o.id === id);

  function saveOrder(data, id) {
    const number = String(data.number || '').trim();
    if (!number) throw new Error('Order number is required');
    const lines = (data.lines || []).filter((l) => l.sku && l.qty > 0);
    if (!lines.length) throw new Error('Add at least one item');
    const existing = id && order(id);
    if (existing) {
      // Preserve picked counts for lines that are still present.
      const prev = Object.fromEntries(existing.lines.map((l) => [l.sku, l.picked]));
      existing.number = number;
      existing.customer = (data.customer || '').trim();
      existing.lines = lines.map((l) => ({ sku: l.sku, qty: l.qty, picked: Math.min(prev[l.sku] || 0, l.qty) }));
      existing.status = 'open';
      save();
      return existing;
    }
    const rec = {
      id: uid(), number, customer: (data.customer || '').trim(), createdAt: Date.now(), status: 'open',
      lines: lines.map((l) => ({ sku: l.sku, qty: l.qty, picked: 0 })),
    };
    state.orders.push(rec);
    save();
    return rec;
  }

  function deleteOrder(id) {
    state.orders = state.orders.filter((o) => o.id !== id);
    save();
  }

  function setPicked(orderId, sku, picked) {
    const o = order(orderId);
    const line = o && o.lines.find((l) => l.sku === normSku(sku));
    if (!line) return null;
    line.picked = Math.max(0, Math.min(line.qty, picked));
    if (o.status === 'complete' && line.picked < line.qty) o.status = 'open';
    save();
    return line;
  }

  function setOrderStatus(id, status) {
    const o = order(id);
    if (!o) return;
    o.status = status;
    o.completedAt = status === 'complete' ? Date.now() : undefined;
    save();
  }

  function resetOrder(id) {
    const o = order(id);
    if (!o) return;
    o.lines.forEach((l) => { l.picked = 0; });
    o.status = 'open';
    save();
  }

  const progress = (o) => {
    const need = o.lines.reduce((s, l) => s + l.qty, 0);
    const got = o.lines.reduce((s, l) => s + l.picked, 0);
    const linesDone = o.lines.filter((l) => l.picked >= l.qty).length;
    return { need, got, linesDone, lines: o.lines.length, done: linesDone === o.lines.length };
  };

  // ---- Settings / data ----
  const pin = () => state.settings.pin;
  function setPin(p) { state.settings.pin = p; save(); }

  const exportJson = () => JSON.stringify(state, null, 2);
  function importJson(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.items) || !Array.isArray(data.orders)) throw new Error('Not a valid backup file');
    state = { ...empty(), ...data };
    save();
  }
  function clearAll() { const p = state.settings.pin; state = empty(); state.settings.pin = p; save(); }

  function loadDemo() {
    const demoItems = [
      ['CC-1001', 'Whole Chicken 4lb', 'Cooler A1'],
      ['CC-1002', 'Chicken Breast 10lb Case', 'Cooler A2'],
      ['CC-1003', 'Chicken Thighs 10lb Case', 'Cooler A3'],
      ['CC-1004', 'Chicken Wings 5lb Bag', 'Freezer B1'],
      ['CC-1005', 'Drumsticks 10lb Case', 'Cooler A4'],
      ['CC-2001', 'Breading Mix 25lb', 'Dry C1'],
      ['CC-2002', 'Frying Oil 35lb Jug', 'Dry C2'],
      ['CC-3001', 'To-Go Boxes (200 ct)', 'Supply D1'],
    ];
    demoItems.forEach(([sku, name, location]) => saveItem({ sku, name, location }, item(sku) ? sku : undefined));
    saveOrder({ number: 'SO-1042', customer: 'Main Street Diner', lines: [
      { sku: 'CC-1002', qty: 3 }, { sku: 'CC-1004', qty: 6 }, { sku: 'CC-2001', qty: 1 }, { sku: 'CC-3001', qty: 2 },
    ] });
    saveOrder({ number: 'SO-1043', customer: 'Riverside Grill', lines: [
      { sku: 'CC-1001', qty: 4 }, { sku: 'CC-1003', qty: 2 }, { sku: 'CC-1005', qty: 1 }, { sku: 'CC-2002', qty: 1 },
    ] });
  }

  return {
    normSku, items, item, saveItem, deleteItem, importItemsCsv,
    orders, order, saveOrder, deleteOrder, setPicked, setOrderStatus, resetOrder, progress,
    pin, setPin, exportJson, importJson, clearAll, loadDemo,
  };
})();
