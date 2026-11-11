import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import * as Fmt from '../../core/format/regional.js';
import { Currency } from '../finance/models/currency.model.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { ShortagePolicy } from '../cargo/models/shortagePolicy.model.js';
import { Trailer } from '../fleet/models/trailer.model.js';
import { Unit } from '../geography/models/unit.model.js';
import { ExpenseCategory } from '../trips/models/expense.model.js';
import { mayDecideAll, routeApproval, waitingOn } from './approvals.js';
import { assertStageAllows, recordEvent } from './stages.js';
import { cumulativeKm, measure, round, shortageLitres, volume20, type Measure } from './calc.js';
import { Consignment, DriverDocument } from './models/cargo.model.js';
import { Trip } from './models/trip.model.js';
import { announce } from './notices.js';
import {
  activeDriver, activeRecord, baseCurrency, conflict, currencyInfo, driverThread, formatMoney, litres, loadOr404, log, need, nextNumber,
  post, present, queue, refuse, resolve, save, toBase, type MessageButton, type OpsContext,
} from './support.js';
import { arriveAt, driverName, partyName, placeName, plateOf, truckFacts } from './trips.service.js';
import type * as S from './operations.schema.js';
import { attachable } from '../files/files.service.js';
import { customValues, stepCustom } from './placements.js';
import { operationsSettings } from './settings.js';

const LABEL: Record<string, string> = { loading: 'loading invoice', delivery: 'delivery note', expense: 'receipt', fuel: 'fuel slip', other: 'message' };

export type CargoKind = 'volume' | 'weighed' | 'counted';

/** Product facts for measuring: the unit drives it. Corrected to 20 °C, weighed if its unit is a mass, otherwise counted in its unit. */
export async function productFacts(id: unknown) {
  const product = await activeRecord(Product, id, 'product');
  const unit = await Unit.findById(product.unitId).select('symbol code dimension decimals').lean<{ symbol?: string; code?: string; dimension?: string; decimals?: number }>();
  const volumeCorrected = Boolean(product.volumeCorrected);
  const kind: CargoKind = volumeCorrected ? 'volume' : unit?.dimension === 'mass' ? 'weighed' : 'counted';
  return { product, unit: String(unit?.symbol ?? unit?.code ?? ''), volumeCorrected, kind, decimals: Number(unit?.decimals ?? 2) };
}

/** The quantity recorded: a weighbridge ticket's net, or the figure given. */
export function quantityOf(kind: CargoKind, input: { qty?: number; gross?: number; tare?: number }, decimals: number) {
  if (kind === 'weighed' && (input.gross != null || input.tare != null)) {
    if (input.gross == null || input.tare == null) throw refuse('Enter both the gross and the tare from the weighbridge ticket.');
    if (input.tare >= input.gross) throw refuse('The tare must be less than the gross.');
    return round(input.gross - input.tare, decimals);
  }
  if (input.qty == null) throw refuse(kind === 'weighed' ? 'Enter the gross and the tare from the weighbridge ticket.' : 'Enter the quantity.');
  return input.qty;
}

/** "1,200 kg", or litres as everywhere else. */
export const amountOf = (value: number, unit: string) => (unit === 'L' ? litres(value) : `${Fmt.number(value, { max: 6 })} ${unit}`);

/* ---------- Driver documents ---------- */

export async function listDocuments(query: S.DocumentListQuery) {
  const filter: Plain = {};
  for (const key of ['tripId', 'driverId', 'status', 'kind'] as const) if (query[key]) filter[key] = query[key];
  const [rows, total] = await Promise.all([
    DriverDocument.find(filter).sort({ at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    DriverDocument.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: query.page, limit: query.limit };
}

export async function getDocument(id: string) {
  const doc = await DriverDocument.findById(id).lean();
  if (!doc) throw new NotFoundError('Document not found');
  return present(doc);
}

/**
 * A photo or message from a driver: over WhatsApp (Marichi Talks or the simulated phone), or filed by
 * the office. The office is told and offered the next step built from the figures read off the photo.
 */
/** A document as filed: an uploaded file, a WhatsApp photo by URL, or the simulated phone's sample picture. */
export type DocumentInput = Omit<S.SendDocumentInput, 'file'> & {
  file?: { fileId: string } | { name: string; mime: string; sampleId?: string; url?: string };
  /** The consignment, pickup or drop, and paper the driver said it is for (#135 Part 2). */
  consignmentId?: string;
  /**
   * WhatsApp: hold the usual "Got your …" reply, because filing the photo on its consignment answers more
   * exactly ("We got your proof of delivery for CN/…"). The caller sends this reply only if nothing else did (#102).
   */
  holdReply?: boolean;
  legId?: string;
  documentTypeId?: string;
};

/** The driver's "Got your …" for a paper or receipt: who checks it next. */
export async function acknowledgeDocument(driverId: unknown, kind: string, reading: Plain | undefined, at: Date, ctx: OpsContext) {
  const label = LABEL[kind as keyof typeof LABEL] ?? 'paper';
  const amount = reading?.amount ? ` for ${Fmt.number(Number(reading.amount), { max: 2 })} ${String(reading.currencyCode ?? '')}`.trimEnd() : '';
  const money = kind === 'expense' || kind === 'fuel';
  await post(driverThread(driverId), at, {
    text: money ? `Got your ${label}${amount}. Finance will check it.` : `Got your ${label}${reading?.docNo ? ` ${String(reading.docNo)}` : ''}. Operations will confirm it.`,
    wa: { template: 'document_received', values: money ? [`${label}${amount}`, 'Finance'] : [`${label}${reading?.docNo ? ` ${String(reading.docNo)}` : ''}`, 'Operations'] },
  }, ctx);
}

export async function sendDocument(input: DocumentInput, ctx: OpsContext) {
  need(ctx, 'driver-documents', 'create');
  const at = new Date();
  const driver = await activeDriver(input.driverId);
  if (ctx.driverId && ctx.driverId !== String(driver._id)) throw new ForbiddenError('You can only send your own documents');
  const trip = input.tripId ? ((await Trip.findById(input.tripId).lean()) as Plain | null) : null;
  if (input.tripId && !trip) throw new NotFoundError('Trip not found');
  if (trip && String(trip.driverId) !== String(driver._id)) throw refuse('This trip belongs to another driver.');
  if (!input.file && !input.note) throw refuse('Attach a photo or write a message.');
  const reading = input.reading;
  if (reading?.categoryId) await activeRecord(ExpenseCategory, reading.categoryId, 'expense type');
  const simulated = Boolean(ctx.simulated);
  let file: Plain | undefined;
  if (input.file && 'fileId' in input.file && input.file.fileId) {
    const stored = await attachable(input.file.fileId, { userId: ctx.actorId ?? '', driverId: ctx.driverId, can: ctx.can });
    file = { fileId: stored.id, name: stored.name, mime: stored.mime, size: stored.size };
  } else if (input.file) {
    if ('sampleId' in input.file && input.file.sampleId && !simulated) throw refuse('Sample pictures can only be sent from the simulated phone.');
    file = input.file as Plain;
  }
  const doc = new DriverDocument({
    driverId: driver._id, tripId: trip?._id, kind: input.kind, channel: input.channel, note: input.note, file,
    reading, simulated, status: 'new', at, createdBy: ctx.actorId, updatedBy: ctx.actorId,
    ...(input.consignmentId ? { consignmentId: input.consignmentId } : {}), ...(input.legId ? { legId: input.legId } : {}), ...(input.documentTypeId ? { documentTypeId: input.documentTypeId } : {}),
  });
  await save(doc);
  const id = String(doc._id);
  const label = LABEL[input.kind]!;
  if (input.channel !== 'operations') await post(driverThread(driver._id), at, { from: 'me', text: input.note ?? '', attachment: file }, ctx);
  if (trip) await resolve(`${trip._id}-${input.kind}`, 'Sent');
  if (input.channel !== 'operations' && !input.holdReply) await acknowledgeDocument(driver._id, input.kind, reading, at, ctx);
  // Say where the figures came from: a simulator invents them; otherwise the sender typed them, or nobody has yet.
  const source = simulated
    ? 'Simulated: a sample picture with generated figures, not a real document.'
    : reading ? `Figures as typed by ${input.channel === 'operations' ? ctx.name : driver.name}. Check them against the photo.` : '';
  const rows: Array<[string, string]> = [['Trip', trip ? `${trip.number} · ${await plateOf(trip.vehicleId)}` : 'No trip']];
  if (reading?.docNo) rows.push(['Document', reading.docNo]);
  if (reading?.ambientL) rows.push(['Observed', `${litres(reading.ambientL)} at ${reading.tempC} °C · ${reading.density} kg/m³`]);
  else if (reading?.qty) rows.push(['Quantity', `${reading.qty}`]);
  if (reading?.amount) rows.push(['Amount', `${Fmt.number(reading.amount, { max: 2 })} ${reading.currencyCode ?? ''}`.trim()]);
  if (input.note) rows.push(['Note', input.note]);
  if (input.kind === 'expense' || input.kind === 'fuel') {
    const buttons: MessageButton[] = reading?.amount && reading.categoryId
      ? [
        {
          label: `Approve ${Fmt.number(reading.amount, { max: 2 })} ${reading.currencyCode ?? ''}`.trim(), tone: 'primary',
          action: { type: 'expense.record', driverId: String(driver._id), tripId: trip ? String(trip._id) : undefined, categoryId: String(reading.categoryId), amount: reading.amount, currency: reading.currencyCode, receiptNo: reading.docNo, docId: id },
        },
        { label: 'Return', tone: 'danger', action: { type: 'doc.return', docId: id, reason: '' } },
        { label: 'Open', nav: { view: 'finance', docId: id } },
      ]
      : [{ label: 'Open', nav: { view: 'finance', docId: id } }];
    // The receipt goes to whoever approves an expense of this amount, or to anyone who records expenses.
    const currency = reading?.amount && reading.currencyCode ? await Currency.findOne({ code: reading.currencyCode, status: 'active' }).select('_id minorUnits').lean() : null;
    const thread = currency ? waitingOn(await routeApproval('expense', { amountMinor: Math.round(reading!.amount! * 10 ** Number(currency.minorUnits ?? 2)), currencyId: String(currency._id) }))!.thread : queue('expenses');
    await post(thread, at, { title: `${simulated ? 'Simulated receipt' : 'Receipt'} from ${driver.name}`, text: source || 'Enter the amount and type from the photo to approve it.', rows, attachment: file, buttons, refId: id }, ctx);
  } else {
    let confirm: MessageButton | undefined;
    if (trip && reading && input.kind === 'loading' && reading.productId && reading.docNo) {
      confirm = {
        label: 'Confirm loading', tone: 'primary',
        action: {
          type: 'load.record', tripId: String(trip._id), docId: id, productId: String(reading.productId), invoiceNo: reading.docNo,
          consignor: reading.consignor ?? '', consignee: reading.consignee ?? (await partyName(trip.customerId)),
          qty: reading.qty ?? reading.ambientL ?? 0, ambientL: reading.ambientL, tempC: reading.tempC, density: reading.density, certStd20L: reading.certStd20L,
        },
      };
    } else if (trip && reading && input.kind === 'delivery' && reading.docNo) {
      const open = await Consignment.findOne({ tripId: trip._id, delivered: { $exists: false } }).select('_id').lean();
      if (open) {
        confirm = {
          label: 'Confirm delivery', tone: 'primary',
          action: { type: 'delivery.record', consignmentId: String(open._id), docId: id, podNo: reading.docNo, qty: reading.qty ?? reading.ambientL ?? 0, ambientL: reading.ambientL, tempC: reading.tempC, density: reading.density, certStd20L: reading.certStd20L },
        };
      }
    }
    await post(queue('consignments'), at, {
      title: `${simulated ? `Simulated ${label}` : `${label[0]!.toUpperCase()}${label.slice(1)}`} from ${driver.name}`,
      text: [source || (input.file ? 'Type the figures from the photo on the trip, then confirm.' : ''), input.note].filter(Boolean).join(' '),
      rows, attachment: file,
      buttons: [
        ...(confirm ? [confirm] : []),
        ...(input.kind === 'other' ? [{ label: 'Done', tone: 'primary' as const, action: { type: 'doc.done', docId: id } }] : []),
        { label: 'Return', tone: 'danger', action: { type: 'doc.return', docId: id, reason: '' } },
        { label: 'Open trip', nav: { tripId: trip ? String(trip._id) : undefined, docId: id } },
      ],
      refId: id,
    }, ctx);
  }
  await log({ ...ctx, asDriver: input.channel !== 'operations' }, at, `${driver.name} sent the ${label}${input.channel === 'whatsapp' ? ' on WhatsApp' : ''}`, { tripId: trip?._id, entity: 'driver-documents', entityId: doc._id });
  return present(doc.toObject());
}

export async function returnDocument(id: string, input: S.ReasonInput, ctx: OpsContext) {
  need(ctx, 'driver-documents', 'update');
  const at = new Date();
  const doc = await loadOr404(DriverDocument, id, 'Document');
  if (doc.get('status') !== 'new') throw conflict('It was already handled.');
  doc.set({ status: 'returned', returnReason: input.reason, updatedBy: ctx.actorId });
  await save(doc);
  await resolve(id, 'Returned to driver');
  await post(driverThread(doc.get('driverId')), at, {
    title: 'Please send it again', text: input.reason,
    buttons: [{ label: 'Send again', tone: 'primary', attach: doc.get('kind') }],
    wa: { template: 'document_returned', values: [LABEL[String(doc.get('kind'))] ?? 'document', input.reason] },
    refId: `${doc.get('tripId')}-${doc.get('kind')}`,
  }, ctx);
  await log(ctx, at, `Returned the driver's document: ${input.reason}`, { tripId: doc.get('tripId'), entity: 'driver-documents', entityId: doc._id });
  return present(doc.toObject());
}

/**
 * A message or photo from the driver that is not a document to record (a breakdown, a question): someone in
 * the office has dealt with it. It stops waiting on the desks and its WhatsApp buttons close.
 */
export async function markDone(id: string, ctx: OpsContext) {
  need(ctx, 'driver-documents', 'update');
  const at = new Date();
  const doc = await loadOr404(DriverDocument, id, 'Document');
  if (doc.get('kind') !== 'other') throw refuse('Record this document on the trip instead.');
  if (doc.get('status') !== 'new') throw conflict('It was already handled.');
  doc.set({ status: 'recorded', recordRef: `Done by ${ctx.name}`, updatedBy: ctx.actorId });
  await save(doc);
  await resolve(id, `Done by ${ctx.name}`);
  await log(ctx, at, `Dealt with the driver's message${doc.get('note') ? `: ${doc.get('note')}` : ''}`, { tripId: doc.get('tripId'), entity: 'driver-documents', entityId: doc._id });
  return present(doc.toObject());
}

/** Marks the document the figures came from as recorded. */
export async function markRecorded(docId: unknown, tripId: unknown, ref: string, text: string) {
  if (!docId) return;
  const doc = await DriverDocument.findById(docId);
  if (!doc) throw refuse('The document was not found.');
  if (String(doc.get('tripId') ?? '') !== String(tripId)) throw refuse('That document belongs to another trip.');
  if (doc.get('status') !== 'new') throw conflict('That document was already handled.');
  doc.set({ status: 'recorded', recordRef: ref });
  await save(doc);
  await resolve(String(doc._id), text);
}

/* ---------- Measuring ---------- */

/** Fuel needs its temperature and a believable density before it is recorded. */
export async function fuelChecks(input: { tempC?: number; density?: number }, stage: string) {
  if (input.tempC == null || input.density == null) throw refuse(`Fuel needs temperature and density${stage}.`);
  const { densityMinKgM3, densityMaxKgM3 } = await operationsSettings();
  if (input.density < densityMinKgM3 || input.density > densityMaxKgM3) throw refuse(`Density looks wrong: expected ${densityMinKgM3}–${densityMaxKgM3} kg/m³.`);
}

/* Loading and delivery are recorded per pickup and drop of a consignment: consignments.service.ts (#135). */

/**
 * Charging a shortage needs the shortage-decisions permission. Waiving it is an approval: the person
 * must be the final approver for that amount under the company's shortage-waiver policy.
 */
export async function decideShortage(id: string, input: S.ShortageDecisionInput, ctx: OpsContext) {
  const at = new Date();
  const consignment = await loadOr404(Consignment, id, 'Consignment');
  const shortage = consignment.get('shortage');
  if (!shortage || shortage.status !== 'pending') throw conflict('Nothing to decide here.');
  const trip = (await Trip.findById(consignment.get('tripId')).lean()) as Plain;
  if (trip.settlementId) throw conflict('The trip is already settled.');
  if (input.charge) need(ctx, 'shortage-decisions', 'create', 'Your role does not decide shortages.');
  else {
    if (!input.note) throw refuse("Say why it's waived.");
    // The route stored at delivery; shortages recorded before it was stored are routed now.
    const stored = shortage.approval?.toObject?.() ?? shortage.approval;
    const approval = stored?.levels?.length ? stored : await routeApproval('shortage_waiver', { amountMinor: Number(shortage.baseAmountMinor), currencyId: (await baseCurrency()).id });
    if (!mayDecideAll(ctx, approval)) throw new ForbiddenError(`Waiving this needs ${approval.levels.at(-1)!.label}.`);
  }
  consignment.set({ 'shortage.status': input.charge ? 'charged' : 'waived', 'shortage.decidedAt': at, 'shortage.decidedBy': ctx.actorId, 'shortage.note': input.note, updatedBy: ctx.actorId });
  await save(consignment);
  const charge = formatMoney(Number(shortage.baseAmountMinor), await baseCurrency());
  await resolve(`${id}-shortage`, input.charge ? `Charged ${charge}` : 'Waived');
  if (trip.driverId) {
    await post(driverThread(trip.driverId), at, {
      title: `${shortage.unit && shortage.unit !== 'L' ? 'Shortage' : 'Fuel shortage'} ${input.charge ? 'charged' : 'waived'}`,
      text: input.charge ? `${amountOf(Number(shortage.netShortL), shortage.unit ?? 'L')} beyond the allowance on ${trip.number}: ${charge} added to your account.` : `No charge for the shortage on ${trip.number}.`,
      wa: { template: 'shortage_decided', values: [String(trip.number), input.charge ? `${amountOf(Number(shortage.netShortL), shortage.unit ?? 'L')} beyond the allowance, ${charge} added to your account` : 'no charge'] },
    }, ctx);
  }
  await log(ctx, at, input.charge ? `Shortage charged: ${charge}` : `Shortage waived: ${input.note}`, { tripId: trip._id });
  return present(consignment.toObject());
}
