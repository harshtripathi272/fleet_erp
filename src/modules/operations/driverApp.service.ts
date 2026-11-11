import { driverAnswers, driverQuestions } from './placements.js';
import { isAreaOn } from '../company/areas.js';
import type { DefectInput } from '../maintenance/maintenance.schema.js';
import { reportDefect as openDefect } from '../maintenance/maintenance.service.js';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import * as Fmt from '../../core/format/regional.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { ExpenseCategory } from '../trips/models/expense.model.js';
import { sendDocument } from './cargo.service.js';
import { driverLedger } from './ledger.js';
import { Consignment, DriverDocument } from './models/cargo.model.js';
import { hasDocument, isFinished, isLoaded, type ConsignmentP, type GateDocType, type LegP } from './legs.js';
import { ConsignmentDocumentType } from '../freight/models/freight.model.js';
import { tripGate } from './gate.js';
import { refuse } from './support.js';
import { FundRequest } from './models/funding.model.js';
import { Message } from './models/message.model.js';
import { Settlement } from './models/money.model.js';
import { Trip } from './models/trip.model.js';
import type * as S from './operations.schema.js';
import { statementPdf as settlementStatementPdf } from './printouts.js';
import { baseCurrency, currencyInfo, driverThread, formatMoney, log, save, type OpsContext } from './support.js';
import { arriveAtStop, partyName, placeName, plateOf, trailerPlate, driverTripNow } from './trips.service.js';
import { words } from '../company/workspace.js';

/**
 * The driver app: a driver signed in with their own account (a user linked to their driver record).
 * Every function here works only on that driver's own trip, documents, messages and account.
 */
export interface DriverActor {
  userId: string;
  driverId: string;
  name: string;
}

/** A driver may file their own documents and mark their own arrivals; nothing else. */
export const driverContext = (actor: DriverActor): OpsContext => ({
  actorId: actor.userId,
  name: actor.name,
  desk: 'driver',
  asDriver: true,
  driverId: actor.driverId,
  roles: [],
  can: (resource, action) => (resource === 'driver-documents' && action === 'create') || (resource === 'trips' && action === 'update'),
});

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : undefined);

async function ownTrip(driverId: string) {
  return (await Trip.findOne({ driverId, active: true }).sort({ createdAt: -1 }).lean()) as Plain | null;
}

/** What the driver has to send next on the trip, if anything. */
function nextUpload(trip: Plain, consignments: Plain[], docs: Plain[]): 'loading' | 'delivery' | undefined {
  if (!trip.dispatchedAt) return undefined;
  const stops = trip.stops as Plain[];
  const waiting = (kind: string) => docs.some((d) => d.kind === kind && d.status === 'new');
  const load = stops.find((s) => s.kind === 'load');
  const offload = stops.find((s) => s.kind === 'offload');
  const loaded = consignments.filter((c) => isLoaded(c as never));
  if (!loaded.length) return load?.arrivedAt && !waiting('loading') ? 'loading' : undefined;
  if (consignments.some((c) => !isFinished(c as never))) return offload?.arrivedAt && !waiting('delivery') ? 'delivery' : undefined;
  return undefined;
}

/* ---------- Which consignment each paper is for (#135 Part 2) ---------- */

type PaperType = GateDocType & { code?: string; requiredBy?: string };
/** The papers a driver is always asked for: the loading invoice at a pickup, the delivery note and POD at a drop. */
const USUAL = new Set(['LOADING_INVOICE', 'DELIVERY_NOTE', 'POD']);
/** The papers a driver sends at a pickup or a drop: the ones a stop waits for, and the usual invoice, delivery note and POD. */
export async function paperTypes(): Promise<PaperType[]> {
  return (await ConsignmentDocumentType.find({ status: 'active', step: { $in: ['pickup', 'drop'] } }).select('name step driverKind code requiredBy').lean()) as unknown as PaperType[];
}
const asked = (t: PaperType) => (t.requiredBy !== undefined && t.requiredBy !== 'none') || USUAL.has(String(t.code));

/** For one pickup or drop, the papers still to send: not recorded, and no photo of it waiting at the office. */
function papersDue(c: Plain, leg: Plain, types: PaperType[], waiting: Plain[]) {
  if (leg.status !== 'planned') return [];
  const step = leg.kind === 'pickup' ? 'pickup' : 'drop';
  return types.filter((t) => t.step === step && asked(t)
    && !hasDocument(c as unknown as ConsignmentP, leg as unknown as LegP, t)
    && !waiting.some((d) => String(d.consignmentId) === String(c._id) && String(d.legId ?? '') === String(leg._id) && String(d.documentTypeId ?? '') === String(t._id)))
    .map((t) => ({ documentTypeId: String(t._id), label: String(t.name), kind: String(t.driverKind ?? 'other') }));
}

/** The stop the truck is at (arrived, not left), else the next one it is going to. */
export const currentStop = (stops: Plain[]) => stops.find((s) => s.arrivedAt && !s.leftAt && s.kind !== 'start') ?? stops.find((s) => !s.arrivedAt && s.kind !== 'start');

/** The consignments at each stop, as the driver sees them: who, what, how much, and the papers due. Never a rate. */
export async function legsByStopFor(trip: Plain, consignments: Plain[], docs: Plain[]) {
  const types = await paperTypes();
  const waiting = docs.filter((d) => d.status === 'new' && d.consignmentId);
  const products = new Map((await Product.find({ _id: { $in: consignments.flatMap((c) => ((c.lines ?? []) as Plain[]).map((l) => l.productId)) } }).select('name unit').lean()).map((p) => [String(p._id), p as Plain]));
  const out = new Map<string, Plain[]>();
  for (const c of consignments) {
    if (c.status === 'cancelled') continue;
    const first = ((c.lines ?? []) as Plain[])[0];
    const product = first ? products.get(String(first.productId)) : undefined;
    for (const leg of (c.legs ?? []) as Plain[]) {
      if (!leg.stopId || leg.status === 'skipped') continue;
      const contact = (leg.contact ?? (leg.kind === 'pickup' ? c.consignor : c.consignee)) as Plain | undefined;
      const partyId = leg.kind === 'pickup' ? c.consignorPartyId ?? c.customerId : c.consigneePartyId;
      const planned = ((leg.planned ?? []) as Plain[]).reduce((s, p) => s + Number(p.qty ?? 0), 0) || (leg.kind === 'pickup' ? Number(first?.plannedQty ?? 0) : 0);
      const list = out.get(String(leg.stopId)) ?? [];
      list.push({
        consignmentId: String(c._id), legId: String(leg._id), number: c.number, kind: leg.kind,
        party: contact?.name ?? (partyId ? await partyName(partyId) : undefined), phone: contact?.phone, whatsapp: contact?.whatsapp,
        product: product?.name, plannedQty: planned || undefined, unit: first?.unit ?? product?.unit, status: leg.status,
        send: papersDue(c, leg, types, waiting).map(({ documentTypeId, label }) => ({ documentTypeId, label })),
      });
      out.set(String(leg.stopId), list);
    }
  }
  return out;
}

/** The papers due at the stop the truck is at, one per consignment and paper: what "Send …" offers first. */
export function dueNow(stops: Plain[], legs: Map<string, Plain[]>) {
  const stop = currentStop(stops);
  if (!stop?.arrivedAt) return [];
  return (legs.get(String(stop._id)) ?? []).flatMap((l) => ((l.send ?? []) as Plain[]).map((p) => ({
    consignmentId: l.consignmentId, legId: l.legId, documentTypeId: p.documentTypeId, stopId: String(stop._id), label: `${String(p.label)} for ${String(l.number)}`,
  })));
}

/**
 * Which consignment a photo is for, when the driver didn't say: the only one at the stop still needing that kind of
 * paper is chosen for them; with several, the photo is filed on the trip and the answer lists them to pick from.
 */
async function targetFor(trip: Plain, kind: string, input: S.DriverSendInput) {
  const consignments = await Consignment.find({ tripId: trip._id, status: { $ne: 'cancelled' } }).lean() as Plain[];
  if (input.consignmentId) {
    const c = consignments.find((x) => String(x._id) === input.consignmentId);
    if (!c) throw refuse('That consignment is not on your trip.');
    if (input.legId && !((c.legs ?? []) as Plain[]).some((l) => String(l._id) === input.legId)) throw refuse('That pickup or drop is not on the consignment.');
    return { target: { consignmentId: input.consignmentId, legId: input.legId, documentTypeId: input.documentTypeId } };
  }
  if (!['loading', 'delivery', 'pod', 'weighbridge'].includes(kind)) return {};
  const docs = await DriverDocument.find({ tripId: trip._id }).lean() as Plain[];
  const legs = await legsByStopFor(trip, consignments, docs);
  const stop = currentStop(trip.stops as Plain[]);
  const step = kind === 'loading' || kind === 'weighbridge' ? 'pickup' : 'drop';
  const open = (stop ? legs.get(String(stop._id)) ?? [] : []).filter((l) => l.kind === step && ((l.send ?? []) as Plain[]).length);
  if (open.length === 1) {
    const only = open[0]!;
    const paper = ((only.send ?? []) as Plain[]).find((p) => kind === 'loading' || kind === 'pod' || kind === 'delivery') as Plain | undefined;
    return { target: { consignmentId: String(only.consignmentId), legId: String(only.legId), documentTypeId: paper ? String(paper.documentTypeId) : undefined } };
  }
  return open.length > 1 ? { pick: open.map((l) => ({ consignmentId: l.consignmentId, legId: l.legId, number: l.number, party: l.party, product: l.product, qty: l.plannedQty })) } : {};
}

export async function home(actor: DriverActor) {
  const driver = await Driver.findById(actor.driverId).select('name code phone whatsapp status').lean();
  if (!driver || driver.status !== 'active') throw new ForbiddenError('Your driver record is not active. Contact the office.');
  const base = await baseCurrency();
  const trip = await ownTrip(actor.driverId);
  let current: Plain | null = null;
  if (trip) {
    const [consignments, docs, requests, product, stops] = await Promise.all([
      Consignment.find({ tripId: trip._id }).lean(),
      DriverDocument.find({ tripId: trip._id }).select('-file.dataUrl').sort({ at: -1 }).lean(),
      FundRequest.find({ tripId: trip._id, status: 'issued' }).lean(),
      trip.productId ? Product.findById(trip.productId).select('name').lean() : null,
      Promise.all((trip.stops as Plain[]).map(async (s) => ({
        id: String(s._id), kind: s.kind, place: await placeName(s.placeId), legKm: s.legKm,
        arrivedAt: iso(s.arrivedAt), arrivedVia: s.arrivedVia, leftAt: iso(s.leftAt),
      }))),
    ]);
    // Each stop's consignments, the papers due where the truck is, and what holds it there (#135 Part 2).
    const byStop = await legsByStopFor(trip, consignments as Plain[], docs as Plain[]);
    for (const s of stops) (s as Plain).legs = byStop.get(s.id) ?? [];
    const due = dueNow(trip.stops as Plain[], byStop);
    const gate = trip.dispatchedAt ? await tripGate(trip).catch(() => null) : null;
    const issued = await Promise.all(requests.map(async (r) => ({
      id: String(r._id), number: r.number, kind: r.kind,
      text: r.kind === 'fuel' ? `${Fmt.number(Number(r.litres ?? 0), { max: 2 })} L` : r.amount ? formatMoney(r.amount.amountMinor, await currencyInfo(r.amount.currencyId)) : '',
      at: iso(r.issuedAt),
    })));
    current = {
      id: String(trip._id), number: trip.number,
      truck: await plateOf(trip.vehicleId), trailer: await trailerPlate(trip.trailerId),
      customer: await partyName(trip.customerId), product: product?.name ?? '',
      dispatchedAt: iso(trip.dispatchedAt), stops,
      // The papers due now, named by consignment; a trip with no consignment on its stops yet keeps the older single kind.
      next: consignments.some((c) => ((c.legs ?? []) as Plain[]).some((l) => l.stopId)) ? due : nextUpload(trip, consignments, docs),
      gate: gate ? { stopId: gate.stopId, driverReason: gate.driverReason } : null,
      loaded: consignments.some((c) => isLoaded(c as never)), delivered: consignments.some((c) => isLoaded(c as never)) && consignments.every((c) => isFinished(c as never) || !isLoaded(c as never)),
      issued,
      documents: docs.map((d) => ({
        id: String(d._id), kind: d.kind, status: d.status, at: iso(d.at), note: d.note, returnReason: d.returnReason,
        simulated: Boolean(d.simulated), file: d.file ? { fileId: d.file.fileId ? String(d.file.fileId) : undefined, name: d.file.name, mime: d.file.mime, sampleId: d.file.sampleId } : undefined,
      })),
    };
  }
  const entries = await driverLedger(actor.driverId);
  const balanceMinor = entries.reduce((sum, e) => sum + e.amountMinor, 0);
  const [settlements, categories, terms] = await Promise.all([
    Settlement.find({ driverId: actor.driverId }).sort({ postedAt: -1, _id: -1 }).limit(10).lean(),
    ExpenseCategory.find({ status: 'active' }).select('name').sort({ name: 1 }).lean(),
    words(),
  ]);
  return {
    driver: { id: String(driver._id), name: driver.name, code: driver.code },
    trip: current,
    account: {
      currency: base,
      balanceMinor,
      balance: formatMoney(Math.abs(balanceMinor), base),
      /** Positive: the driver holds company money. Negative: the company owes the driver. */
      direction: balanceMinor > 0 ? 'holds' : balanceMinor < 0 ? 'owed' : 'even',
      entries: entries.slice(-30).reverse().map((e) => ({ ...e, text: formatMoney(Math.abs(e.amountMinor), base) })),
      settlements: settlements.map((s) => ({ id: String(s._id), number: s.number, at: iso(s.postedAt ?? s.createdAt) })),
    },
    expenseCategories: categories.map((c) => ({ id: String(c._id), name: c.name })),
    /** What the company asks the driver about this trip and its load (#67). */
    questions: trip ? await driverQuestions(trip, await Consignment.find({ tripId: trip._id }).lean() as Plain[]) : [],
    /** The company's words (#73), so the phone says "load" where the company does. */
    words: terms,
    /** Maintenance is on, so a defect can be reported from the phone (#63). */
    canReportDefect: await isAreaOn('maintenance'),
  };
}

export async function messages(actor: DriverActor, since?: string) {
  const filter: Plain = { thread: driverThread(actor.driverId) };
  if (since) filter.at = { $gt: new Date(since) };
  const rows = await Message.find(filter).sort({ at: -1 }).limit(100).lean();
  return rows.reverse().map((m) => ({
    id: String(m._id), at: iso(m.at), from: m.from, title: m.title, text: m.text, rows: m.rows, resolved: m.resolved,
    attachment: m.attachment,
    // Buttons in the driver's thread ask for a document; the app turns them into an upload.
    upload: m.resolved ? undefined : (m.buttons as Plain[] | undefined)?.find((b) => b.attach)?.attach,
  }));
}

/** A photo, a PDF or a message from the driver, filed on the open trip, or the last one not yet settled (#92). */
export async function send(actor: DriverActor, input: S.DriverSendInput) {
  const trip = await driverTripNow(actor.driverId);
  const { target, pick } = trip ? await targetFor(trip as Plain, input.kind, input) : {};
  const doc = await sendDocument({
    driverId: actor.driverId, tripId: trip ? String(trip._id) : undefined, kind: input.kind, note: input.note,
    file: input.fileId ? { fileId: input.fileId } : undefined, reading: input.reading, channel: 'app',
    ...(target?.consignmentId ? { consignmentId: target.consignmentId } : {}), ...(target?.legId ? { legId: target.legId } : {}), ...(target?.documentTypeId ? { documentTypeId: target.documentTypeId } : {}),
  }, driverContext(actor));
  // Several consignments at the stop and none named: filed on the trip, and the driver is asked which (contract 8).
  return pick ? { ...(doc as Plain), pick } : doc;
}

/** The driver answers what the company asks of them about their trip and load (#67). */
export async function answerFields(actor: DriverActor, input: S.DriverFieldsInput) {
  const plain = await ownTrip(actor.driverId);
  if (!plain) throw new NotFoundError('You have no trip on the road');
  const trip = await Trip.findById(plain._id);
  const consignment = await Consignment.findOne({ tripId: plain._id, status: { $in: ['loading', 'loaded', 'in_transit', 'delivering'] } }).sort({ bookedAt: 1 });
  await driverAnswers(trip!, consignment, input.values);
  await save(trip!);
  if (consignment) await save(consignment);
  const ctx = driverContext(actor);
  await log(ctx, new Date(), `${ctx.name} answered ${Object.keys(input.values).join(', ')}`, { tripId: plain._id });
  return { ok: true };
}

/** The driver reports something wrong with their truck: it becomes a work order. */
export const reportDefect = (actor: DriverActor, input: DefectInput) => openDefect(actor.driverId, input, driverContext(actor));

/** The driver says they have reached a stop on their own trip. */
export async function arrive(actor: DriverActor, stopId: string) {
  const trip = await ownTrip(actor.driverId);
  if (!trip) throw new NotFoundError('You have no trip on the road');
  return arriveAtStop(String(trip._id), stopId, driverContext(actor));
}

/** One of the driver's own settlement statements, the PDF the office prints. Someone else's is not found. */
export async function statementPdf(actor: DriverActor, settlementId: string) {
  if (!(await Settlement.exists({ _id: settlementId, driverId: actor.driverId }))) throw new NotFoundError('Settlement not found');
  return settlementStatementPdf(settlementId);
}
