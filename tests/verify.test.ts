/**
 * The claim checker on model prose.
 *
 * The model may restate figures in human forms ("September 11th, 2026",
 * "PO 506", "1,080"). Those must be read as the figures they are and then held
 * to the same rule: anything not in the findings, the evidence or the facts the
 * model was shown gets the narrative discarded.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Finding } from '../src/analysis.ts';
import { verifyNarrative } from '../src/verify.ts';
import type { Evidence } from '../src/zetaris.ts';

const findings: Finding[] = [
  {
    cause: 'supplier_lead_time_slip',
    title: 'The supplier took longer than its quoted lead time',
    verdict: 'supported',
    statement:
      'PO-506 was raised on 2026-08-23 and arrived 2026-09-11, which is 19 days ' +
      'against a quoted 7. Had it arrived within the quoted 7 days, on ' +
      '2026-08-30, stock would not have reached zero.',
    numbers: { actual_lead_days: 19, quoted_lead_days: 7, demand_ratio: '1.20' },
    sufficient: true,
    necessary: true,
  },
];

const evidence: Evidence[] = [
  {
    id: 'E1',
    label: 'ledger',
    sql: 'SELECT ...',
    columns: ['ledger_date', 'units_on_hand'],
    rows: [['2026-09-03', '0'], ['2026-09-10', '1080']],
    rowCount: 2,
    resultHash: 'x',
    queriedAt: '2026-10-28T00:00:00.000Z',
  },
];

const check = (prose: string, extra: (string | number)[] = []) =>
  verifyNarrative(prose, findings, evidence, extra);

test('accepts ISO dates and numbers that are in the findings', () => {
  const result = check('PO-506 was raised on 2026-08-23 and took 19 days against 7.');
  assert.equal(result.ok, true, result.unsupported.join(', '));
});

test('reads dates written in words and accepts them when supported', () => {
  const result = check(
    'It was raised on August 23rd, 2026 and arrived on September 11, 2026. ' +
      'Stock hit zero on the 3rd of September and it should have landed by Aug. 30.',
  );
  assert.equal(result.ok, true, result.unsupported.join(', '));
  assert.ok(result.checked >= 4);
});

test('rejects a written date that is not in the inputs', () => {
  const result = check('The order arrived on September 12, 2026.');
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsupported, ['September 12, 2026']);
});

test('rejects a year-less written date no supported date matches', () => {
  assert.equal(check('It arrived on October 2.').ok, false);
  assert.equal(check('It arrived on September 11.').ok, true);
});

test('checks ordinals instead of letting them slip past', () => {
  const result = check('The delay ran to the 24th day.');
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsupported, ['24th']);
});

test('accepts the digits of an identifier written loosely, not other numbers', () => {
  assert.equal(check('Purchase order 506 was the late one.').ok, true);
  assert.equal(check('Purchase order 507 was the late one.').ok, false);
});

test('reads thousands separators', () => {
  assert.equal(check('Stock was back to 1,080 units.').ok, true);
  assert.equal(check('Stock was back to 1,090 units.').ok, false);
});

test('accepts extra facts only when the caller passes them', () => {
  assert.equal(check('The shelf was empty for 8 days.').ok, false);
  assert.equal(check('The shelf was empty for 8 days.', [8]).ok, true);
});

test('treats 1.2 and 1.20 as the same figure', () => {
  assert.equal(check('Demand rose by a ratio of 1.2.').ok, true);
});
