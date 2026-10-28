/**
 * A guard on model prose.
 *
 * The verdict in this product is computed deterministically; the model's only
 * job is to explain it readably. So every number and date the model writes
 * must already appear in the findings or the evidence it was given. If it
 * states something that is not there, the narrative is rejected and the
 * deterministic wording is published instead.
 *
 * This is cheap and it closes the gap that matters most for a track about
 * explaining why: a fluent sentence containing an invented figure.
 *
 * Models restate figures in human forms, so the check reads those too:
 * "September 11th, 2026" is the date 2026-09-11, "23rd" is the number 23 and
 * "1,080" is 1080. Each is then held to the same rule as any other figure.
 */

import type { Finding } from './analysis.ts';
import type { Evidence } from './zetaris.ts';

export interface VerificationResult {
  ok: boolean;
  /** Numbers and dates in the prose with no support in the inputs. */
  unsupported: string[];
  checked: number;
}

/** Figures that carry no claim on their own and would only cause noise. */
const TRIVIAL = new Set(['0', '1', '2', '100']);

const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/g;
// Integers, decimals, thousands groups and ordinals ("23rd"), not part of a
// longer identifier like PO-506.
const NUMBER_PATTERN =
  /(?<![\w-])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:st|nd|rd|th)?(?![\w-])/gi;
// The digits of an identifier such as PO-506, which a model may write as "PO 506".
const IDENTIFIER_DIGITS = /\b[A-Za-z]+-(\d+)\b/g;

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9,
  sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})\\.?`;
const ORDINAL = '(?:st|nd|rd|th)?';
// "September 3", "Sept. 3rd, 2026"
const MONTH_FIRST = new RegExp(
  `\\b${MONTH}\\s+(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?(?![\\w-])`,
  'gi',
);
// "3 September 2026", "3rd of September"
const DAY_FIRST = new RegExp(
  `(?<![\\w-])(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`,
  'gi',
);

/** Extra facts the model was shown, beyond findings and evidence. */
export type SupportedFact = string | number | null | undefined;

/**
 * Builds the set of figures the model is allowed to state: everything in the
 * findings' numbers and statements, anything visible in the evidence rows, and
 * any extra facts the caller passed the model (such as the stockout window).
 */
function supportedTokens(
  findings: Finding[],
  evidence: Evidence[],
  extra: SupportedFact[],
): Set<string> {
  const allowed = new Set<string>();

  const addFrom = (text: string): void => {
    for (const match of text.matchAll(DATE_PATTERN)) allowed.add(match[0]);
    for (const match of text.matchAll(NUMBER_PATTERN)) {
      allowed.add(normalise(match[0]));
    }
    for (const match of text.matchAll(IDENTIFIER_DIGITS)) {
      allowed.add(normalise(match[1]!));
    }
  };
  const addValue = (value: SupportedFact | unknown): void => {
    if (value === null || value === undefined) return;
    allowed.add(normalise(String(value)));
    addFrom(String(value));
  };

  for (const finding of findings) {
    addFrom(finding.statement);
    addFrom(finding.title);
    for (const value of Object.values(finding.numbers)) addValue(value);
  }

  for (const record of evidence) {
    for (const row of record.rows) {
      for (const cell of row) addValue(cell);
    }
  }

  for (const value of extra) addValue(value);

  return allowed;
}

/**
 * Trailing-zero and integer forms of the same value must compare equal, and
 * "1,080" or "23rd" must compare as 1080 and 23.
 */
function normalise(value: string): string {
  const bare = value.replace(/(?<=\d)(?:st|nd|rd|th)$/i, '').replace(/(?<=\d),(?=\d{3})/g, '');
  const asNumber = Number(bare);
  return Number.isFinite(asNumber) ? String(asNumber) : value;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Finds dates written in words, checks each against the supported ISO dates,
 * and returns the prose with them blanked so their parts are not rescanned.
 * A date without a year is supported when any supported date has that month
 * and day.
 */
function checkWrittenDates(
  text: string,
  allowedDates: string[],
  onCheck: (written: string, supported: boolean) => void,
): string {
  const resolve = (written: string, monthName: string, day: string, year?: string): string => {
    const month = MONTHS[monthName.toLowerCase().replace(/\.$/, '')];
    const dayNumber = Number(day);
    if (!month || dayNumber < 1 || dayNumber > 31) return written;
    const monthDay = `-${pad(month)}-${pad(dayNumber)}`;
    const supported = year
      ? allowedDates.includes(`${year}${monthDay}`)
      : allowedDates.some((date) => date.endsWith(monthDay));
    onCheck(written.trim(), supported);
    return ' ';
  };

  return text
    .replace(MONTH_FIRST, (written, monthName: string, day: string, year?: string) =>
      resolve(written, monthName, day, year),
    )
    .replace(DAY_FIRST, (written, day: string, monthName: string, year?: string) =>
      resolve(written, monthName, day, year),
    );
}

export function verifyNarrative(
  narrative: string,
  findings: Finding[],
  evidence: Evidence[],
  extra: SupportedFact[] = [],
): VerificationResult {
  const allowed = supportedTokens(findings, evidence, extra);
  const allowedDates = [...allowed].filter((token) => /^\d{4}-\d{2}-\d{2}$/.test(token));
  const unsupported: string[] = [];
  let checked = 0;

  for (const match of narrative.matchAll(DATE_PATTERN)) {
    checked += 1;
    if (!allowed.has(match[0])) unsupported.push(match[0]);
  }

  // Strip dates before scanning numbers, so date parts are not double-counted.
  const withoutIsoDates = narrative.replace(DATE_PATTERN, ' ');
  const withoutDates = checkWrittenDates(withoutIsoDates, allowedDates, (written, supported) => {
    checked += 1;
    if (!supported) unsupported.push(written);
  });

  for (const match of withoutDates.matchAll(NUMBER_PATTERN)) {
    const token = normalise(match[0]);
    if (TRIVIAL.has(token)) continue;
    checked += 1;
    if (!allowed.has(token)) unsupported.push(match[0]);
  }

  return {
    ok: unsupported.length === 0,
    unsupported: [...new Set(unsupported)],
    checked,
  };
}
