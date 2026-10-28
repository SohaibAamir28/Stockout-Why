/**
 * Command line entry point.
 *
 *   npm run investigate -- --sku SKU-1041 --sample
 *   npm run investigate -- --sku SKU-1041 --explain
 *   npm run investigate -- --confirm <memory-id>
 *   npm run investigate -- --memories
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { hmemDir } from './config.ts';
import { confirm, openMemory, run, type Mode } from './investigate.ts';
import { renderReport } from './report.ts';

interface Args {
  sku: string;
  mode: Mode;
  explain: boolean;
  confirmId: string | null;
  confirmVerdict: 'confirmed' | 'unhelpful' | 'wrong';
  listMemories: boolean;
  forget: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sku: 'SKU-1041',
    mode: 'live',
    explain: false,
    confirmId: null,
    confirmVerdict: 'confirmed',
    listMemories: false,
    forget: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--sku':
        if (!value) throw new Error('--sku needs a value, e.g. --sku SKU-1041');
        args.sku = value;
        i += 1;
        break;
      case '--sample':
        args.mode = 'sample';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--explain':
        args.explain = true;
        break;
      case '--confirm':
        if (!value) throw new Error('--confirm needs a memory id');
        args.confirmId = value;
        i += 1;
        break;
      case '--verdict':
        if (value !== 'confirmed' && value !== 'unhelpful' && value !== 'wrong') {
          throw new Error('--verdict must be confirmed, unhelpful or wrong');
        }
        args.confirmVerdict = value;
        i += 1;
        break;
      case '--memories':
        args.listMemories = true;
        break;
      case '--forget':
        args.forget = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown option ${flag}. Try --help.`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
Stockout Why - explains why a product ran out, and cites the rows.

  --sku <SKU>        which product to investigate (default SKU-1041)
  --live             read through Zetaris (default); needs .env configured
  --sample           read the generated CSVs locally; no network, no keys
  --explain          also ask Nemotron, via Meterless Nightshift, for prose
  --memories         list what H-MEM has remembered so far
  --confirm <id>     record an analyst verdict on a remembered conclusion
  --verdict <v>      confirmed (default) | unhelpful | wrong
  --forget           clear the memory store before running
  --help             this message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.listMemories) {
    const memory = openMemory();
    const all = memory.store.all();
    if (all.length === 0) {
      console.log('H-MEM is empty. Run an investigation first.');
      return;
    }
    console.log(`H-MEM holds ${all.length} memory record(s):\n`);
    for (const record of all) {
      console.log(`  ${record.id}`);
      console.log(`    ${record.content}`);
      console.log(
        `    layer=${record.layer} confidence=${record.confidence.toFixed(2)} ` +
          `access=${record.accessCount} tags=${record.tags.join(',')}`,
      );
      console.log('');
    }
    return;
  }

  if (args.confirmId) {
    const memory = openMemory();
    const before = memory.store.get(args.confirmId);
    if (!before) {
      console.error(`No memory ${args.confirmId}. Use --memories to list them.`);
      process.exit(1);
    }
    const previous = before.confidence;
    const after = confirm(memory, args.confirmId, args.confirmVerdict);
    console.log(
      `Recorded "${args.confirmVerdict}" on ${args.confirmId}: confidence ` +
        `${previous.toFixed(2)} -> ${after.confidence.toFixed(2)}` +
        `${after.tags.includes('review') ? ' (flagged for review)' : ''}`,
    );
    console.log(
      'The next investigation of this supplier will rank this memory accordingly.',
    );
    return;
  }

  if (args.forget) {
    const file = join(hmemDir, 'hmem.json');
    if (existsSync(file)) {
      rmSync(file);
      console.log(`Cleared ${file}.\n`);
    }
  }

  const result = await run({
    sku: args.sku,
    mode: args.mode,
    explain: args.explain,
  });

  console.log(renderReport(result));

  if (result.recorded) {
    console.log(`  Remembered as ${result.recorded.id}.`);
    console.log(
      `  Confirm or correct it:  npm run investigate -- --confirm ${result.recorded.id} --verdict confirmed`,
    );
    console.log('');
  }
}

main().catch((error: Error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
