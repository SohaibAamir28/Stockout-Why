/**
 * A minimal CSV reader for the generated sample data.
 *
 * This exists so the investigation can run with no network and no Zetaris,
 * which keeps the tests reproducible from a clean clone and gives the demo a
 * fallback. The live path is Zetaris; this is sample mode.
 */

import { readFileSync } from 'node:fs';

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => line !== '');
  if (lines.length === 0) return [];

  const headers = splitLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row: Row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

/** Handles quoted fields and escaped quotes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

export const readCsv = (path: string): Row[] => parseCsv(readFileSync(path, 'utf8'));
