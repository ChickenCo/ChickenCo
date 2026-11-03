// Pick priority: supervisors set an order of pack types (30 packs first, then 18 packs, ...).
// Each rule matches words in the item description; pick lists are grouped and sorted by it.

const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ');

// "2/12" must not match inside "12/12", so a keyword can't touch another digit on either side.
function hasWord(desc, word) {
  const w = norm(word).trim();
  if (!w) return false;
  let i = desc.indexOf(w);
  while (i >= 0) {
    const before = desc[i - 1];
    const after = desc[i + w.length];
    const digitEdge = (c, side) => c && /\d/.test(c) && /\d/.test(side === 'start' ? w[0] : w[w.length - 1]);
    if (!digitEdge(before, 'start') && !digitEdge(after, 'end')) return true;
    i = desc.indexOf(w, i + 1);
  }
  return false;
}

// Index of the first rule that matches, or rules.length for "everything else".
export function priorityOf(description, rules) {
  const d = norm(description);
  const i = (rules || []).findIndex((r) => (r.match || []).some((w) => hasWord(d, w)));
  return i < 0 ? (rules || []).length : i;
}

// Lines in priority order (stable: keeps the VIP order within a group), with group labels.
export function groupByPriority(lines, rules) {
  const list = rules || [];
  const sorted = lines.map((l, n) => ({ l, n, p: priorityOf(l.description, list) }))
    .sort((a, b) => a.p - b.p || a.n - b.n);
  const groups = [];
  for (const x of sorted) {
    const label = x.p < list.length ? list[x.p].label : 'Everything else';
    if (!groups.length || groups.at(-1).label !== label) groups.push({ label, lines: [] });
    groups.at(-1).lines.push(x.l);
  }
  return groups;
}

export const sortByPriority = (lines, rules) => groupByPriority(lines, rules).flatMap((g) => g.lines);
