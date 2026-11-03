// Pick priority: pack-type rules sort pick lists (30 packs first, then 18 packs, then 12 packs...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorityOf, groupByPriority, sortByPriority } from '../public/js/priority.js';

const RULES = [
  { label: '30 packs', match: ['30/12', '30 PK', '30PK'] },
  { label: '18 packs', match: ['18/12', '18 CAN'] },
  { label: '12 packs', match: ['2/12', '12/12'] },
];

test('each item lands in the first rule that matches its description', () => {
  assert.equal(priorityOf('BUD LT 30/12 CAN', RULES), 0);
  assert.equal(priorityOf('NATICE 2/15 30PK CAN', RULES), 0);
  assert.equal(priorityOf('MULTRA 30 PK', RULES), 0);
  assert.equal(priorityOf('BUD LT 18/12 CAN', RULES), 1);
  assert.equal(priorityOf('MULTRA 18 CAN', RULES), 1);
  assert.equal(priorityOf('MULTRA 2/12CAN', RULES), 2);
  assert.equal(priorityOf('BUD LT 12/12 CAN', RULES), 2);
  assert.equal(priorityOf('MULTRA 24/12 CAN', RULES), 3, '24/12 is not a 2/12');
  assert.equal(priorityOf('BUD LN 4/6', RULES), 3);
});

test('"2/12" does not match inside "12/12" on its own', () => {
  assert.equal(priorityOf('BUD LT 12/12 CAN', [{ label: 'twins', match: ['2/12'] }]), 1);
});

test('pick lists are grouped and keep VIP order inside each group', () => {
  const lines = ['STELLA LN 2/12', 'BUD LT 30/12 CAN', 'BUD LN 4/6', 'BUD LT 18/12 CAN', 'BSH LT 30/12 CAN', 'BUD LT 12/12 CAN']
    .map((description, i) => ({ id: i, description }));
  const groups = groupByPriority(lines, RULES);
  assert.deepEqual(groups.map((g) => [g.label, g.lines.map((l) => l.description)]), [
    ['30 packs', ['BUD LT 30/12 CAN', 'BSH LT 30/12 CAN']],
    ['18 packs', ['BUD LT 18/12 CAN']],
    ['12 packs', ['STELLA LN 2/12', 'BUD LT 12/12 CAN']],
    ['Everything else', ['BUD LN 4/6']],
  ]);
  assert.deepEqual(sortByPriority(lines, []).map((l) => l.id), [0, 1, 2, 3, 4, 5], 'no rules: VIP order');
});
