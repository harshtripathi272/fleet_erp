import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerProvider } from '../registry.js';

/* Accounting export, fuel cards and mobile-money payouts. Real services for these come later. */

/** One CSV cell: quoted when it holds a comma, quote or line break; formulas defused for spreadsheets. */
function cell(value: unknown, sep: string): string {
  if (value === undefined || value === null) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text)) text = `'${text}`;
  return text.includes(sep) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export const toCsv = (columns: string[], rows: Array<Record<string, unknown>>, sep = ',') =>
  [columns.map((c) => cell(c, sep)).join(sep), ...rows.map((r) => columns.map((c) => cell(r[c], sep)).join(sep))].join('\r\n') + '\r\n';

registerProvider({
  kind: 'accounting', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Builds each export and keeps it here; nothing is sent to an accounting system.',
  fields: z.strictObject({}),
  test: async () => ({ ok: true, message: 'Exports are built and kept, not sent.' }),
  open: () => ({ export: async ({ name, columns, rows }) => ({ name: `${name}.csv`, mime: 'text/csv', body: Buffer.from(toCsv(columns, rows)), sent: false }) }),
});

/** A CSV file to download and import: works with Xero, QuickBooks, Sage and Pastel until they're connected. */
registerProvider({
  kind: 'accounting', key: 'csv', label: 'CSV file',
  description: 'Each export is a CSV file to download and import into the accounting system. Direct Xero and QuickBooks links come later.',
  fields: z.strictObject({ separator: z.enum(['comma', 'semicolon']).default('comma') }),
  labels: { 'separator.comma': 'Comma', 'separator.semicolon': 'Semicolon (spreadsheets set to a comma decimal)' },
  test: async () => ({ ok: true, message: 'Exports download as CSV files.' }),
  open: (ctx) => ({
    async export({ name, columns, rows }) {
      const csv = toCsv(columns, rows, ctx.settings.separator === 'semicolon' ? ';' : ',');
      return { name: `${name}.csv`, mime: 'text/csv', body: Buffer.from(csv), sent: false };
    },
  }),
});

registerProvider({
  kind: 'fuel-cards', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Sample card transactions, marked Simulated, so matching fuel to trips can be tried.',
  fields: z.strictObject({}),
  test: async () => ({ ok: true, message: 'Sample transactions are ready.' }),
  open: () => ({ transactions: async () => [] }),
});

registerProvider({
  kind: 'payouts', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Payouts are recorded with a Simulated reference; no money moves.',
  fields: z.strictObject({}),
  test: async () => ({ ok: true, message: 'Payouts are recorded, not paid.' }),
  open: () => ({ pay: async () => ({ providerRef: `sim-${randomUUID()}`, simulated: true }) }),
});
