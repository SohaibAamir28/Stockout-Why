/**
 * Renders an investigation for a terminal.
 *
 * The shape of this report is the product: a verdict, then the reasoning, then
 * the evidence anyone can re-run. Nothing is asserted here that the findings
 * do not contain.
 */

import type { Finding } from './analysis.ts';
import type { RunResult } from './investigate.ts';
import type { Evidence } from './zetaris.ts';

const RULE = '─'.repeat(74);

const VERDICT_MARK: Record<Finding['verdict'], string> = {
  supported: '[supported]',
  rejected: '[ruled out]',
  inconclusive: '[unclear]  ',
};

export function renderReport(result: RunResult): string {
  const { investigation: inv } = result;
  const lines: string[] = [];

  lines.push(RULE);
  lines.push(`  WHY DID ${inv.sku} RUN OUT?`);
  lines.push(`  ${result.mode === 'live' ? 'Live: Zetaris semantic layer' : 'Sample mode: local CSVs, no network'}`);
  lines.push(RULE);
  lines.push('');

  if (!inv.episode) {
    lines.push('  No stockout found.');
    for (const caveat of inv.caveats) lines.push(`  ${caveat}`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    `  Stock reached zero on ${inv.episode.from} and stayed there for ` +
      `${inv.episode.days} day(s), until ${inv.episode.to}.`,
  );
  lines.push('');

  // --- the verdict ---------------------------------------------------------
  if (inv.primary) {
    lines.push('  PRIMARY CAUSE');
    lines.push(`    ${inv.primary.title}`);
    lines.push('');
    for (const line of wrap(inv.primary.statement, 68)) lines.push(`    ${line}`);
    lines.push('');
    lines.push(
      `    This is the primary cause because repairing it alone - and nothing`,
    );
    lines.push(`    else - would have prevented the stockout.`);
    lines.push('');
  } else {
    lines.push('  No single cause was supported by the records.');
    lines.push('');
  }

  // --- memory --------------------------------------------------------------
  if (result.priors.length > 0) {
    lines.push('  REMEMBERED FROM EARLIER INVESTIGATIONS            [H-MEM]');
    for (const prior of result.priors) {
      for (const line of wrap(prior.content, 64)) lines.push(`    ${line}`);
      lines.push(`      confidence ${prior.confidence.toFixed(2)}  ${prior.memoryId}`);
    }
    lines.push('');
  }

  // --- secondary and ruled out --------------------------------------------
  if (inv.secondary.length > 0) {
    lines.push('  CONTRIBUTING, BUT NOT SUFFICIENT ON ITS OWN');
    for (const finding of inv.secondary) {
      lines.push(`    ${VERDICT_MARK[finding.verdict]} ${finding.title}`);
      for (const line of wrap(finding.statement, 64)) lines.push(`      ${line}`);
    }
    lines.push('');
  }

  const ruledOut = inv.findings.filter((finding) => finding.verdict === 'rejected');
  if (ruledOut.length > 0) {
    lines.push('  RULED OUT');
    for (const finding of ruledOut) {
      lines.push(`    ${VERDICT_MARK[finding.verdict]} ${finding.title}`);
      for (const line of wrap(finding.statement, 64)) lines.push(`      ${line}`);
    }
    lines.push('');
  }

  // --- the narrative -------------------------------------------------------
  if (result.narrative) {
    lines.push('  IN PLAIN WORDS                       [NVIDIA Nemotron]');
    for (const paragraph of result.narrative.split(/\n\s*\n/)) {
      for (const line of wrap(paragraph.replace(/\s+/g, ' ').trim(), 68)) {
        lines.push(`    ${line}`);
      }
      lines.push('');
    }
    if (result.verification) {
      lines.push(
        `    Every one of the ${result.verification.checked} figures above was` +
          ` checked`,
      );
      lines.push(`    against the evidence before publishing.`);
      lines.push('');
    }
  } else if (result.degraded) {
    lines.push('  IN PLAIN WORDS');
    for (const line of wrap(result.degradedReason ?? 'The model step failed.', 68)) {
      lines.push(`    ${line}`);
    }
    lines.push('    The verdict above is unaffected: it is computed from the');
    lines.push('    records, not written by a model.');
    lines.push('');
  }

  // --- caveats -------------------------------------------------------------
  if (inv.caveats.length > 0) {
    lines.push('  WHAT THIS REPORT ASSUMES');
    for (const caveat of inv.caveats) {
      for (const line of wrap(caveat, 68)) lines.push(`    ${line}`);
    }
    lines.push('');
  }

  // --- evidence ------------------------------------------------------------
  if (result.evidence.length > 0) {
    lines.push(RULE);
    lines.push('  EVIDENCE                                        [Zetaris]');
    lines.push(RULE);
    for (const record of result.evidence) lines.push(...renderEvidence(record));
  }

  // --- provenance ----------------------------------------------------------
  if (result.modelCall) {
    lines.push(RULE);
    lines.push('  MODEL CALL');
    lines.push(`    requested  ${result.modelCall.requestedModel}`);
    lines.push(`    answered   ${result.modelCall.routedModel ?? 'unknown'}`);
    lines.push(`    receipt    ${result.modelCall.receiptId ?? 'none'}`);
    lines.push(`    latency    ${result.modelCall.latencyMs} ms`);
    if ((result.modelCall.attempts ?? 1) > 1) {
      lines.push(
        `    attempts   ${result.modelCall.attempts} (an earlier reply came back empty or cut off)`,
      );
    }
    lines.push(
      `    nemotron   ${result.nemotron ? 'yes' : 'no - routed elsewhere by meterless/auto'}`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

function renderEvidence(record: Evidence): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${record.id}  ${record.label}`);
  lines.push(`      ${record.rowCount} row(s), result hash ${record.resultHash}`);
  for (const line of record.sql.split('\n')) lines.push(`      ${line.trim()}`);

  if (record.rowCount > 0) {
    lines.push(`      ${record.columns.join(' | ')}`);
    for (const row of record.rows.slice(0, 5)) {
      lines.push(`        ${row.map((cell) => String(cell ?? '')).join(' | ')}`);
    }
    if (record.rowCount > 5) {
      lines.push(`        ... ${record.rowCount - 5} more row(s)`);
    }
  }
  return lines;
}

/** Wraps on word boundaries, so statements stay readable in a terminal. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
