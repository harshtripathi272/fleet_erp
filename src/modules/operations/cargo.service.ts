import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
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
import { operationsSettings } from './settings.js';

const LABEL: Record<string, string> = { loading: 'loading invoice', delivery: 'delivery note', expense: 'receipt', fuel: 'fuel slip', other: 'message' };

/** Product facts for measuring: whether it is corrected to 20 °C and its unit symbol. */
async function productFacts(id: unknown) {
  const product = await activeRecord(Product, id, 'product');
  const unit = await Unit.findById(product.unitId).select('symbol code').lean();
  return { product, unit: String(unit?.symbol ?? unit?.code ?? ''), volumeCorrected: Boolean(product.volumeCorrected) };
}

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
};

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
  });
  await save(doc);
  const id = String(doc._id);
  const label = LABEL[input.kind]!;
  if (input.channel !== 'operations') await post(driverThread(driver._id), at, { from: 'me', text: input.note ?? '', attachment: file }, ctx);
  if (trip) await resolve(`${trip._id}-${input.kind}`, 'Sent');
  if (input.channel !== 'operations') {
    const amount = reading?.amount ? ` for ${reading.amount.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${reading.currencyCode ?? ''}`.trimEnd() : '';
    await post(driverThread(driver._id), at, {
      text: input.kind === 'expense' || input.kind === 'fuel' ? `Got your ${label}${amount}. Finance will check it.` : `Got your ${label}${reading?.docNo ? ` ${reading.docNo}` : ''}. Operations will confirm it.`,
    }, ctx);
  }
  // Say where the figures came from: a simulator invents them; otherwise the sender typed them, or nobody has yet.
  const source = simulated
    ? 'Simulated: a sample picture with generated figures, not a real document.'
    : reading ? `Figures as typed by ${input.channel === 'operations' ? ctx.name : driver.name}. Check them against the photo.` : '';
  const rows: Array<[string, string]> = [['Trip', trip ? `${trip.number} · ${await plateOf(trip.vehicleId)}` : 'No trip']];
  if (reading?.docNo) rows.push(['Document', reading.docNo]);
  if (reading?.ambientL) rows.push(['Observed', `${litres(reading.ambientL)} at ${reading.tempC} °C · ${reading.density} kg/m³`]);
  else if (reading?.qty) rows.push(['Quantity', `${reading.qty}`]);
  if (reading?.amount) rows.push(['Amount', `${reading.amount.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${reading.currencyCode ?? ''}`.trim()]);
  if (input.note) rows.push(['Note', input.note]);
  if (input.kind === 'expense' || input.kind === 'fuel') {
    const buttons: MessageButton[] = reading?.amount && reading.categoryId
      ? [
        {
          label: `Approve ${reading.amount.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${reading.currencyCode ?? ''}`.trim(), tone: 'primary',
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
async function markRecorded(docId: unknown, tripId: unknown, ref: string, text: string) {
  if (!docId) return;
  const doc = await DriverDocument.findById(docId);
  if (!doc) throw refuse('The document was not found.');
  if (String(doc.get('tripId') ?? '') !== String(tripId)) throw refuse('That document belongs to another trip.');
  if (doc.get('status') !== 'new') throw conflict('That document was already handled.');
  doc.set({ status: 'recorded', recordRef: ref });
  await save(doc);
  await resolve(String(doc._id), text);
}

/* ---------- Loading ---------- */

export async function listConsignments(query: S.ConsignmentListQuery) {
  const filter: Plain = {};
  if (query.tripId) filter.tripId = query.tripId;
  if (query.shortage) filter['shortage.status'] = query.shortage;
  const [rows, total] = await Promise.all([
    Consignment.find(filter).sort({ loadedAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Consignment.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: query.page, limit: query.limit };
}

export async function getConsignment(id: string) {
  const doc = await Consignment.findById(id).lean();
  if (!doc) throw new NotFoundError('Consignment not found');
  return present(doc);
}

async function fuelChecks(input: { tempC?: number; density?: number }, stage: string) {
  if (input.tempC == null || input.density == null) throw refuse(`Fuel needs temperature and density${stage}.`);
  const { densityMinKgM3, densityMaxKgM3 } = await operationsSettings();
  if (input.density < densityMinKgM3 || input.density > densityMaxKgM3) throw refuse(`Density looks wrong: expected ${densityMinKgM3}–${densityMaxKgM3} kg/m³.`);
}

export async function recordLoading(input: S.LoadingInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'create');
  const at = new Date();
  const trip = await Trip.findById(input.tripId);
  if (!trip) throw new NotFoundError('Trip not found');
  if (!trip.get('dispatchedAt')) throw conflict('Dispatch the truck first.');
  if (!trip.get('active')) throw conflict('This trip is closed.');
  if (await Consignment.exists({ tripId: trip._id, delivered: { $exists: false } })) throw conflict('This truck is already loaded.');
  assertStageAllows(trip.toObject(), 'loaded');
  const { product, unit, volumeCorrected } = await productFacts(input.productId);
  const truck = await truckFacts(trip.get('vehicleId'), false);
  const trailer = trip.get('trailerId') ? await Trailer.findById(trip.get('trailerId')).select('registrationNumber capacityL').lean() : null;
  if (volumeCorrected) {
    await fuelChecks(input, '');
    if (trailer?.capacityL && (input.ambientL ?? input.qty) > Number(trailer.capacityL)) throw refuse(`${trailer.registrationNumber} holds ${litres(Number(trailer.capacityL))}.`);
  } else if (unit === 't' && truck.capacityT && input.qty > truck.capacityT) throw refuse(`${truck.plate} carries ${truck.capacityT} t.`);
  const stops = trip.get('stops') as Array<{ kind: string; legKm: number }>;
  const index = stops.findIndex((s) => s.kind === 'load');
  await arriveAt(trip, index, at, ctx, 'office');
  const load = measure({ volumeCorrected, unit }, { qty: input.qty, ambientL: input.ambientL ?? (volumeCorrected ? input.qty : undefined), tempC: input.tempC, density: input.density, certStd20L: input.certStd20L });
  const customer = await partyName(trip.get('customerId'));
  const consignment = new Consignment({
    number: await nextNumber('consignments', 'CN', at), tripId: trip._id, productId: product._id, invoiceNo: input.invoiceNo,
    consignor: input.consignor || '—', consignee: input.consignee || customer, loadedAt: at, loadDocId: input.docId, load,
    createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  await save(consignment, 'This truck is already loaded.');
  const tracking = trip.get('tracking');
  if (tracking) trip.set('tracking.km', Math.max(Number(tracking.km ?? 0), cumulativeKm(stops)[index]!));
  trip.markModified('stops');
  recordEvent(trip, 'loaded', at, ctx.actorId);
  await save(trip);
  await markRecorded(input.docId, trip._id, consignment.get('number'), `Loading confirmed · ${consignment.get('number')}`);
  const qty = volumeCorrected ? `${litres(load.qty)} ${String(product.name).toLowerCase()} · ${litres(volume20(load) ?? load.qty)} at 20 °C` : `${load.qty} ${unit} ${String(product.name).toLowerCase()}`;
  if (trip.get('driverId')) {
    const offload = stops.find((s) => s.kind === 'offload') as { placeId?: unknown } | undefined;
    await post(driverThread(trip.get('driverId')), at, { title: 'Loading confirmed', text: `${qty}. Drive safe to ${await placeName(offload?.placeId)}.`, rows: [['Consignment', consignment.get('number')], ['Invoice', input.invoiceNo]] }, ctx);
  }
  await log(ctx, at, `Loaded ${qty} · ${consignment.get('number')}`, { tripId: trip._id });
  await announce('trip.loaded', trip.toObject() as Plain, ctx, {
    variables: { 'place.name': await placeName((stops[index] as { placeId?: unknown } | undefined)?.placeId), 'document.number': input.invoiceNo },
    ref: { kind: 'consignments', id: consignment._id },
  });
  return present(consignment.toObject());
}

/* ---------- Delivery and shortage ---------- */

/** Shortage beyond the allowance, priced per litre: the product's shortage policy first, then the product, then the company default. */
async function shortageFor(consignment: Plain, delivered: Measure) {
  const loaded20 = volume20(consignment.load as Measure);
  const delivered20 = volume20(delivered);
  if (loaded20 == null || delivered20 == null) return undefined;
  const product = (await Product.findById(consignment.productId).lean()) as Plain;
  const policy = (await ShortagePolicy.findOne({ status: 'active', $or: [{ productId: product._id }, { productGroupId: product.groupId }] }).sort({ productId: -1 }).lean()) as Plain | null;
  const percent = policy
    ? policy.allowanceKind === 'absolute' ? round((Number(policy.allowanceValue) / loaded20) * 100, 4) : Number(policy.allowanceValue)
    : Number(product.shortageAllowancePercent ?? (await operationsSettings()).defaultShortageAllowancePercent);
  const figures = shortageLitres(loaded20, delivered20, percent);
  const price = (policy?.pricePerUnit ?? product.shortagePricePerUnit) as { amountMinor: number; currencyId: unknown } | undefined;
  const share = policy?.bearer === 'company' ? 0 : policy?.bearer === 'shared' ? Number(policy.driverSharePercent ?? 50) / 100 : 1;
  const amountMinor = price ? Math.round(figures.netShortL * price.amountMinor * share) : 0;
  const baseAmountMinor = price && amountMinor ? (await toBase(amountMinor, price.currencyId)).baseMinor : 0;
  const pending = figures.netShortL > 0 && baseAmountMinor > 0;
  return {
    ...figures,
    ...(price ? { pricePerL: price, amount: { amountMinor, currencyId: price.currencyId } } : {}),
    baseAmountMinor,
    status: pending ? 'pending' : 'none',
    // Waiving is an approval: route it now, so the desks know who may waive it.
    ...(pending ? { approval: await routeApproval('shortage_waiver', { amountMinor: baseAmountMinor, currencyId: (await baseCurrency()).id }) } : {}),
  };
}

export async function recordDelivery(id: string, input: S.DeliveryInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const at = new Date();
  const consignment = await loadOr404(Consignment, id, 'Consignment');
  if (consignment.get('delivered')) throw conflict('Already delivered.');
  const trip = await Trip.findById(consignment.get('tripId'));
  if (!trip) throw new NotFoundError('Trip not found');
  if (!trip.get('active')) throw conflict('This trip is closed.');
  assertStageAllows(trip.toObject(), 'delivered');
  const { product, unit, volumeCorrected } = await productFacts(consignment.get('productId'));
  if (volumeCorrected) await fuelChecks(input, ' at offloading');
  const load = consignment.get('load');
  const measured = measure({ volumeCorrected, unit }, { qty: input.qty, ambientL: input.ambientL ?? (volumeCorrected ? input.qty : undefined), tempC: input.tempC, density: input.density, certStd20L: input.certStd20L });
  // Fuel is compared at 20 °C, where it is comparable: ambient litres grow and shrink with the temperature,
  // so a delivery can look fine warm and still be more than was loaded. Other cargo compares its quantity.
  const { deliveredOverLoadedPercent } = await operationsSettings();
  const loaded20 = volume20(load as Measure);
  const delivered20 = volume20(measured);
  const [loadedQty, deliveredQty, at20] = loaded20 != null && delivered20 != null
    ? [loaded20, delivered20, true] : [Number(load.ambientL ?? load.qty), input.qty, false];
  const limit = loadedQty * (1 + deliveredOverLoadedPercent / 100);
  if (deliveredQty > limit) {
    throw refuse(`Delivered ${Math.round(deliveredQty).toLocaleString('en-GB')}${at20 ? ' L at 20 °C' : ''} is more than loaded (${Math.round(loadedQty).toLocaleString('en-GB')}) by over ${deliveredOverLoadedPercent}%. Check the figures.`);
  }
  const stops = trip.get('stops') as Array<{ kind: string; legKm: number }>;
  const index = stops.findIndex((s) => s.kind === 'offload');
  await arriveAt(trip, index, at, ctx, 'office');
  consignment.set({ delivered: { ...measured, at, podNo: input.podNo, docId: input.docId }, inTransit: false });
  const shortage = volumeCorrected ? await shortageFor(consignment.toObject() as Plain, measured) : undefined;
  if (shortage) consignment.set('shortage', shortage);
  consignment.set('updatedBy', ctx.actorId);
  await save(consignment, 'Already delivered.');
  if (!(await Consignment.exists({ tripId: trip._id, delivered: { $exists: false } }))) {
    const cum = cumulativeKm(stops);
    for (let i = index + 1; i < stops.length; i += 1) if (cum[i]! <= cum[index]! + 0.01) await arriveAt(trip, i, at, ctx, 'office');
  }
  const tracking = trip.get('tracking');
  if (tracking) trip.set('tracking.km', Math.max(Number(tracking.km ?? 0), cumulativeKm(stops)[index]!));
  trip.markModified('stops');
  recordEvent(trip, 'delivered', at, ctx.actorId);
  await save(trip);
  await markRecorded(input.docId, trip._id, consignment.get('number'), `Delivery confirmed · ${consignment.get('number')}`);
  const number = String(trip.get('number'));
  const driverId = trip.get('driverId');
  if (driverId) {
    const text = shortage
      ? shortage.netShortL > 0
        ? `${litres(shortage.delivered20L)} at 20 °C. ${litres(shortage.lossL)} less than loaded; finance will review the ${litres(shortage.netShortL)} above the allowance.`
        : `${litres(shortage.delivered20L)} at 20 °C, within the allowance. Well done.`
      : `${measured.qty} ${unit} delivered.`;
    await post(driverThread(driverId), at, { title: 'Delivery confirmed', text, rows: [['Delivery note', input.podNo]] }, ctx);
  }
  if (shortage?.status === 'pending') {
    const charge = formatMoney(shortage.baseAmountMinor, await baseCurrency());
    const price = shortage.pricePerL ? formatMoney(shortage.pricePerL.amountMinor, await currencyInfo(shortage.pricePerL.currencyId)) : '—';
    await post(queue('shortage-decisions'), at, {
      title: `Fuel shortage on ${number}`,
      text: `${litres(shortage.netShortL)} beyond the ${shortage.allowancePercent}% allowance.`,
      rows: [
        ['Loaded at 20 °C', litres(shortage.loaded20L)], ['Delivered at 20 °C', litres(shortage.delivered20L)],
        ['Allowance', litres(shortage.allowanceL)], ['Charge', `${charge} (${price}/L)`], ['Driver', (await driverName(driverId)) || '—'],
      ],
      buttons: [
        { label: `Charge ${charge}`, tone: 'primary', action: { type: 'shortage.decide', consignmentId: id, charge: true, via: 'whatsapp' } },
        { label: 'Waive', action: { type: 'shortage.decide', consignmentId: id, charge: false, note: 'Waived on WhatsApp', via: 'whatsapp' } },
        { label: 'Open trip', nav: { tripId: String(trip._id), view: 'offloading' } },
      ],
      refId: `${id}-shortage`,
    }, ctx);
  }
  await log(ctx, at, `Delivered · ${input.podNo}${shortage ? ` · ${litres(shortage.lossL)} transit loss` : ''}`, { tripId: trip._id });
  await announce('trip.delivered', trip.toObject() as Plain, ctx, {
    variables: { 'place.name': await placeName((stops[index] as { placeId?: unknown } | undefined)?.placeId), 'document.number': input.podNo },
    ref: { kind: 'consignments', id: consignment._id },
  });
  return present(consignment.toObject());
}

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
      title: input.charge ? 'Fuel shortage charged' : 'Fuel shortage waived',
      text: input.charge ? `${litres(Number(shortage.netShortL))} beyond the allowance on ${trip.number}: ${charge} added to your account.` : `No charge for the shortage on ${trip.number}.`,
    }, ctx);
  }
  await log(ctx, at, input.charge ? `Shortage charged: ${charge}` : `Shortage waived: ${input.note}`, { tripId: trip._id });
  return present(consignment.toObject());
}
