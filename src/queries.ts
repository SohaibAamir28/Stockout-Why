/**
 * The agent's entire read surface: a fixed allowlist of named, read-only
 * queries against the Zetaris semantic layer.
 *
 * No model ever composes SQL here. A model may choose WHICH named query to
 * run and with what parameters, but it cannot invent one, so the data the
 * investigation rests on is always a query a human can read and re-run.
 */

import { zetaris } from './config.ts';
import { runSql, type Evidence } from './zetaris.ts';

/** A table's qualified name in Zetaris: `<source>.<table>`. */
const t = (table: string): string => `${zetaris.source}.${table}`;

/** Rejects anything that is not a plain identifier or date, to keep the
 *  allowlist's parameters from being a SQL injection seam. */
function safe(value: string, kind: 'id' | 'date'): string {
  const pattern = kind === 'id' ? /^[A-Za-z0-9_-]{1,64}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(value)) {
    throw new Error(`Unsafe ${kind} parameter: ${JSON.stringify(value)}`);
  }
  return value;
}

export const QUERY_NAMES = [
  'stock_at_zero',
  'stock_trajectory',
  'daily_demand',
  'purchase_orders_for_sku',
  'supplier_terms',
  'inventory_policy',
  'supplier_delivery_history',
] as const;

export type QueryName = (typeof QUERY_NAMES)[number];

/** Days of on-hand history at zero, which is what "ran out" means in data. */
export const stockAtZero = (sku: string): Promise<Evidence> =>
  runSql(
    `Days with zero stock on hand for ${sku}`,
    `SELECT ledger_date, units_on_hand
       FROM ${t('stock_ledger')}
      WHERE sku = '${safe(sku, 'id')}' AND units_on_hand = 0
      ORDER BY ledger_date`,
  );

export const stockTrajectory = (
  sku: string,
  from: string,
  to: string,
): Promise<Evidence> =>
  runSql(
    `On-hand stock for ${sku} between ${from} and ${to}`,
    `SELECT ledger_date, units_on_hand
       FROM ${t('stock_ledger')}
      WHERE sku = '${safe(sku, 'id')}'
        AND ledger_date BETWEEN '${safe(from, 'date')}' AND '${safe(to, 'date')}'
      ORDER BY ledger_date`,
  );

export const dailyDemand = (
  sku: string,
  from: string,
  to: string,
): Promise<Evidence> =>
  runSql(
    `Units sold per day for ${sku} between ${from} and ${to}`,
    `SELECT sale_date, units_sold
       FROM ${t('sales_daily')}
      WHERE sku = '${safe(sku, 'id')}'
        AND sale_date BETWEEN '${safe(from, 'date')}' AND '${safe(to, 'date')}'
      ORDER BY sale_date`,
  );

export const purchaseOrdersForSku = (sku: string): Promise<Evidence> =>
  runSql(
    `Purchase orders raised for ${sku}`,
    `SELECT po_id, supplier_id, qty_ordered, ordered_date, promised_date,
            received_date, qty_received
       FROM ${t('purchase_orders')}
      WHERE sku = '${safe(sku, 'id')}'
      ORDER BY ordered_date`,
  );

export const supplierTerms = (sku: string): Promise<Evidence> =>
  runSql(
    `Supplier and quoted lead time for ${sku}`,
    `SELECT s.supplier_id, s.supplier_name, s.quoted_lead_time_days
       FROM ${t('suppliers')} s
       JOIN ${t('products')} p ON p.supplier_id = s.supplier_id
      WHERE p.sku = '${safe(sku, 'id')}'`,
  );

export const inventoryPolicy = (sku: string): Promise<Evidence> =>
  runSql(
    `Reorder policy for ${sku}`,
    `SELECT sku, reorder_point, reorder_qty
       FROM ${t('inventory_policy')}
      WHERE sku = '${safe(sku, 'id')}'`,
  );

/** The supplier's wider record, so one slip can be told from a pattern. */
export const supplierDeliveryHistory = (supplierId: string): Promise<Evidence> =>
  runSql(
    `Delivery record for supplier ${supplierId}`,
    `SELECT po_id, sku, ordered_date, promised_date, received_date
       FROM ${t('purchase_orders')}
      WHERE supplier_id = '${safe(supplierId, 'id')}'
        AND received_date IS NOT NULL
      ORDER BY ordered_date`,
  );
