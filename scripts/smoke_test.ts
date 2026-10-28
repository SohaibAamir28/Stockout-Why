/**
 * The three checks from the Participant Setup Guide, for this project's stack.
 *
 *   npx tsx scripts/smoke_test.ts
 *
 * DATA  Zetaris answers over REST
 * POWER Meterless Nightshift is reachable, authenticates, and a model replies
 * BUILD H-MEM is integrated and its conformance checks pass
 *
 * Each check prints PASS or FAIL with the reason. A FAIL names the setting to
 * fix rather than just the exception.
 */

import { listModels, chat, isNemotron } from '../src/nightshift.ts';
import { zetaris } from '../src/config.ts';
import { runSql } from '../src/zetaris.ts';
import { HMEM } from '../src/hmem/index.ts';

interface Check {
  layer: 'DATA' | 'BUILD' | 'POWER';
  name: string;
  run: () => Promise<string>;
}

const checks: Check[] = [
  {
    layer: 'DATA',
    name: 'Zetaris runs SQL over its REST API',
    run: async () => {
      const evidence = await runSql('smoke: select 1', 'SELECT 1', 1);
      const value = evidence.rows[0]?.[0];
      if (String(value) !== '1') {
        throw new Error(`expected 1, got ${JSON.stringify(value)}`);
      }
      return 'SELECT 1 returned one row';
    },
  },
  {
    layer: 'DATA',
    name: 'the project tables are registered',
    run: async () => {
      const evidence = await runSql(
        'smoke: count the ledger',
        `SELECT COUNT(*) FROM ${zetaris.source}.stock_ledger`,
        1,
      );
      const count = Number(evidence.rows[0]?.[0] ?? 0);
      if (count === 0) {
        throw new Error(
          'stock_ledger is empty. Run: npx tsx scripts/register_zetaris.ts --execute',
        );
      }
      return `stock_ledger holds ${count} rows`;
    },
  },
  {
    layer: 'POWER',
    name: 'Nightshift exposes models',
    run: async () => {
      const models = await listModels();
      if (models.length === 0) {
        throw new Error(
          'GET /v1/models returned nothing. Assign a lane in Nightshift > NIGHT > LANES.',
        );
      }
      return `${models.length} route(s): ${models.slice(0, 4).join(', ')}`;
    },
  },
  {
    layer: 'POWER',
    name: 'a model answers a real request',
    run: async () => {
      const result = await chat(
        [{ role: 'user', content: 'Reply with the single word: ready' }],
        { maxTokens: 20 },
      );
      const routed = result.call.routedModel ?? 'unknown';
      const nemotron = isNemotron(result.call)
        ? 'Nemotron'
        : 'NOT Nemotron - pin a Nemotron lane for award evidence';
      return `answered by ${routed} (${nemotron}) in ${result.call.latencyMs} ms`;
    },
  },
  {
    layer: 'BUILD',
    name: 'H-MEM stores and recalls across a restart',
    run: async () => {
      const dir = '.hmem-smoke';
      const first = new HMEM({ dir });
      const written = first.add({
        content: 'smoke test: supplier SUP-01 missed its quoted lead time',
        source: 'smoke-test',
        tags: ['smoke'],
      });

      // A second instance reads what the first one persisted.
      const second = new HMEM({ dir });
      const found = second.query('which supplier missed its lead time', {
        threshold: 0.1,
        topN: 3,
      });
      if (!found.memories.some((hit) => hit.memory.id === written.id)) {
        throw new Error('a memory written in one session was not recalled in the next');
      }
      return `recalled ${written.id} in a fresh session`;
    },
  },
  {
    layer: 'BUILD',
    name: 'H-MEM applies the spec feedback deltas',
    run: async () => {
      const hmem = new HMEM();
      const memory = hmem.add({
        content: 'delta check',
        confidence: 0.7,
        source: 'smoke-test',
      });
      hmem.feedback(memory.id, 'wrong');
      const after = hmem.store.get(memory.id)!;
      if (Math.abs(after.confidence - 0.5) > 1e-9) {
        throw new Error(`wrong should give 0.50, got ${after.confidence}`);
      }
      if (!after.tags.includes('review')) {
        throw new Error('wrong should add the review tag');
      }
      return 'wrong: 0.70 -> 0.50 and tagged for review';
    },
  },
];

async function main(): Promise<void> {
  console.log('\nStockout Why - setup check\n');
  let failures = 0;

  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`PASS  ${check.layer.padEnd(5)} ${check.name}`);
      console.log(`               ${detail}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL  ${check.layer.padEnd(5)} ${check.name}`);
      console.log(`               ${(error as Error).message}`);
    }
  }

  console.log(
    `\n${checks.length - failures}/${checks.length} checks passed.\n`,
  );
  if (failures > 0) {
    console.log('The BUILD checks need no configuration and should always pass.');
    console.log('DATA failures point at .env or Zetaris; POWER failures at Nightshift.\n');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: Error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
