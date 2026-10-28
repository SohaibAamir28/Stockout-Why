/**
 * Grades the deterministic investigation against the simulation's ground truth.
 *
 * This is the honest eval: the generator writes ground_truth.json from what it
 * actually simulated, and these tests check the investigation recovers it from
 * the data alone - including that it is NOT fooled by the demand distractor.
 *
 * Runs in sample mode, so it needs no network, no keys and no Zetaris.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  addDays,
  daysBetween,
  findEpisodes,
  findTriggeringCrossing,
  investigate,
  replay,
} from '../src/analysis.ts';
import { fromSample } from '../src/sources.ts';

const GROUND_TRUTH = join('data', 'generated', 'ground_truth.json');

const available = existsSync(GROUND_TRUTH);
const skip = available
  ? false
  : 'run `npm run gen-data` first to generate the sample dataset';

interface GroundTruth {
  target_sku: string;
  primary_cause: string;
  secondary_cause: string;
  stockout_started: string;
  stockout_ended: string;
  stockout_days: number;
  fault_po: string;
  quoted_lead_time_days: number;
  actual_lead_time_days: number;
}

const truth: GroundTruth | null = available
  ? (JSON.parse(readFileSync(GROUND_TRUTH, 'utf8')) as GroundTruth)
  : null;

// --- unit checks on the primitives -----------------------------------------

test('findEpisodes groups only contiguous zero days', () => {
  const episodes = findEpisodes([
    { date: '2026-01-01', onHand: 5 },
    { date: '2026-01-02', onHand: 0 },
    { date: '2026-01-03', onHand: 0 },
    { date: '2026-01-04', onHand: 9 },
    { date: '2026-01-05', onHand: 0 },
  ]);
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes[0], { from: '2026-01-02', to: '2026-01-03', days: 2 });
  assert.deepEqual(episodes[1], { from: '2026-01-05', to: '2026-01-05', days: 1 });
});

test('date helpers are inclusive and symmetric', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(daysBetween('2026-02-27', '2026-03-01'), 2);
});

test('replay reports the first day stock would run out', () => {
  const out = replay({
    startDate: '2026-01-01',
    startOnHand: 10,
    untilDate: '2026-01-10',
    arrivals: new Map(),
    dailyDemand: () => 4,
  });
  // 10 -> 6 -> 2 -> -2 on the third day.
  assert.equal(out, '2026-01-03');
});

test('findTriggeringCrossing takes the run before the order, not the first dip', () => {
  // Stock dips below 50 early, recovers, then dips again just before the order.
  const trajectory = [
    { date: '2026-01-01', onHand: 40 }, // an early dip, irrelevant
    { date: '2026-01-02', onHand: 90 },
    { date: '2026-01-03', onHand: 80 },
    { date: '2026-01-04', onHand: 45 }, // the run that triggers the order
    { date: '2026-01-05', onHand: 30 },
    { date: '2026-01-06', onHand: 120 },
  ];
  const crossing = findTriggeringCrossing(trajectory, 50, '2026-01-05');
  assert.equal(crossing?.date, '2026-01-04');
});

test('findTriggeringCrossing returns null when stock never crossed', () => {
  const trajectory = [
    { date: '2026-01-01', onHand: 90 },
    { date: '2026-01-02', onHand: 80 },
  ];
  assert.equal(findTriggeringCrossing(trajectory, 50, '2026-01-02'), null);
});

test('replay returns null when an arrival covers demand', () => {
  const out = replay({
    startDate: '2026-01-01',
    startOnHand: 10,
    untilDate: '2026-01-10',
    arrivals: new Map([['2026-01-03', 100]]),
    dailyDemand: () => 4,
  });
  assert.equal(out, null);
});

// --- the graded investigation ----------------------------------------------

test('names the supplier lead-time slip as the primary cause', { skip }, () => {
  const { input } = fromSample(truth!.target_sku);
  const result = investigate(input);

  assert.ok(result.primary, 'an investigation must reach a primary cause');
  assert.equal(result.primary.cause, truth!.primary_cause);
  assert.equal(result.primary.verdict, 'supported');
  assert.ok(
    result.primary.sufficient,
    'the primary cause must be the one whose repair prevents the stockout',
  );
});

test('finds the stockout episode the simulation produced', { skip }, () => {
  const { input } = fromSample(truth!.target_sku);
  const result = investigate(input);

  assert.ok(result.episode);
  assert.equal(result.episode.from, truth!.stockout_started);
  assert.equal(result.episode.to, truth!.stockout_ended);
  assert.equal(result.episode.days, truth!.stockout_days);
});

test('identifies the purchase order that should have covered the gap', { skip }, () => {
  const { input } = fromSample(truth!.target_sku);
  const result = investigate(input);

  assert.ok(result.coveringPo);
  assert.equal(result.coveringPo.poId, truth!.fault_po);

  const slip = result.findings.find((f) => f.cause === 'supplier_lead_time_slip');
  assert.equal(slip?.numbers['actual_lead_days'], truth!.actual_lead_time_days);
  assert.equal(slip?.numbers['quoted_lead_days'], truth!.quoted_lead_time_days);
});

test('is not fooled by the demand distractor', { skip }, () => {
  const { input } = fromSample(truth!.target_sku);
  const result = investigate(input);

  const demand = result.findings.find((f) => f.cause === 'demand_increase');
  assert.ok(demand, 'demand must still be examined and reported');

  // Demand genuinely rose, so it is reported as supported...
  assert.equal(demand.verdict, 'supported');
  // ...but it is not the primary cause, and repairing it alone is not enough.
  assert.notEqual(result.primary?.cause, 'demand_increase');
  assert.equal(demand.sufficient, false);
  assert.ok(
    result.secondary.some((f) => f.cause === 'demand_increase'),
    'the demand rise belongs in the secondary factors',
  );
});

test('clears the reorder policy, which was correctly sized', { skip }, () => {
  const { input } = fromSample(truth!.target_sku);
  const result = investigate(input);

  const policy = result.findings.find((f) => f.cause === 'reorder_point_too_low');
  assert.equal(policy?.verdict, 'rejected');

  const notRaised = result.findings.find((f) => f.cause === 'po_not_raised');
  assert.equal(notRaised?.verdict, 'rejected');
});

test('a SKU that never ran out yields no cause and says so', { skip }, () => {
  const { input } = fromSample('SKU-1044');
  const result = investigate(input);

  assert.equal(result.episode, null);
  assert.equal(result.primary, null);
  assert.deepEqual(result.findings, []);
  assert.ok(result.caveats[0]?.includes('never reached zero'));
});
