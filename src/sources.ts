/**
 * Two ways to assemble the same InvestigationInput:
 *
 *   - `fromZetaris`  the live path. Every read goes through the Zetaris
 *                    semantic layer and returns an Evidence record, so each
 *                    claim in the report can name the query behind it.
 *   - `fromSample`   sample mode, reading the generated CSVs locally. No
 *                    network, no keys. Used by the tests and as a demo
 *                    fallback; it is NOT a substitute for the Data layer.
 *
 * The analysis is identical either way, which is what makes the sample-mode
 * tests meaningful.
 */

import { join } from 'node:path';

import { readCsv } from './csv.ts';
import * as q from './queries.ts';
import { resetEvidence, type Evidence } from './zetaris.ts';
import type {
  DeliveryRecord,
  DemandPoint,
  InvestigationInput,
  LedgerPoint,
  PurchaseOrder,
} from './analysis.ts';

export interface SourcedInput {
  input: InvestigationInput;
  evidence: Evidence[];
}

const SAMPLE_DIR = join('data', 'generated');

/** Maps a row array from Zetaris onto named columns. */
function asObjects(evidence: Evidence): Record<string, string>[] {
  return evidence.rows.map((row) => {
    const object: Record<string, string> = {};
    evidence.columns.forEach((column, index) => {
      object[column] = row[index] === null || row[index] === undefined
        ? ''
        : String(row[index]);
    });
    return object;
  });
}

const num = (value: string | undefined): number => Number(value ?? 0);
const orNull = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

// --- live path -------------------------------------------------------------

export async function fromZetaris(sku: string): Promise<SourcedInput> {
  resetEvidence();

  const trajectoryEv = await q.stockTrajectory(sku, '1900-01-01', '2999-12-31');
  const demandEv = await q.dailyDemand(sku, '1900-01-01', '2999-12-31');
  const ordersEv = await q.purchaseOrdersForSku(sku);
  const supplierEv = await q.supplierTerms(sku);
  const policyEv = await q.inventoryPolicy(sku);

  const supplierRow = asObjects(supplierEv)[0];
  if (!supplierRow) {
    throw new Error(`No supplier is registered for ${sku} in Zetaris.`);
  }
  const policyRow = asObjects(policyEv)[0];
  if (!policyRow) {
    throw new Error(`No reorder policy is registered for ${sku} in Zetaris.`);
  }

  const supplierId = String(supplierRow['supplier_id']);
  const historyEv = await q.supplierDeliveryHistory(supplierId);

  return {
    input: {
      sku,
      trajectory: asObjects(trajectoryEv).map(
        (row): LedgerPoint => ({
          date: String(row['ledger_date']),
          onHand: num(row['units_on_hand']),
        }),
      ),
      demand: asObjects(demandEv).map(
        (row): DemandPoint => ({
          date: String(row['sale_date']),
          units: num(row['units_sold']),
        }),
      ),
      orders: asObjects(ordersEv).map(
        (row): PurchaseOrder => ({
          poId: String(row['po_id']),
          supplierId: String(row['supplier_id']),
          qtyOrdered: num(row['qty_ordered']),
          orderedDate: String(row['ordered_date']),
          promisedDate: String(row['promised_date']),
          receivedDate: orNull(row['received_date']),
        }),
      ),
      supplier: {
        supplierId,
        supplierName: String(supplierRow['supplier_name']),
        quotedLeadDays: num(supplierRow['quoted_lead_time_days']),
      },
      policy: {
        reorderPoint: num(policyRow['reorder_point']),
        reorderQty: num(policyRow['reorder_qty']),
      },
      supplierHistory: asObjects(historyEv).map(
        (row): DeliveryRecord => ({
          poId: String(row['po_id']),
          orderedDate: String(row['ordered_date']),
          promisedDate: String(row['promised_date']),
          receivedDate: String(row['received_date']),
        }),
      ),
    },
    evidence: [trajectoryEv, demandEv, ordersEv, supplierEv, policyEv, historyEv],
  };
}

// --- sample mode -----------------------------------------------------------

export function fromSample(sku: string, dir = SAMPLE_DIR): SourcedInput {
  const ledger = readCsv(join(dir, 'stock_ledger.csv')).filter(
    (row) => row['sku'] === sku,
  );
  const sales = readCsv(join(dir, 'sales_daily.csv')).filter(
    (row) => row['sku'] === sku,
  );
  const orders = readCsv(join(dir, 'purchase_orders.csv')).filter(
    (row) => row['sku'] === sku,
  );
  const products = readCsv(join(dir, 'products.csv'));
  const suppliers = readCsv(join(dir, 'suppliers.csv'));
  const policies = readCsv(join(dir, 'inventory_policy.csv'));
  const allOrders = readCsv(join(dir, 'purchase_orders.csv'));

  const product = products.find((row) => row['sku'] === sku);
  if (!product) throw new Error(`${sku} is not in the sample products file.`);
  const supplier = suppliers.find(
    (row) => row['supplier_id'] === product['supplier_id'],
  );
  if (!supplier) throw new Error(`No supplier for ${sku} in the sample data.`);
  const policy = policies.find((row) => row['sku'] === sku);
  if (!policy) throw new Error(`No reorder policy for ${sku} in the sample data.`);

  const supplierId = String(supplier['supplier_id']);

  return {
    input: {
      sku,
      trajectory: ledger.map(
        (row): LedgerPoint => ({
          date: String(row['ledger_date']),
          onHand: num(row['units_on_hand']),
        }),
      ),
      demand: sales.map(
        (row): DemandPoint => ({
          date: String(row['sale_date']),
          units: num(row['units_sold']),
        }),
      ),
      orders: orders.map(
        (row): PurchaseOrder => ({
          poId: String(row['po_id']),
          supplierId: String(row['supplier_id']),
          qtyOrdered: num(row['qty_ordered']),
          orderedDate: String(row['ordered_date']),
          promisedDate: String(row['promised_date']),
          receivedDate: orNull(row['received_date']),
        }),
      ),
      supplier: {
        supplierId,
        supplierName: String(supplier['supplier_name']),
        quotedLeadDays: num(supplier['quoted_lead_time_days']),
      },
      policy: {
        reorderPoint: num(policy['reorder_point']),
        reorderQty: num(policy['reorder_qty']),
      },
      supplierHistory: allOrders
        .filter(
          (row) => row['supplier_id'] === supplierId && row['received_date'] !== '',
        )
        .map(
          (row): DeliveryRecord => ({
            poId: String(row['po_id']),
            orderedDate: String(row['ordered_date']),
            promisedDate: String(row['promised_date']),
            receivedDate: String(row['received_date']),
          }),
        ),
    },
    evidence: [],
  };
}
