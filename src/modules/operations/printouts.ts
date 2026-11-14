import { printedFields, printedPictures } from './placements.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { word } from '../company/workspace.js';
import { documentBrand } from '../company/brand.service.js';
import { createHash, randomUUID } from 'node:crypto';
import * as Fmt from '../../core/format/regional.js';
import type { Plain } from '../../core/masters/types.js';
import { storeForNew } from '../../core/storage/index.js';
import { Product } from '../cargo/models/product.model.js';
import { Company } from '../company/company.model.js';
import { StoredFile } from '../files/file.model.js';
import { PrintLayout } from '../messaging/models/messaging.model.js';
import { ExpenseCategory } from '../trips/models/expense.model.js';
import { TripType } from '../trips/models/tripType.model.js';
import { tripSheet } from './dashboards.service.js';
import { renderPdf, type PdfBlock, type PdfLayout } from './pdf.js';
import { statement } from './settlements.service.js';
import { currencyInfo, formatMoney, litres } from './support.js';
import { driverName, partyName, placeName, plateOf, routeLabel, trailerPlate } from './trips.service.js';

/**
 * The trip sheet and the driver statement as PDF files, laid out by the company's default print
 * layout (paper, sections, signature lines, footer), stored like any other file so e-mails can attach them.
 */

const STOP_LABEL: Record<string, string> = { start: 'Start', load: 'Loading', offload: 'Offloading', via: 'Via', border: 'Border', end: 'End' };

async function layoutFor(document: 'trip_sheet' | 'driver_statement', id?: unknown) {
  const chosen = id ? await PrintLayout.findOne({ _id: id, status: 'active' }).lean() : null;
  return (chosen ?? await PrintLayout.findOne({ document, isDefault: true, status: 'active' }).lean()) as Plain | null;
}

function pageOf(layout: Plain | null): PdfLayout {
  return { paperSize: layout?.paperSize as PdfLayout['paperSize'], orientation: layout?.orientation as PdfLayout['orientation'], footerText: layout?.footerText as string | undefined };
}

/** Sections in the layout's order, leaving out hidden ones; every section when there is no layout. */
function sectionsOf(layout: Plain | null, all: string[]): string[] {
  const listed = (layout?.sections ?? []) as Array<{ key: string; visible?: boolean; order?: number }>;
  if (!listed.length) return all;
  return [...listed].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)).filter((s) => s.visible !== false && all.includes(s.key)).map((s) => s.key);
}

async function companyBlocks(title: string): Promise<PdfBlock[]> {
  const company = await Company.findOne().select('legalName tradingName address phone email').lean() as Plain | null;
  const address = company?.address ? Object.values(company.address as Record<string, string>).filter(Boolean).join(', ') : '';
  const name = String(company?.tradingName ?? company?.legalName ?? '');
  return [
    { kind: 'title', text: title },
    { kind: 'subtitle', text: [name, address, company?.phone, company?.email].filter(Boolean).join('  ·  ') },
  ];
}

/** A moment in the company's date and time format and time zone. */
const when = (value: unknown): string => (value ? Fmt.dateTime(value as string) : '—');

async function money(amount: unknown) {
  const a = amount as { amountMinor?: number; currencyId?: unknown } | undefined;
  if (!a?.currencyId) return '—';
  return formatMoney(Number(a.amountMinor ?? 0), await currencyInfo(a.currencyId).catch(() => ({ code: '', minorUnits: 2 })));
}

/** Stored on the record it prints, so it opens for whoever may read that record (#105). */
async function store(name: string, body: Buffer, actorId: string, use: { entity: string; recordId: string }) {
  const at = new Date();
  const key = `${at.toISOString().slice(0, 7)}/${randomUUID()}.pdf`;
  const { store: files, connectionId } = await storeForNew();
  await files.put(key, body, 'application/pdf');
  const file = await StoredFile.create({ name, mime: 'application/pdf', size: body.length, sha256: createHash('sha256').update(body).digest('hex'), key, uploadedBy: actorId, connectionId, at, usedBy: [{ ...use, field: 'printout' }] });
  return { fileId: String(file._id) };
}

const fileName = (prefix: string, number: unknown) => `${prefix} ${String(number ?? '').replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;

/** The trip sheet as a PDF. */
export async function tripSheetPdf(tripId: string, can: Parameters<typeof tripSheet>[1]): Promise<{ name: string; body: Buffer }> {
  const sheet = await tripSheet(tripId, can);
  const trip = sheet.trip;
  const tripType = trip.tripTypeId ? await TripType.findById(trip.tripTypeId).select('printLayoutId').lean() as Plain | null : null;
  const layout = await layoutFor('trip_sheet', tripType?.printLayoutId);
  const sheetWord = await word('tripSheet');
  const blocks: PdfBlock[] = await companyBlocks(`${sheetWord} ${trip.number}`);
  // The company's fields marked for the trip sheet: on the trip, its loads, and its driver and truck (#97).
  const [driver, vehicle] = await Promise.all([
    trip.driverId ? Driver.findById(trip.driverId).select('custom').lean() : null,
    trip.vehicleId ? Vehicle.findById(trip.vehicleId).select('custom').lean() : null,
  ]) as [Plain | null, Plain | null];
  const printed: Array<[string, Plain]> = [['trips', trip], ...sheet.consignments.map((c): [string, Plain] => ['consignments', c as Plain]), ...(driver ? [['drivers', driver] as [string, Plain]] : []), ...(vehicle ? [['vehicles', vehicle] as [string, Plain]] : [])];
  const companyRows = await printedFields('trip_sheet', printed);
  const pictures = await printedPictures('trip_sheet', printed);
  const stops = (trip.stops ?? []) as Array<{ kind: string; placeId: unknown; arrivedAt?: Date; leftAt?: Date; legKm?: number }>;
  const products = new Map((await Product.find({ _id: { $in: sheet.consignments.map((c) => c.productId) } }).select('name').lean()).map((p) => [String(p._id), String(p.name)]));
  const categories = new Map((await ExpenseCategory.find({ _id: { $in: sheet.expenses.map((e) => e.categoryId) } }).select('name').lean()).map((c) => [String(c._id), String(c.name)]));
  const measure = (m?: Plain) => (m ? (m.unit === 'L' || m.unit === 'l' ? litres(Number(m.qty)) : `${Fmt.number(Number(m.qty), { max: 3 })} ${m.unit}`) : '—');

  for (const section of sectionsOf(layout, ['trip', 'load', 'movement', 'money'])) {
    const label = ((layout?.sections ?? []) as Array<{ key: string; label?: string }>).find((s) => s.key === section)?.label;
    if (section === 'trip') {
      blocks.push({ kind: 'heading', text: label ?? 'Trip' }, {
        kind: 'facts', rows: [
          ['Trip', String(trip.number)],
          ['Customer', await partyName(trip.customerId)],
          ['Route', await routeLabel(trip as never)],
          ['Truck', await plateOf(trip.vehicleId)],
          ['Trailer', await trailerPlate(trip.trailerId)],
          ['Driver', await driverName(trip.driverId)],
          ...companyRows,
          ['Dispatched', when(trip.dispatchedAt)],
          ['Ended', when(trip.endedAt)],
          ['Distance', `${Fmt.number(Math.round(Number(trip.totalKm ?? 0)))} km`],
        ],
      }, ...pictures);
    } else if (section === 'load') {
      blocks.push({ kind: 'heading', text: label ?? 'Load' }, {
        kind: 'table',
        columns: [{ label: 'Consignment', width: 2 }, { label: 'Product', width: 2 }, { label: 'Invoice', width: 2 }, { label: 'Loaded', width: 2, align: 'right' }, { label: 'Delivered', width: 2, align: 'right' }, { label: 'Delivery note', width: 2 }, { label: 'Shortage', width: 1.6, align: 'right' }],
        rows: (sheet.consignments as Plain[]).map((c) => {
          const shortage = c.shortage as Plain | undefined;
          return [String(c.number), products.get(String(c.productId)) ?? '', String(c.invoiceNo ?? ''), measure(c.load as Plain), measure(c.delivered as Plain), String((c.delivered as Plain | undefined)?.podNo ?? ''), shortage ? measure({ qty: shortage.netShortL ?? 0, unit: shortage.unit ?? 'L' }) : '—'];
        }),
      });
    } else if (section === 'movement') {
      const rows: string[][] = [];
      for (const s of stops) rows.push([STOP_LABEL[s.kind] ?? s.kind, await placeName(s.placeId), when(s.arrivedAt), when(s.leftAt), `${Fmt.number(Math.round(Number(s.legKm ?? 0)))} km`]);
      blocks.push({ kind: 'heading', text: label ?? 'Vehicle movement' }, {
        kind: 'table', columns: [{ label: 'Stop', width: 1.4 }, { label: 'Place', width: 3 }, { label: 'Arrived', width: 2.4 }, { label: 'Left', width: 2.4 }, { label: 'Leg', width: 1.2, align: 'right' }], rows,
      }, { kind: 'facts', rows: [['Fuel at start', trip.openingFuelL != null ? litres(Number(trip.openingFuelL)) : '—'], ['Fuel at end', trip.closingFuelL != null ? litres(Number(trip.closingFuelL)) : '—']] });
    } else if (section === 'money') {
      const requests: string[][] = [];
      for (const r of sheet.requests) requests.push([String(r.number), r.kind === 'fuel' ? 'Fuel' : 'Advance', r.kind === 'fuel' ? litres(Number(r.litres ?? 0)) : await money(r.amount), String(r.status === 'issued' ? 'paid' : r.status), [r.medium, r.reference].filter(Boolean).join(' ')]);
      const expenses: string[][] = [];
      for (const e of sheet.expenses) expenses.push([String(e.number), categories.get(String(e.categoryId)) ?? 'Expense', await money(e.amount), String(e.status), String(e.receiptNo ?? '')]);
      blocks.push(
        { kind: 'heading', text: label ?? 'Advances and expenses' },
        { kind: 'table', columns: [{ label: 'Request', width: 2 }, { label: 'Kind', width: 1.4 }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Status', width: 1.4 }, { label: 'Paid by', width: 3 }], rows: requests },
        { kind: 'table', columns: [{ label: 'Expense', width: 2 }, { label: 'Type', width: 2.4 }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Status', width: 1.4 }, { label: 'Receipt', width: 2 }], rows: expenses },
      );
    }
  }
  blocks.push({ kind: 'signatures', labels: ((layout?.signatureLines ?? []) as string[]) });
  return { name: fileName(sheetWord, trip.number), body: renderPdf(blocks, { ...pageOf(layout), ...(await documentBrand('tripSheet')) }) };
}

/** The driver statement for a settlement as a PDF. */
export async function statementPdf(settlementId: string): Promise<{ name: string; body: Buffer }> {
  const s = await statement(settlementId);
  const layout = await layoutFor('driver_statement');
  const base = s.currency;
  const amount = (minor: unknown) => formatMoney(Number(minor ?? 0), base);
  const statementWord = `${await word('driver')} ${(await word('statement')).toLowerCase()}`;
  const blocks: PdfBlock[] = await companyBlocks(`${statementWord} ${s.settlement.number}`);
  const driver = await Driver.findById((s.settlement as unknown as Plain).driverId).select('custom').lean() as Plain | null;
  const printed: Array<[string, Plain]> = [['settlements', s.settlement as unknown as Plain], ...(driver ? [['drivers', driver] as [string, Plain]] : [])];
  blocks.push(
    { kind: 'heading', text: 'Driver' },
    { kind: 'facts', rows: [['Driver', String(s.driver?.name ?? '')], ['Code', String(s.driver?.code ?? '')], ['Phone', String(s.driver?.phone ?? '')], ['Trips', s.trips.map((t) => t.number).join(', ')], ['Period', `${when(s.settlement.from)} to ${when(s.settlement.to)}`], ['Posted', when(s.settlement.postedAt)]] },
    ...await printedPictures('driver_statement', printed),
    { kind: 'heading', text: 'Entries' },
    { kind: 'table', columns: [{ label: 'Date', width: 2.4 }, { label: 'Entry', width: 4 }, { label: 'Amount', width: 2, align: 'right' }], rows: s.lines.map((l) => [when(l.at), l.label, amount(l.amountMinor)]) },
    { kind: 'heading', text: 'Summary' },
    {
      kind: 'facts', rows: [
        ...await printedFields('driver_statement', printed),
        ['Opening balance', amount(s.settlement.openingMinor)],
        ['Advances', amount(s.settlement.advancesMinor)],
        ['Approved expenses', amount(s.settlement.expensesMinor)],
        ...(Number(s.settlement.shortagesMinor) ? [['Shortage', amount(s.settlement.shortagesMinor)] as [string, string]] : []),
        ...(Number(s.settlement.writeOffsMinor) ? [['Load written off', amount(s.settlement.writeOffsMinor)] as [string, string]] : []),
        // Lines Finance typed, so the summary adds up to what was carried forward (#102).
        ...(((s.settlement as unknown as Plain).lines ?? []) as Plain[]).map((l) => [`${String(l.label)}${l.toDriver ? ' (for the driver)' : ''}`, `${l.toDriver ? '− ' : ''}${amount(l.amountMinor)}`] as [string, string]),
        [Number(s.settlement.cashMinor) < 0 ? 'Paid to the driver' : 'Returned by the driver', amount(Math.abs(Number(s.settlement.cashMinor)))],
        ['Carried forward', amount(s.settlement.closingMinor)],
      ],
    },
  );
  if (s.settlement.note) blocks.push({ kind: 'text', text: String(s.settlement.note) });
  blocks.push({ kind: 'signatures', labels: ((layout?.signatureLines ?? ['Finance', 'Driver']) as string[]) });
  return { name: fileName(await word('statement'), s.settlement.number), body: renderPdf(blocks, { ...pageOf(layout), ...(await documentBrand('statement')) }) };
}

/** Stores a printout so a message can attach it; `null` when there is nobody to file it under. A sheet sent in a message carries no prices. */
export async function printoutFile(kind: 'trip_sheet' | 'driver_statement', id: string, actorId: string | undefined) {
  if (!actorId) return null;
  const { name, body } = kind === 'trip_sheet' ? await tripSheetPdf(id, () => false) : await statementPdf(id);
  return store(name, body, actorId, { entity: kind === 'trip_sheet' ? 'trips' : 'settlements', recordId: id });
}
