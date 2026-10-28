/**
 * Puts the generated dataset behind Zetaris.
 *
 *   npx tsx scripts/register_zetaris.ts            # write the SQL, change nothing
 *   npx tsx scripts/register_zetaris.ts --execute  # load it and register it
 *
 * The data lives where a retailer's data actually lives: in an operational
 * database. --execute does four things:
 *
 *   1. starts that database, a Postgres container on the Zetaris Docker
 *      network (infra/retail-db.compose.yml), with no port on the host
 *   2. loads the six tables into it from the generated CSVs
 *   3. registers it in Zetaris as a datasource and imports its tables, so
 *      Zetaris's query engine reads it in place (CREATE DATASOURCE, then
 *      REGISTER DATASOURCE TABLES)
 *   4. counts every table back THROUGH Zetaris and compares with the CSVs,
 *      so a silent short load can't pass
 *
 * From then on the agent reads `<ZETARIS_SOURCE>.<table>` over the Zetaris
 * REST API and never touches the database itself.
 *
 * Re-running is safe: the tables are dropped and reloaded in one transaction,
 * and an "already exists" from Zetaris is treated as done.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { retailDb, zetaris } from '../src/config.ts';
import { readCsv, type Row } from '../src/csv.ts';
import { runSql } from '../src/zetaris.ts';

const SAMPLE_DIR = join('data', 'generated');
const OUT_FILE = join(SAMPLE_DIR, 'retail_db.sql');
const COMPOSE_FILE = join('infra', 'retail-db.compose.yml');
const CONTAINER = 'stockout-retail-db';
/** Rows per INSERT. */
const BATCH = 200;

type ColumnType = 'TEXT' | 'INTEGER' | 'DOUBLE PRECISION' | 'DATE';

interface TableSpec {
  name: string;
  file: string;
  columns: { name: string; type: ColumnType }[];
}

const TABLES: TableSpec[] = [
  {
    name: 'suppliers',
    file: 'suppliers.csv',
    columns: [
      { name: 'supplier_id', type: 'TEXT' },
      { name: 'supplier_name', type: 'TEXT' },
      { name: 'quoted_lead_time_days', type: 'INTEGER' },
    ],
  },
  {
    name: 'products',
    file: 'products.csv',
    columns: [
      { name: 'sku', type: 'TEXT' },
      { name: 'product_name', type: 'TEXT' },
      { name: 'supplier_id', type: 'TEXT' },
      { name: 'unit_cost', type: 'DOUBLE PRECISION' },
    ],
  },
  {
    name: 'inventory_policy',
    file: 'inventory_policy.csv',
    columns: [
      { name: 'sku', type: 'TEXT' },
      { name: 'reorder_point', type: 'INTEGER' },
      { name: 'reorder_qty', type: 'INTEGER' },
    ],
  },
  {
    name: 'sales_daily',
    file: 'sales_daily.csv',
    columns: [
      { name: 'sale_date', type: 'DATE' },
      { name: 'sku', type: 'TEXT' },
      { name: 'units_sold', type: 'INTEGER' },
    ],
  },
  {
    name: 'stock_ledger',
    file: 'stock_ledger.csv',
    columns: [
      { name: 'ledger_date', type: 'DATE' },
      { name: 'sku', type: 'TEXT' },
      { name: 'units_on_hand', type: 'INTEGER' },
    ],
  },
  {
    name: 'purchase_orders',
    file: 'purchase_orders.csv',
    columns: [
      { name: 'po_id', type: 'TEXT' },
      { name: 'sku', type: 'TEXT' },
      { name: 'supplier_id', type: 'TEXT' },
      { name: 'qty_ordered', type: 'INTEGER' },
      { name: 'ordered_date', type: 'DATE' },
      { name: 'promised_date', type: 'DATE' },
      { name: 'received_date', type: 'DATE' },
      { name: 'qty_received', type: 'INTEGER' },
    ],
  },
];

/** Single-quoted and escaped, or NULL for a blank. */
function literal(value: string | undefined, type: ColumnType): string {
  if (value === undefined || value === '') return 'NULL';
  if (type === 'INTEGER' || type === 'DOUBLE PRECISION') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Expected a number, got ${JSON.stringify(value)}`);
    }
    return String(parsed);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function tableSql(table: TableSpec, rows: Row[]): string {
  const columns = table.columns
    .map((column) => `  ${column.name} ${column.type}`)
    .join(',\n');
  const columnList = table.columns.map((column) => column.name).join(', ');
  const parts = [
    `DROP TABLE IF EXISTS ${table.name};`,
    `CREATE TABLE ${table.name} (\n${columns}\n);`,
  ];
  for (let start = 0; start < rows.length; start += BATCH) {
    const values = rows
      .slice(start, start + BATCH)
      .map(
        (row) =>
          `  (${table.columns
            .map((column) => literal(row[column.name], column.type))
            .join(', ')})`,
      )
      .join(',\n');
    parts.push(`INSERT INTO ${table.name} (${columnList}) VALUES\n${values};`);
  }
  return parts.join('\n\n');
}

/** The Zetaris statements, in order. The password is masked when printed. */
function zetarisStatements(password: string): { label: string; sql: string }[] {
  return [
    {
      label: `CREATE DATASOURCE ${zetaris.source}`,
      sql:
        `CREATE DATASOURCE ${zetaris.source} DESCRIBE BY "Retail operations database" OPTIONS (\n` +
        `  jdbcdriver "org.postgresql.Driver",\n` +
        `  jdbcurl "${retailDb.jdbcUrl}",\n` +
        `  username "retail",\n` +
        `  password "${password}",\n` +
        `  fetchsize "1000"\n)`,
    },
    {
      label: `REGISTER DATASOURCE TABLES FROM ${zetaris.source}`,
      sql: `REGISTER DATASOURCE TABLES FROM ${zetaris.source}`,
    },
  ];
}

/** Creates RETAIL_DB_PASSWORD in .env the first time, so nobody has to invent one. */
function ensurePassword(): void {
  if (process.env['RETAIL_DB_PASSWORD']?.trim()) return;
  if (!existsSync('.env')) {
    throw new Error('No .env found. Copy .env.example to .env first.');
  }
  const password = randomBytes(18).toString('hex');
  const current = readFileSync('.env', 'utf8');
  appendFileSync(
    '.env',
    `${current.endsWith('\n') ? '' : '\n'}\n# Retail database (local Docker only). Generated by register_zetaris.ts.\nRETAIL_DB_PASSWORD=${password}\n`,
  );
  process.env['RETAIL_DB_PASSWORD'] = password;
  console.log('Generated RETAIL_DB_PASSWORD and saved it to .env.');
}

function docker(args: string[], input?: string): string {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not run docker: ${result.error.message}. Is Docker Desktop running?`);
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const alreadyExists = (message: string): boolean => /already exist/i.test(message);

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');

  const counts = new Map<string, number>();
  const sections: string[] = [];
  for (const table of TABLES) {
    const rows = readCsv(join(SAMPLE_DIR, table.file));
    if (rows.length === 0) {
      throw new Error(`${table.file} is empty. Run \`npm run gen-data\` first.`);
    }
    counts.set(table.name, rows.length);
    sections.push(tableSql(table, rows));
    console.log(`${table.name.padEnd(18)} ${String(rows.length).padStart(5)} rows`);
  }

  mkdirSync(SAMPLE_DIR, { recursive: true });
  const sql =
    `-- Generated by scripts/register_zetaris.ts. Loads the retail database (Postgres).\n` +
    `BEGIN;\n\n${sections.join('\n\n')}\n\nCOMMIT;\n`;
  writeFileSync(OUT_FILE, sql, 'utf8');
  console.log(`\nWrote ${OUT_FILE}`);

  if (!execute) {
    console.log('\nNothing was changed. With --execute this script will:');
    console.log(`  1. start ${CONTAINER} (${COMPOSE_FILE})`);
    console.log(`  2. load ${OUT_FILE} into it`);
    for (const [index, statement] of zetarisStatements('<RETAIL_DB_PASSWORD>').entries()) {
      console.log(`  ${index + 3}. run in Zetaris: ${statement.label}`);
    }
    console.log(`  5. count each table through Zetaris and compare with the CSVs`);
    return;
  }

  ensurePassword();

  console.log(`\n[1/4] Starting ${CONTAINER}...`);
  docker(['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait']);

  console.log(`[2/4] Loading the six tables...`);
  docker(
    ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'retail', '-d', 'retail'],
    sql,
  );

  console.log(`[3/4] Registering it in Zetaris as "${zetaris.source}"...`);
  for (const statement of zetarisStatements(retailDb.password)) {
    try {
      await runSql(statement.label, statement.sql, 1);
      console.log(`      done: ${statement.label}`);
    } catch (error) {
      const message = (error as Error).message;
      if (!alreadyExists(message)) {
        console.error(`\nFAILED: ${statement.label}\n  ${message}`);
        console.error(
          `\nYou can run the same statement in the SQL Editor at ${zetaris.baseUrl}` +
            ' (the password is RETAIL_DB_PASSWORD in .env).',
        );
        process.exit(1);
      }
      console.log(`      already there: ${statement.label}`);
    }
  }

  console.log(`[4/4] Counting every table through Zetaris...`);
  let mismatches = 0;
  for (const [table, expected] of counts) {
    const evidence = await runSql(
      `count ${table}`,
      `SELECT COUNT(*) FROM ${zetaris.source}.${table}`,
      1,
    );
    const actual = Number(evidence.rows[0]?.[0]);
    const ok = actual === expected;
    if (!ok) mismatches += 1;
    console.log(
      `      ${ok ? 'ok  ' : 'DIFF'} ${zetaris.source}.${table.padEnd(18)} ${String(actual).padStart(5)} / ${expected}`,
    );
  }

  if (mismatches > 0) {
    console.error(`\n${mismatches} table(s) came back with a different row count. Not ready.`);
    process.exit(1);
  }
  console.log('\nAll six tables are readable through Zetaris. Now: npm run smoke');
}

main().catch((error: Error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
