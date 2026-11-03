import { parse } from 'csv-parse/browser/esm/sync';

const HEADER_NAMES = new Set(['email', 'emails', 'e-mail', 'recipient', 'recipients', 'address', 'email address']);

export interface ParsedRecipients {
  /** One raw value per data row (first column), header and blank rows removed. */
  values: string[];
  blankRows: number;
  headerDetected: boolean;
  /** Set when the input could not be parsed as CSV at all. */
  parseError: string | null;
}

/**
 * Accepts either one address per line or a CSV with an optional header row. Uses a real CSV parser
 * (quotes, embedded commas, BOM, blank lines). The server revalidates everything again.
 */
export function parseRecipientText(text: string): ParsedRecipients {
  const cleaned = text.replace(/^﻿/, '');
  if (cleaned.trim() === '') return { values: [], blankRows: 0, headerDetected: false, parseError: null };
  let rows: string[][];
  try {
    rows = parse(cleaned, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
      trim: true,
    }) as string[][];
  } catch (error) {
    return { values: [], blankRows: 0, headerDetected: false, parseError: (error as Error).message };
  }
  let headerDetected = false;
  const values: string[] = [];
  let blankRows = 0;
  rows.forEach((row, index) => {
    const first = (row[0] ?? '').trim();
    if (first === '' && row.every((c) => c.trim() === '')) {
      blankRows += 1;
      return;
    }
    if (index === 0 && HEADER_NAMES.has(first.toLowerCase())) {
      headerDetected = true;
      return;
    }
    values.push(first);
  });
  return { values, blankRows, headerDetected, parseError: null };
}
