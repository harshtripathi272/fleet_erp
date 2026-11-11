import * as Fmt from '../../core/format/regional.js';
import { csv, xlsx } from '../../core/export/xlsx.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { Currency } from '../finance/models/currency.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { Place } from '../geography/models/place.model.js';
import { Party } from '../parties/models/party.model.js';
import { listConsignments, seesRevenue } from './consignments.service.js';
import { Trip } from './models/trip.model.js';
import type * as S from './operations.schema.js';
import type { OpsContext } from './support.js';

/**
 * The consignment report (#135 Part 4, design 3.11.6): the statement a transporter sends a customer, and what the
 * office looks back at. Its columns are a choice; the default is the 8 Nov view (trip, vehicle, invoice date,
 * consignment note, product, quantity, route, distance). Money columns only for those who may see money. The same
 * rows download as an Excel workbook or CSV.
 */

type Row = { c: Plain; trip?: Plain; plate?: string; product?: Plain; names: (id: unknown) => string | undefined; place: (id: unknown) => string | undefined; currency?: Plain };
interface Column { key: string; label: string; money?: boolean; value: (r: Row) => string | number | undefined }

const legs = (c: Plain, kind: 'pickup' | 'drop') => ((c.legs ?? []) as Plain[]).filter((l) => l.kind === kind && l.status !== 'skipped');
const doneQty = (c: Plain, kind: 'pickup' | 'drop') => {
  const done = legs(c, kind).filter((l) => l.status === 'done');
  return done.length ? done.flatMap((l) => (l.actual ?? []) as Plain[]).reduce((s, m) => s + Number(kind === 'drop' ? m.accepted ?? m.qty : m.qty), 0) : undefined;
};
const firstAt = (c: Plain, kind: 'pickup' | 'drop', last = false) => {
  const done = legs(c, kind).filter((l) => l.recordedAt).sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  return last ? done.at(-1) : done[0];
};
const date = (v: unknown) => (v ? Fmt.date(new Date(v as string)) : undefined);
const round = (n: number | undefined, d = 3) => (n === undefined ? undefined : Math.round(n * 10 ** d) / 10 ** d);
const minorOut = (r: Row, minor: unknown) => (minor === undefined || minor === null ? undefined : round(Number(minor) / 10 ** Number(r.currency?.minorUnits ?? 2), 2));

export const COLUMNS: Column[] = [
  { key: 'tripNo', label: 'Trip no.', value: (r) => r.trip?.number as string | undefined },
  { key: 'vehicleNo', label: 'Vehicle no.', value: (r) => r.plate },
  { key: 'invoiceDate', label: 'Invoice date', value: (r) => {
    const invoice = ((r.c.documents ?? []) as Plain[]).find((d) => legs(r.c, 'pickup').some((l) => String(l.id) === String(d.legId)));
    return date(invoice?.date ?? invoice?.at ?? r.c.loadedAt);
  } },
  { key: 'lrNo', label: 'Consignment note', value: (r) => ((r.c.references as Plain | undefined)?.lrNo as string | undefined) ?? (r.c.number as string) },
  { key: 'product', label: 'Product', value: (r) => r.product?.name as string | undefined },
  { key: 'quantity', label: 'Quantity', value: (r) => round(doneQty(r.c, 'drop') ?? doneQty(r.c, 'pickup') ?? ((r.c.lines as Plain[] | undefined)?.[0]?.plannedQty as number | undefined)) },
  { key: 'unit', label: 'Unit', value: (r) => (r.c.lines as Plain[] | undefined)?.[0]?.unit as string | undefined },
  { key: 'route', label: 'Route', value: (r) => {
    const from = legs(r.c, 'pickup')[0];
    const to = legs(r.c, 'drop').at(-1);
    return `${r.place(from?.placeId) ?? 'to be confirmed'} → ${r.place(to?.placeId) ?? 'to be confirmed'}`;
  } },
  { key: 'leadKm', label: 'Distance (km)', value: (r) => (r.c.leadKm ? Math.round(Number(r.c.leadKm)) : undefined) },
  { key: 'number', label: 'Consignment no.', value: (r) => r.c.number as string },
  { key: 'customer', label: 'Customer', value: (r) => r.names(r.c.customerId) },
  { key: 'consignor', label: 'Consignor', value: (r) => (r.c.consignor as Plain | undefined)?.name as string | undefined ?? r.names(r.c.consignorPartyId) },
  { key: 'consignee', label: 'Consignee', value: (r) => (r.c.consignee as Plain | undefined)?.name as string | undefined ?? r.names(r.c.consigneePartyId) ?? r.names(r.c.customerId) },
  { key: 'loadedQty', label: 'Loaded', value: (r) => round(doneQty(r.c, 'pickup')) },
  { key: 'deliveredQty', label: 'Delivered', value: (r) => round(doneQty(r.c, 'drop')) },
  { key: 'difference', label: 'Difference', value: (r) => {
    const a = doneQty(r.c, 'pickup'); const b = doneQty(r.c, 'drop');
    return a !== undefined && b !== undefined ? round(a - b) : undefined;
  } },
  { key: 'loadedAt', label: 'Loaded at', value: (r) => r.place(firstAt(r.c, 'pickup')?.placeId) },
  { key: 'loadedOn', label: 'Loaded on', value: (r) => date(firstAt(r.c, 'pickup')?.recordedAt ?? r.c.loadedAt) },
  { key: 'deliveredAt', label: 'Delivered at', value: (r) => r.place(firstAt(r.c, 'drop', true)?.placeId) },
  { key: 'deliveredOn', label: 'Delivered on', value: (r) => date(r.c.deliveredAt ?? firstAt(r.c, 'drop', true)?.recordedAt) },
  { key: 'hoursOnRoad', label: 'Hours on the road', value: (r) => {
    const up = firstAt(r.c, 'pickup')?.recordedAt; const down = r.c.deliveredAt;
    return up && down ? Math.round(((new Date(down as string).getTime() - new Date(up as string).getTime()) / 36e5) * 10) / 10 : undefined;
  } },
  { key: 'podNo', label: 'Proof of delivery no.', value: (r) => legs(r.c, 'drop').map((l) => (l.pod as Plain | undefined)?.number).filter(Boolean).join(', ') || undefined },
  { key: 'status', label: 'Status', value: (r) => String(r.c.status).replace(/_/g, ' ') },
  { key: 'freight', label: 'Before tax', money: true, value: (r) => minorOut(r, (r.c.revenue as Plain | undefined)?.subtotalMinor) },
  { key: 'total', label: 'Total', money: true, value: (r) => minorOut(r, (r.c.revenue as Plain | undefined)?.totalMinor) },
  { key: 'currency', label: 'Currency', money: true, value: (r) => r.currency?.code as string | undefined },
  { key: 'priced', label: 'Priced', money: true, value: (r) => (r.c.revenue as Plain | undefined)?.status as string | undefined },
];
export const DEFAULT_COLUMNS = ['tripNo', 'vehicleNo', 'invoiceDate', 'lrNo', 'product', 'quantity', 'unit', 'route', 'leadKm'];

export type ReportQuery = S.ConsignmentsQuery & { columns?: string };

export async function consignmentReport(query: ReportQuery, ctx: OpsContext) {
  const money = seesRevenue(ctx.can);
  const available = COLUMNS.filter((c) => money || !c.money);
  const asked = (query.columns ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const columns = (asked.length ? asked : DEFAULT_COLUMNS).map((k) => available.find((c) => c.key === k)).filter((c): c is Column => Boolean(c));
  const { columns: _c, ...filters } = query;
  const page = await listConsignments({ ...filters, page: query.page ?? 1, limit: Math.min(Number(query.limit ?? 500), 500) } as S.ConsignmentsQuery, ctx);
  const rows = page.data as Plain[];
  const tripIds = rows.map((c) => c.tripId).filter(Boolean);
  const trips = new Map((await Trip.find({ _id: { $in: tripIds } }).select('number vehicleId').lean()).map((t) => [String(t._id), t as Plain]));
  const plates = new Map((await Vehicle.find({ _id: { $in: [...trips.values()].map((t) => t.vehicleId) } }).select('registrationNumber').lean()).map((v) => [String(v._id), String((v as Plain).registrationNumber)]));
  const products = new Map((await Product.find({ _id: { $in: rows.map((c) => c.productId).filter(Boolean) } }).select('name').lean()).map((p) => [String(p._id), p as Plain]));
  const partyIds = rows.flatMap((c) => [c.customerId, c.consignorPartyId, c.consigneePartyId]).filter(Boolean);
  const parties = new Map((await Party.find({ _id: { $in: partyIds } }).select('name').lean()).map((p) => [String(p._id), String((p as Plain).name)]));
  const placeIds = rows.flatMap((c) => ((c.legs ?? []) as Plain[]).map((l) => l.placeId)).filter(Boolean);
  const places = new Map((await Place.find({ _id: { $in: placeIds } }).select('name').lean()).map((p) => [String(p._id), String((p as Plain).name)]));
  const currencies = new Map((await Currency.find({ _id: { $in: rows.map((c) => (c.revenue as Plain | undefined)?.currencyId).filter(Boolean) } }).select('code minorUnits').lean()).map((x) => [String(x._id), x as Plain]));
  const table = rows.map((c) => {
    const trip = c.tripId ? trips.get(String(c.tripId)) : undefined;
    const r: Row = {
      c, trip, plate: trip ? plates.get(String(trip.vehicleId)) : undefined, product: products.get(String(c.productId)),
      names: (id) => (id ? parties.get(String(id)) : undefined), place: (id) => (id ? places.get(String(id)) : undefined),
      currency: currencies.get(String((c.revenue as Plain | undefined)?.currencyId)),
    };
    return Object.fromEntries(columns.map((col) => [col.key, col.value(r) ?? null]));
  });
  // Totals: the count, the quantity per unit, the distance, and money per currency.
  const quantities = new Map<string, number>();
  const amounts = new Map<string, { amountMinor: number; minorUnits: number }>();
  let km = 0;
  for (const c of rows) {
    const unit = String((c.lines as Plain[] | undefined)?.[0]?.unit ?? '');
    const q = doneQty(c, 'drop') ?? doneQty(c, 'pickup') ?? Number((c.lines as Plain[] | undefined)?.[0]?.plannedQty ?? 0);
    quantities.set(unit, (quantities.get(unit) ?? 0) + q);
    km += Number(c.leadKm ?? 0);
    const rev = c.revenue as Plain | undefined;
    const cur = rev?.currencyId ? currencies.get(String(rev.currencyId)) : undefined;
    if (money && cur && rev?.totalMinor !== undefined) {
      const was = amounts.get(String(cur.code)) ?? { amountMinor: 0, minorUnits: Number(cur.minorUnits ?? 2) };
      amounts.set(String(cur.code), { ...was, amountMinor: was.amountMinor + Number(rev.totalMinor) });
    }
  }
  return {
    columns: columns.map(({ key, label, money: m }) => ({ key, label, money: Boolean(m) })),
    rows: table,
    totals: {
      count: page.total,
      quantities: [...quantities].map(([unit, qty]) => ({ unit, qty: round(qty) })),
      km: Math.round(km),
      money: [...amounts].map(([currency, a]) => ({ currency, amountMinor: a.amountMinor, minorUnits: a.minorUnits })),
    },
    available: available.map(({ key, label, money: m }) => ({ key, label, money: Boolean(m) })),
    total: page.total,
  };
}

/** The report as a file: exactly the columns and filters asked for. */
export async function consignmentReportFile(query: ReportQuery, ctx: OpsContext, kind: 'xlsx' | 'csv') {
  const report = await consignmentReport({ ...query, page: 1, limit: 500 } as ReportQuery, ctx);
  const sheet = [report.columns.map((c) => c.label), ...report.rows.map((r) => report.columns.map((c) => r[c.key] as string | number | null))];
  return kind === 'xlsx'
    ? { body: xlsx('Consignments', sheet), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'consignments.xlsx' }
    : { body: csv(sheet), mime: 'text/csv; charset=utf-8', name: 'consignments.csv' };
}
