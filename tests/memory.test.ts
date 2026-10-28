/**
 * The Build requirement, as a test.
 *
 * H-MEM has to be integrated in a working feature, not merely present. The
 * feature is this: the agent remembers what earlier investigations concluded
 * about a supplier, and an analyst's verdict changes how highly that memory
 * ranks next time.
 *
 * These tests exercise that through the real application entry point, in
 * sample mode, against a throwaway memory directory. No network, no keys.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { confirm, openMemory, recall, run } from '../src/investigate.ts';

const SKU = 'SKU-1041';
const dataReady = existsSync(join('data', 'generated', 'ground_truth.json'));
const skip = dataReady ? false : 'run `npm run gen-data` first';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'stockout-hmem-'));
}

test('the first investigation has nothing to remember', { skip }, async () => {
  const dir = freshDir();
  try {
    const result = await run({ sku: SKU, mode: 'sample', memoryDir: dir });
    assert.deepEqual(result.priors, []);
    assert.ok(result.recorded, 'it must record what it concluded');
    assert.match(result.recorded.content, /supplier_lead_time_slip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a later investigation recalls the earlier conclusion', { skip }, async () => {
  const dir = freshDir();
  try {
    const first = await run({ sku: SKU, mode: 'sample', memoryDir: dir });
    const second = await run({ sku: SKU, mode: 'sample', memoryDir: dir });

    assert.ok(
      second.priors.length > 0,
      'the second run must recall something from the first',
    );
    assert.ok(
      second.priors.some((prior) => prior.memoryId === first.recorded!.id),
      "the first run's conclusion must be among the recalled priors",
    );
    assert.match(second.priors[0]!.content, /SUP-01/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory survives a new process, not just a new object', { skip }, async () => {
  const dir = freshDir();
  try {
    const first = await run({ sku: SKU, mode: 'sample', memoryDir: dir });

    // Read the file straight off disk: this is what makes it cross-session
    // rather than an in-memory cache that happens to be shared.
    const onDisk = JSON.parse(readFileSync(join(dir, 'hmem.json'), 'utf8')) as {
      memories: { id: string }[];
    };
    assert.ok(
      onDisk.memories.some((memory) => memory.id === first.recorded!.id),
      'the conclusion must be persisted to disk',
    );

    // A completely separate engine instance, as a fresh process would build.
    const reopened = openMemory(dir);
    const priors = recall(reopened, 'SUP-01', SKU);
    assert.ok(
      priors.some((prior) => prior.memoryId === first.recorded!.id),
      'a fresh engine must recall the persisted conclusion',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an analyst's verdict moves confidence by the spec's delta", { skip }, async () => {
  const dir = freshDir();
  try {
    const result = await run({ sku: SKU, mode: 'sample', memoryDir: dir });
    const id = result.recorded!.id;

    const memory = openMemory(dir);
    const before = memory.store.get(id)!.confidence;

    // feedback() hands back the live stored record, which the conformance
    // suite relies on, so read the value out before mutating it again.
    const afterConfirm = confirm(memory, id, 'confirmed').confidence;
    assert.ok(
      Math.abs(afterConfirm - (before + 0.05)) < 1e-9,
      `confirming must add exactly 0.05, got ${before} -> ${afterConfirm}`,
    );

    const rejected = confirm(memory, id, 'wrong');
    assert.ok(
      Math.abs(rejected.confidence - (afterConfirm - 0.2)) < 1e-9,
      `marking it wrong must subtract exactly 0.20, got ${afterConfirm} -> ${rejected.confidence}`,
    );
    assert.ok(
      rejected.tags.includes('review'),
      'a wrong verdict must flag the memory for review',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a confirmed memory ranks above an unconfirmed one', { skip }, async () => {
  const dir = freshDir();
  try {
    const memory = openMemory(dir);
    const weak = memory.add({
      content: 'SKU-9001 from SUP-01 ran out because demand rose sharply',
      source: 'test:weak',
      tags: ['stockout', 'SUP-01'],
    });
    const strong = memory.add({
      content: 'SKU-9002 from SUP-01 ran out because the supplier missed its lead time',
      source: 'test:strong',
      tags: ['stockout', 'SUP-01'],
    });

    confirm(memory, strong.id, 'confirmed');
    confirm(memory, weak.id, 'wrong');

    const hits = memory.query('why did stock run out for supplier SUP-01', {
      threshold: 0,
      topN: 10,
    });
    const order = hits.memories.map((hit) => hit.memory.id);
    assert.ok(
      order.indexOf(strong.id) < order.indexOf(weak.id),
      `the confirmed memory must rank first, got [${order.join(', ')}]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
