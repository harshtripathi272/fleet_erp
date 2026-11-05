import { createHash, randomUUID } from 'node:crypto';
import { NotFoundError } from '../../../core/errors/index.js';
import type { Plain } from '../../../core/masters/types.js';
import { storeForNew } from '../../../core/storage/index.js';
import { Company } from '../../company/company.model.js';
import { StoredFile } from '../../files/file.model.js';
import { PrintLayout } from '../../messaging/models/messaging.model.js';
import { Party } from '../../parties/models/party.model.js';
import { renderPdf, type PdfBlock, type PdfLayout } from '../../operations/pdf.js';
import { formatMoney } from '../../operations/support.js';
import { Invoice } from './billing.model.js';
import { currencyUnits } from './pricing.js';

/** An invoice or credit note as a PDF, laid out by the company's default "invoice" print layout. */

const dayText = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const qtyText = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 3 });

export async function invoicePdf(id: string): Promise<{ name: string; body: Buffer }> {
  const inv = await Invoice.findById(id).lean() as Plain | null;
  if (!inv) throw new NotFoundError('Invoice not found');
  const layout = await PrintLayout.findOne({ document: 'invoice', isDefault: true, status: 'active' }).lean() as Plain | null;
  const company = await Company.findOne().select('legalName tradingName address phone email taxId').lean() as Plain | null;
  const customer = await Party.findById(inv.customerId).select('name tradingName taxId addresses').lean() as Plain | null;
  const addresses = (customer?.addresses ?? []) as Array<Plain & { kind: string; isDefault?: boolean }>;
  const billTo = addresses.find((a) => a.kind === 'billing') ?? addresses.find((a) => a.isDefault) ?? addresses[0];
  const currency = await currencyUnits(inv.currencyId);
  const money = (minor: unknown) => formatMoney(Number(minor ?? 0), currency);
  const isCredit = inv.kind === 'credit_note';
  const address = (a: unknown) => (a ? ['line1', 'line2', 'city', 'postalCode'].map((k) => (a as Record<string, unknown>)[k]).filter((v) => typeof v === 'string' && v).join(', ') : '');
  const credited = isCredit && inv.invoiceId ? await Invoice.findById(inv.invoiceId).select('number').lean() as Plain | null : null;
  const title = `${isCredit ? 'Credit note' : 'Invoice'} ${inv.number ?? '(draft)'}`;
  const blocks: PdfBlock[] = [
    { kind: 'title', text: title },
    { kind: 'subtitle', text: [company?.tradingName ?? company?.legalName, address(company?.address), company?.phone, company?.email, company?.taxId ? `Tax no. ${company.taxId}` : ''].filter(Boolean).join('  ·  ') },
    {
      kind: 'facts', rows: [
        ['Bill to', String(customer?.name ?? '')],
        ...(address(billTo) ? [['Address', address(billTo)] as [string, string]] : []),
        ...(customer?.taxId ? [['Customer tax no.', String(customer.taxId)] as [string, string]] : []),
        ['Date', dayText(inv.date)],
        ...(isCredit ? [['Credits invoice', String(credited?.number ?? '')] as [string, string]] : [['Due', dayText(inv.dueDate)] as [string, string]]),
        ['Currency', currency.code],
      ],
    },
    {
      kind: 'table',
      columns: [{ label: 'Description', width: 0.46 }, { label: 'Quantity', width: 0.16, align: 'right' }, { label: 'Unit price', width: 0.16, align: 'right' }, { label: 'Amount', width: 0.22, align: 'right' }],
      rows: ((inv.lines ?? []) as Plain[]).map((l) => [
        String(l.description), `${qtyText(Number(l.qty))}${l.unit ? ` ${l.unit}` : ''}`, money(Math.round(Number(l.unitPriceMinor))), money(l.amountMinor),
      ]),
    },
    {
      kind: 'facts', rows: [
        ['Before tax', money(inv.netMinor)],
        ...(Number(inv.taxMinor) ? [[String(inv.taxLabel ?? 'Tax'), money(inv.taxMinor)] as [string, string]] : []),
        [isCredit ? 'Total credited' : 'Total due', money(inv.totalMinor)],
      ],
    },
  ];
  if (inv.reason && isCredit) blocks.push({ kind: 'text', text: `Reason: ${inv.reason}` });
  if (inv.note) blocks.push({ kind: 'text', text: String(inv.note) });
  const page: PdfLayout = { paperSize: layout?.paperSize as PdfLayout['paperSize'], orientation: layout?.orientation as PdfLayout['orientation'], footerText: layout?.footerText as string | undefined };
  const name = `${isCredit ? 'Credit note' : 'Invoice'} ${String(inv.number ?? 'draft').replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
  return { name, body: renderPdf(blocks, page) };
}

/** Stores the PDF as a file so the e-mail can attach it, and remembers it on the invoice. */
export async function invoiceFile(id: string, actorId?: string): Promise<{ fileId: string }> {
  const { name, body } = await invoicePdf(id);
  const at = new Date();
  const key = `${at.toISOString().slice(0, 7)}/${randomUUID()}.pdf`;
  await (await storeForNew()).store.put(key, body, 'application/pdf');
  const file = await StoredFile.create({ name, mime: 'application/pdf', size: body.length, sha256: createHash('sha256').update(body).digest('hex'), key, uploadedBy: actorId, at });
  await Invoice.updateOne({ _id: id }, { $set: { fileId: file._id } });
  return { fileId: String(file._id) };
}
