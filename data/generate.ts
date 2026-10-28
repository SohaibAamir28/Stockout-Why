/**
 * Generates the retailer dataset the agent investigates.
 *
 * The data is synthetic, but it is SIMULATED day by day rather than
 * hand-written: demand draws down stock, the reorder policy raises a purchase
 * order when stock crosses the reorder point, and stock only returns when a
 * PO is actually received. So sales, on-hand and deliveries cannot contradict
 * one another, and the stockout's timing and length are consequences rather
 * than constants.
 *
 * One fault is injected: a single purchase order from SUP-01 for the target
 * SKU takes far longer than the supplier's quoted lead time. A modest demand
 * rise is layered on top as a DISTRACTOR - genuine, but far too small to
 * empty the shelf on its own. A good investigation names the lead-time slip
 * as primary and explains why demand is secondary.
 *
 * The resulting ground truth is written to ground_truth.json for the eval.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join('data', 'generated');
const DAYS = 180;
const START = new Date('2026-04-01T00:00:00Z');

const TARGET_SKU = 'SKU-1041';
/** The injected fault: this much slower than quoted, on one PO. */
const FAULT_EXTRA_DAYS = 12;
/** The fault hits the first PO raised on or after this day. */
const FAULT_AFTER_DAY = 130;
/** The distractor: demand lift on the target around the fault window. */
const DEMAND_LIFT = 1.3;
const LIFT_WINDOW_DAYS = 21;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261027);

const iso = (day: number): string =>
  new Date(START.getTime() + day * 86_400_000).toISOString().slice(0, 10);

interface Supplier {
  supplier_id: string;
  supplier_name: string;
  quoted_lead_time_days: number;
}
interface Product {
  sku: string;
  product_name: string;
  supplier_id: string;
  unit_cost: number;
  baseDemand: number;
}

const suppliers: Supplier[] = [
  { supplier_id: 'SUP-01', supplier_name: 'Northwind Trading', quoted_lead_time_days: 7 },
  { supplier_id: 'SUP-02', supplier_name: 'Lahore Dry Goods', quoted_lead_time_days: 10 },
  { supplier_id: 'SUP-03', supplier_name: 'Karachi Imports', quoted_lead_time_days: 14 },
];

const products: Product[] = [
  { sku: 'SKU-1041', product_name: 'Olive Oil 1L',        supplier_id: 'SUP-01', unit_cost: 820,  baseDemand: 24 },
  { sku: 'SKU-1042', product_name: 'Basmati Rice 5kg',    supplier_id: 'SUP-01', unit_cost: 1450, baseDemand: 16 },
  { sku: 'SKU-1043', product_name: 'Green Tea 250g',      supplier_id: 'SUP-02', unit_cost: 390,  baseDemand: 11 },
  { sku: 'SKU-1044', product_name: 'Tomato Paste 400g',   supplier_id: 'SUP-02', unit_cost: 160,  baseDemand: 30 },
  { sku: 'SKU-1045', product_name: 'Almonds 500g',        supplier_id: 'SUP-03', unit_cost: 1980, baseDemand: 7 },
  { sku: 'SKU-1046', product_name: 'Instant Coffee 200g', supplier_id: 'SUP-03', unit_cost: 1120, baseDemand: 9 },
];

const supplierOf = (sku: string): Supplier => {
  const product = products.find((p) => p.sku === sku)!;
  return suppliers.find((s) => s.supplier_id === product.supplier_id)!;
};

// The reorder point covers the QUOTED lead time with a 2x buffer. That buffer
// is deliberately generous enough to absorb the demand lift at the quoted lead
// time, so ordinary trading never empties the shelf. Only a delivery far
// outside the quoted window can. This is what makes the policy defensible and
// leaves the supplier as the sole explanation.
const REORDER_BUFFER = 2.0;

interface PolicyRow { sku: string; reorder_point: number; reorder_qty: number }
const policy: PolicyRow[] = products.map((product) => {
  const supplier = supplierOf(product.sku);
  return {
    sku: product.sku,
    reorder_point: Math.round(
      product.baseDemand * supplier.quoted_lead_time_days * REORDER_BUFFER,
    ),
    reorder_qty: Math.round(product.baseDemand * 30),
  };
});
const policyOf = (sku: string): PolicyRow => policy.find((p) => p.sku === sku)!;

interface PoRow {
  po_id: string;
  sku: string;
  supplier_id: string;
  qty_ordered: number;
  ordered_date: string;
  promised_date: string;
  received_date: string | null;
  qty_received: number | null;
}
interface SaleRow { sale_date: string; sku: string; units_sold: number }
interface LedgerRow { ledger_date: string; sku: string; units_on_hand: number }

const orders: PoRow[] = [];
const sales: SaleRow[] = [];
const ledger: LedgerRow[] = [];

let poSeq = 500;
let faultPoId: string | null = null;
let faultApplied = false;

for (const product of products) {
  const supplier = supplierOf(product.sku);
  const { reorder_point, reorder_qty } = policyOf(product.sku);

  let onHand = reorder_qty;
  /** Receipts landing on a given day: day -> units. */
  const arrivals = new Map<number, number>();
  let openPo = false;

  for (let day = 0; day < DAYS; day += 1) {
    // 1. Receive anything due today, before selling.
    const arriving = arrivals.get(day);
    if (arriving !== undefined) {
      onHand += arriving;
      openPo = false;
    }

    // 2. Demand for today.
    let demand = product.baseDemand;
    const weekday = new Date(START.getTime() + day * 86_400_000).getUTCDay();
    if (weekday === 0 || weekday === 6) demand *= 1.25;
    if (
      product.sku === TARGET_SKU &&
      day >= FAULT_AFTER_DAY - LIFT_WINDOW_DAYS &&
      day < FAULT_AFTER_DAY + 40
    ) {
      demand *= DEMAND_LIFT;
    }
    const wanted = Math.max(0, Math.round(demand * (0.8 + rand() * 0.4)));

    // 3. Sell only what is on the shelf. This is what makes a stockout real.
    const sold = Math.min(wanted, onHand);
    onHand -= sold;

    sales.push({ sale_date: iso(day), sku: product.sku, units_sold: sold });
    ledger.push({ ledger_date: iso(day), sku: product.sku, units_on_hand: onHand });

    // 4. Replenish when we cross the reorder point and nothing is in flight.
    if (onHand <= reorder_point && !openPo) {
      poSeq += 1;
      const poId = `PO-${poSeq}`;

      const isFault =
        product.sku === TARGET_SKU && day >= FAULT_AFTER_DAY && !faultApplied;
      if (isFault) {
        faultApplied = true;
        faultPoId = poId;
      }

      const jitter = Math.round((rand() - 0.5) * 3);
      const actualLead =
        supplier.quoted_lead_time_days + (isFault ? FAULT_EXTRA_DAYS : jitter);
      const receiveDay = day + actualLead;

      orders.push({
        po_id: poId,
        sku: product.sku,
        supplier_id: supplier.supplier_id,
        qty_ordered: reorder_qty,
        ordered_date: iso(day),
        promised_date: iso(day + supplier.quoted_lead_time_days),
        received_date: receiveDay < DAYS ? iso(receiveDay) : null,
        qty_received: receiveDay < DAYS ? reorder_qty : null,
      });

      if (receiveDay < DAYS) arrivals.set(receiveDay, reorder_qty);
      openPo = true;
    }
  }
}

// --- derive the ground truth from what the simulation actually produced -----

/** Contiguous runs of days at zero stock. */
function episodes(rows: LedgerRow[]): { from: string; to: string; days: number }[] {
  const found: { from: string; to: string; days: number }[] = [];
  let run: LedgerRow[] = [];
  const flush = () => {
    if (run.length > 0) {
      found.push({
        from: run[0]!.ledger_date,
        to: run.at(-1)!.ledger_date,
        days: run.length,
      });
      run = [];
    }
  };
  for (const row of rows) {
    if (row.units_on_hand === 0) run.push(row);
    else flush();
  }
  flush();
  return found;
}

const targetLedger = ledger.filter((row) => row.sku === TARGET_SKU);
const targetEpisodes = episodes(targetLedger);

// The scenario is only usable if the fault is the SOLE cause of a stockout.
// Fail loudly rather than shipping a dataset that tells two stories.
if (targetEpisodes.length !== 1) {
  throw new Error(
    `Scenario invalid: ${TARGET_SKU} has ${targetEpisodes.length} stockout ` +
      `episodes, expected exactly 1. ${JSON.stringify(targetEpisodes)}`,
  );
}
for (const product of products) {
  if (product.sku === TARGET_SKU) continue;
  const other = episodes(ledger.filter((row) => row.sku === product.sku));
  if (other.length > 0) {
    throw new Error(
      `Scenario invalid: ${product.sku} should never stock out, but has ` +
        `${other.length} episode(s). ${JSON.stringify(other)}`,
    );
  }
}

const episode = targetEpisodes[0]!;
const faultPo = orders.find((order) => order.po_id === faultPoId)!;

// The fault PO must be the one whose late arrival ends the stockout.
if (faultPo.received_date !== null) {
  const endedBy = new Date(Date.parse(episode.to) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (faultPo.received_date !== endedBy) {
    throw new Error(
      `Scenario invalid: stockout ends ${episode.to} but the fault PO ` +
        `${faultPo.po_id} arrived ${faultPo.received_date}, not ${endedBy}.`,
    );
  }
}
if (faultPo.ordered_date > episode.from) {
  throw new Error(
    `Scenario invalid: the fault PO was raised ${faultPo.ordered_date}, ` +
      `after the stockout began ${episode.from}. The policy, not the ` +
      `supplier, would be at fault.`,
  );
}

const leadActual =
  faultPo.received_date === null
    ? null
    : Math.round(
        (Date.parse(faultPo.received_date) - Date.parse(faultPo.ordered_date)) /
          86_400_000,
      );
const quotedLead = supplierOf(TARGET_SKU).quoted_lead_time_days;

const groundTruth = {
  target_sku: TARGET_SKU,
  primary_cause: 'supplier_lead_time_slip',
  secondary_cause: 'demand_increase',
  stockout_started: episode.from,
  stockout_ended: episode.to,
  stockout_days: episode.days,
  fault_po: faultPo.po_id,
  po_ordered_date: faultPo.ordered_date,
  po_promised_date: faultPo.promised_date,
  po_received_date: faultPo.received_date,
  quoted_lead_time_days: quotedLead,
  actual_lead_time_days: leadActual,
  demand_lift_applied: DEMAND_LIFT,
  note:
    'The reorder point correctly covers the quoted lead time, and the PO was ' +
    `raised on policy. The supplier took ${leadActual} days against ` +
    `${quotedLead} quoted.`,
};

// --- write -----------------------------------------------------------------
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const body = rows.map((row) =>
    headers
      .map((header) => {
        const value = row[header];
        if (value === null || value === undefined) return '';
        const text = String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      })
      .join(','),
  );
  return [headers.join(','), ...body].join('\n') + '\n';
}

mkdirSync(OUT_DIR, { recursive: true });

const tables: Record<string, Record<string, unknown>[]> = {
  suppliers: suppliers as unknown as Record<string, unknown>[],
  products: products.map(({ baseDemand, ...rest }) => rest),
  inventory_policy: policy as unknown as Record<string, unknown>[],
  sales_daily: sales as unknown as Record<string, unknown>[],
  stock_ledger: ledger as unknown as Record<string, unknown>[],
  purchase_orders: orders as unknown as Record<string, unknown>[],
};

for (const [name, rows] of Object.entries(tables)) {
  writeFileSync(join(OUT_DIR, `${name}.csv`), toCsv(rows), 'utf8');
  console.log(`${name.padEnd(18)} ${String(rows.length).padStart(5)} rows`);
}

writeFileSync(
  join(OUT_DIR, 'ground_truth.json'),
  JSON.stringify(groundTruth, null, 2) + '\n',
  'utf8',
);

console.log('\n--- ground truth (derived from the simulation) ---');
console.log(JSON.stringify(groundTruth, null, 2));
