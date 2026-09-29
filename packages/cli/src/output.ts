export type OutputFormat = 'json' | 'csv' | 'table';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['json', 'csv', 'table'];

function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null',
  );
}

function toRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((item) =>
      item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : { value: item },
    );
  }
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    // Paginated results (e.g. `{ items: [...], cursor }`) render their item list.
    const list = Object.values(obj).find(Array.isArray);
    return list ? toRows(list) : [obj];
  }
  return [{ value: data }];
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) cols.add(key);
  return [...cols];
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Renders command output as JSON (default), CSV, or an aligned text table.
 * BigInt values are stringified in every format.
 */
export function formatOutput(data: unknown, format: OutputFormat = 'json'): string {
  const value = normalize(data);
  if (format === 'json') return JSON.stringify(value, null, 2);

  const rows = toRows(value);
  const cols = columnsOf(rows);
  const matrix = rows.map((row) => cols.map((c) => cell(row[c])));

  if (format === 'csv') {
    return [cols, ...matrix].map((r) => r.map(csvEscape).join(',')).join('\n');
  }

  const widths = cols.map((c, i) => Math.max(c.length, ...matrix.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...matrix.map(line)].join('\n');
}

export function printOutput(data: unknown, format?: OutputFormat): void {
  console.log(formatOutput(data, format));
}
