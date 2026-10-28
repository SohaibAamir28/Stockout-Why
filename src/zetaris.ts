/**
 * DATA layer. Every read our agent performs goes through Zetaris, and every
 * read comes back wrapped in an Evidence record so any claim downstream can
 * be traced to the exact SQL and rows that support it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { zetaris as cfg } from './config.ts';

export interface Evidence {
  /** Short stable id we cite in findings, e.g. "E1". */
  id: string;
  /** Human-readable name of what this query establishes. */
  label: string;
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** Hash of the result, so a reader can tell two runs saw the same data. */
  resultHash: string;
  queriedAt: string;
}

export class ZetarisError extends Error {}

let evidenceCounter = 0;

/** Resets evidence numbering. Call once per investigation. */
export function resetEvidence(): void {
  evidenceCounter = 0;
}

/**
 * Runs one SQL statement against Zetaris over its REST API.
 *
 * Agents never reach a source directly: Zetaris's semantic layer is the only
 * door to the data, which is what makes a claim auditable.
 */
export async function runSql(
  label: string,
  sql: string,
  limit = 500,
): Promise<Evidence> {
  const response = await fetch(`${cfg.restUrl}/sql-editor/sqls/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'X-Org-ID': cfg.orgId,
      // A fresh UUID per request: Zetaris answers 400 if this repeats.
      'X-Request-ID': randomUUID(),
    },
    body: JSON.stringify({
      queryId: randomUUID(),
      sql,
      source: 'SqlEditor',
      limit,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ZetarisError(
      `Zetaris returned ${response.status} for "${label}". ${hint(response.status)} ${body.slice(0, 200)}`,
    );
  }

  // A local install answers { headers: ["col", ...], data: [[...]], total, timeUsed }.
  // `schema` is kept as a fallback for other API versions.
  const payload = (await response.json()) as {
    data?: unknown[][];
    headers?: string[];
    schema?: { name?: string }[] | string[];
  };

  const rows = payload.data ?? [];
  const columns = normaliseColumns(
    payload.headers ?? payload.schema,
    rows[0]?.length ?? 0,
  );

  evidenceCounter += 1;
  return {
    id: `E${evidenceCounter}`,
    label,
    sql: sql.trim(),
    columns,
    rows,
    rowCount: rows.length,
    resultHash: createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')
      .slice(0, 12),
    queriedAt: new Date().toISOString(),
  };
}

function hint(status: number): string {
  if (status === 401) return 'The Zetaris API key is missing, wrong or expired.';
  if (status === 400) return 'Check X-Org-ID (1 on a local install).';
  return '';
}

function normaliseColumns(
  schema: { name?: string }[] | string[] | undefined,
  width: number,
): string[] {
  if (Array.isArray(schema) && schema.length > 0) {
    return schema.map((column, index) =>
      typeof column === 'string' ? column : (column.name ?? `col${index}`),
    );
  }
  return Array.from({ length: width }, (_, index) => `col${index}`);
}

/** Reads a single scalar, for counts and existence checks. */
export async function scalar(
  label: string,
  sql: string,
): Promise<{ value: unknown; evidence: Evidence }> {
  const evidence = await runSql(label, sql, 1);
  return { value: evidence.rows[0]?.[0], evidence };
}
