/**
 * H-MEM conformance, run locally.
 *
 * This mirrors the assertions in the upstream runner
 * (vendor/meterless/engines/hmem/conformance/runner.ts) case for case, and it
 * reads the SAME official vectors file (a pinned copy in tests/fixtures, see
 * NOTICE.md there), so the arithmetic, deltas, gates and boundaries being
 * checked are the spec's, not ours.
 *
 * Running it here, under `npm test`, means the checks are reproducible from a
 * clean clone without executing vendored third-party code.
 *
 * The upstream runner remains the canonical check and is run separately:
 *   HMEM_IMPL=<abs>/src/hmem/index.ts npx tsx vendor/meterless/engines/hmem/conformance/runner.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { HMEM } from '../src/hmem/index.ts';
import type { Memory } from '../src/hmem/types.ts';

const VECTORS_PATH = join('tests', 'fixtures', 'hmem-vectors.json');

interface Vectors {
  clock: number;
  sections: Record<string, Record<string, any>[]>;
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;
const T0 = vectors.clock;
const DAY = 24 * 60 * 60 * 1000;

const approx = (a: number, b: number, eps = 1e-9): boolean =>
  Math.abs(a - b) < eps;

const section = (name: string): Record<string, any>[] => {
  const cases = vectors.sections[name];
  assert.ok(cases && cases.length > 0, `vectors section "${name}" is missing`);
  return cases;
};

// --- record-validation -----------------------------------------------------

for (const testCase of section('record-validation')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    const hmem = new HMEM({ clock: () => T0 });
    let rejected = false;
    try {
      hmem.add({ content: testCase.input.content, source: testCase.input.source });
    } catch {
      rejected = true;
    }
    assert.equal(
      rejected,
      testCase.expect === 'reject',
      `expected ${testCase.expect}, got ${rejected ? 'reject' : 'accept'}`,
    );
  });
}

// --- feedback-deltas -------------------------------------------------------

for (const testCase of section('feedback-deltas')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    const hmem = new HMEM({ clock: () => T0 });
    const memory = hmem.add({
      content: 'feedback target record',
      confidence: testCase.start,
      source: 'conformance',
    });
    const accessBefore = memory.accessCount;

    hmem.feedback(memory.id, testCase.kind);
    const after = hmem.store.get(memory.id)!;

    assert.ok(
      approx(after.confidence, testCase.expectConfidence),
      `confidence ${after.confidence}, expected ${testCase.expectConfidence}`,
    );
    if (testCase.expectAccessDelta !== undefined) {
      assert.equal(
        after.accessCount - accessBefore,
        testCase.expectAccessDelta,
        'accessCount delta',
      );
    }
    if (testCase.expectTag) {
      assert.ok(
        after.tags.includes(testCase.expectTag),
        `missing tag ${testCase.expectTag}`,
      );
    }
  });
}

// --- ranking-order ---------------------------------------------------------

for (const testCase of section('ranking-order')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    const hmem = new HMEM({ clock: () => T0 });
    const byKey: Record<string, Memory> = {};

    for (const record of testCase.records) {
      byKey[record.key] = hmem.add({
        content: record.content,
        confidence: record.confidence,
        layer: record.layer,
        source: 'conformance',
      });
    }
    // The suite mutates the returned record directly, so add() must hand back
    // the live stored object rather than a copy.
    for (const record of testCase.records) {
      if (record.supersededByKey) {
        byKey[record.key]!.supersededBy = byKey[record.supersededByKey]!.id;
      }
    }

    const result = hmem.query(testCase.query, { threshold: 0, topN: 10 });
    const order = result.memories.map((hit) => hit.memory.id);
    const expected = (testCase.expectOrder as string[]).map((key) => byKey[key]!.id);

    for (let i = 0; i < expected.length - 1; i += 1) {
      assert.ok(
        order.indexOf(expected[i]!) < order.indexOf(expected[i + 1]!),
        `expected ${testCase.expectOrder[i]} before ${testCase.expectOrder[i + 1]}, got [${order.join(', ')}]`,
      );
    }
  });
}

// --- sleep-guardrails ------------------------------------------------------

for (const testCase of section('sleep-guardrails')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    let now = T0;
    const hmem = new HMEM({ clock: () => now });
    const byKey: Record<string, Memory> = {};

    for (const record of testCase.records) {
      byKey[record.key] = hmem.add({
        content: record.content,
        source: record.source,
        derivedFrom: record.derivedFrom,
      });
    }

    now = T0 + testCase.ageDays * DAY;

    const before = JSON.stringify(hmem.store.all().map((m) => m.id).sort());
    const preview = hmem.sleep.preview();
    assert.equal(
      JSON.stringify(hmem.store.all().map((m) => m.id).sort()),
      before,
      'preview must not mutate the store',
    );

    for (const key of testCase.expectArchived) {
      assert.ok(
        preview.toArchive.includes(byKey[key]!.id),
        `${key} should be archivable`,
      );
    }
    for (const key of testCase.expectProtected) {
      assert.ok(
        !preview.toArchive.includes(byKey[key]!.id),
        `${key} is guardrail-protected and must not archive`,
      );
    }

    const report = hmem.sleep.execute(preview);
    for (const key of testCase.expectProtected) {
      assert.ok(
        hmem.store.get(byKey[key]!.id) !== undefined,
        `${key} was deleted despite guardrails`,
      );
    }
    assert.ok(
      typeof report.backupId === 'string' && report.backupId.length > 0,
      'execute must return a backupId',
    );
  });
}

// --- conflict-gate ---------------------------------------------------------

for (const testCase of section('conflict-gate')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    const hmem = new HMEM({ clock: () => T0 });
    const a = hmem.add({
      content: testCase.a.content,
      confidence: testCase.a.confidence,
      source: 'conformance',
    });
    const b = hmem.add({
      content: testCase.b.content,
      confidence: testCase.b.confidence,
      source: 'conformance',
    });

    const found = hmem.conflicts.scan();
    assert.ok(
      found.length > 0,
      'opposing always/never pair on similar content must be detected',
    );

    const outcome = hmem.conflicts.autoResolve(found[0]!);
    assert.ok(
      outcome === 'resolved' || outcome === 'queued',
      `outcome must be resolved or queued, got ${outcome}`,
    );

    if (outcome === 'resolved') {
      const loser = [hmem.store.get(a.id), hmem.store.get(b.id)].find(
        (memory) => memory?.supersededBy,
      );
      assert.ok(loser !== undefined, 'resolved conflicts must mark the loser supersededBy');
    }
    assert.ok(
      hmem.store.get(a.id) && hmem.store.get(b.id),
      'conflict resolution must never delete records',
    );
  });
}

// --- ledger-audit ----------------------------------------------------------

for (const testCase of section('ledger-audit')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    const hmem = new HMEM({ clock: () => T0 });
    const memory = hmem.add({
      content: 'audited record',
      confidence: testCase.start,
      source: 'conformance',
    });
    hmem.feedback(memory.id, testCase.kind);

    const history = hmem.ledger.history(memory.id);
    const actions = history.map((entry) => entry.action);
    assert.deepEqual(actions, testCase.expectActions, 'ledger actions in order');

    const last = history[history.length - 1]!;
    assert.ok(
      approx(last.previousState?.confidence as number, testCase.expectPrev),
      `previousState.confidence ${last.previousState?.confidence}, expected ${testCase.expectPrev}`,
    );
    assert.ok(
      approx(last.newState?.confidence as number, testCase.expectNew),
      `newState.confidence ${last.newState?.confidence}, expected ${testCase.expectNew}`,
    );
  });
}

// --- dream-boundary --------------------------------------------------------

for (const testCase of section('dream-boundary')) {
  test(`${testCase.id} ${testCase.description}`, () => {
    const hmem = new HMEM({ clock: () => T0 });
    for (const record of testCase.records) {
      hmem.add({ content: record.content, type: record.type, source: 'conformance' });
    }

    const countBefore = hmem.store.all().length;
    const proposals = hmem.dreaming.dream();
    assert.ok(
      proposals.length > 0,
      'two related preferences must produce at least one proposal',
    );
    assert.equal(
      hmem.store.all().length,
      countBefore,
      'dreaming must not materialize anything before approval',
    );

    const created = hmem.dreaming.approve(proposals[0]!.id);
    if (created) {
      assert.equal(created.layer, 'long_term', 'approved proposals materialize as long_term');
      assert.ok(
        (created.derivedFrom ?? []).length > 0,
        'approved proposals carry derivedFrom lineage',
      );
    }
  });
}
