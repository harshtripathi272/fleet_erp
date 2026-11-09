import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { PaymentMethod } from '../finance/models/paymentMethod.model.js';
import { approveAs, highestEligible, notifyLevel, routeApproval, waitingOn, type Approval } from './approvals.js';
import { FundRequest, OPEN_REQUEST } from './models/funding.model.js';
import { customValues, stepCustom } from './placements.js';
import { Trip } from './models/trip.model.js';
import { announce, moneyValues } from './notices.js';
import { assertStageAllows, fireEvent } from './stages.js';
import {
  activeRecord, baseCurrency, conflict, currencyInfo, driverThread, formatMoney, litres, loadOr404, log, need, nextNumber,
  post, present, queue, refuse, resolve, save, toBase, type MessageButton, type OpsContext, type Via,
} from './support.js';
import { activeTrip, driverName, fuelInTank, fundingFor, plateOf, routeLabel, setVehicleState, truckFacts } from './trips.service.js';
import type * as S from './operations.schema.js';

/* ---------- Message parts ---------- */

/** {{amount}} and {{currency}} for a request: money for an advance; for fuel the litres, with no currency. */
async function requestValues(request: Plain): Promise<Record<string, string>> {
  if (request.kind === 'fuel') return { amount: litres(Number(request.litres)), currency: '' };
  return moneyValues(request.amount as { amountMinor: number; currencyId: unknown });
}

const requestNotice = (request: Plain, money: Record<string, string>, extra: Record<string, string | undefined>) => ({
  variables: { ...money, ...extra, ...customValues('request', request.custom) },
  ref: { kind: 'fund-requests', id: request._id },
});

export async function requestAmount(request: Plain) {
  if (request.kind === 'fuel') return litres(Number(request.litres));
  const amount = request.amount as { amountMinor: number; currencyId: unknown };
  return formatMoney(amount.amountMinor, await currencyInfo(amount.currencyId));
}

export function requestButtons(request: Plain): MessageButton[] {
  const id = String(request._id ?? request.id);
  return [
    { label: 'Approve', tone: 'primary', action: { type: 'request.decide', id, approve: true, via: 'whatsapp' } },
    { label: 'Reject', tone: 'danger', action: { type: 'request.decide', id, approve: false, via: 'whatsapp' } },
    { label: 'Open trip', nav: { tripId: String(request.tripId), view: 'funding' } },
  ];
}

const FUEL_KINDS = ['fuel_card', 'fuel_voucher', 'own_depot'];
const usableFor = (method: Plain, kind: 'fuel' | 'cash') => (kind === 'fuel' ? Boolean(method.forFuel) || FUEL_KINDS.includes(String(method.kind)) : method.forCash !== false && !FUEL_KINDS.includes(String(method.kind)));

/** One button per payment method that suits the request, with a reference the payer can keep or change. */
export async function issueButtons(request: Plain): Promise<MessageButton[]> {
  const kind = request.kind as 'fuel' | 'cash';
  const methods = (await PaymentMethod.find({ status: 'active' }).sort({ code: 1 }).lean()).filter((m) => usableFor(m as Plain, kind)).slice(0, 3);
  const suffix = `${String(request.number).slice(-4)}${kind === 'fuel' ? 'F' : 'C'}`;
  return methods.map((m, index) => ({
    label: String(m.name),
    tone: index === 0 ? 'primary' : undefined,
    action: { type: 'request.issue', id: String(request._id ?? request.id), paymentMethodId: String(m._id), reference: `${m.code}-${suffix}`, via: 'whatsapp' },
  }));
}

async function requestRows(trip: Plain, amount: string, extra: Array<[string, string]> = []): Promise<Array<[string, string]>> {
  return [
    ['Trip', `${trip.number} · ${await routeLabel(trip as never)}`],
    ['Truck', `${await plateOf(trip.vehicleId)} · ${(await driverName(trip.driverId)) || 'No driver'}`],
    ['Amount', amount],
    ...extra,
  ];
}

const trailEntry = (ctx: OpsContext, what: string, at: Date, via: Via = 'app', note?: string) => ({ desk: ctx.desk, userId: ctx.actorId, name: ctx.name, what, at, note, via });

/** Asks the level now waiting to decide, with what it needs to see. `why` says how it got here, when that isn't the usual way. */
export async function askLevel(request: Plain, trip: Plain, ctx: OpsContext, at: Date, why?: string) {
  const approval = request.approval as Approval;
  const level = waitingOn(approval)!;
  const amount = await requestAmount(request);
  const base = await baseCurrency();
  const extra: Array<[string, string]> = [];
  if (approval.levels.length > 1) extra.push(['Approval', `Level ${approval.current + 1} of ${approval.levels.length}`]);
  extra.push(['Suggested', request.kind === 'fuel' ? litres(Number(request.suggested)) : formatMoney(Number(request.suggested), base)]);
  if (request.reason) extra.push(['Reason', String(request.reason)]);
  await notifyLevel(level, at, {
    title: `${request.kind === 'fuel' ? 'Fuel' : 'Advance'} request ${request.number}`,
    text: [why, request.overBudget ? 'Above the trip budget.' : 'Within the trip budget.'].filter(Boolean).join(' '),
    rows: await requestRows(trip, amount, extra),
    buttons: requestButtons(request),
    refId: String(request._id),
  }, ctx, 'fund-requests');
}

/* ---------- Reading ---------- */

export async function listRequests(query: S.RequestListQuery) {
  const filter: Plain = {};
  if (query.tripId) filter.tripId = query.tripId;
  if (query.status) filter.status = query.status;
  if (query.kind) filter.kind = query.kind;
  const [rows, total] = await Promise.all([
    FundRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    FundRequest.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: query.page, limit: query.limit };
}

export async function getRequest(id: string) {
  const request = await FundRequest.findById(id).lean();
  if (!request) throw new NotFoundError('Request not found');
  return present(request);
}

/* ---------- Request ---------- */

/**
 * Operations asks for fuel or cash for a trip. The company's approval policy for fuel requests or cash
 * advances decides who approves, level by level; above the trip's suggestion a reason may be required
 * and every level may have to approve.
 */
export async function createRequest(input: S.CreateRequestInput, ctx: OpsContext) {
  need(ctx, 'fund-requests', 'create');
  const at = new Date();
  const trip = (await Trip.findById(input.tripId).lean()) as Plain | null;
  if (!trip) throw new NotFoundError('Trip not found');
  if (!activeTrip(trip)) throw conflict('This trip is closed.');
  if (!trip.driverId) throw refuse('Assign the driver first.');
  if (!(trip.stops as unknown[]).length) throw refuse('Set the route first.');
  assertStageAllows(trip, 'funding_requested');
  const f = await fundingFor(trip);
  let suggested: number, over: boolean;
  if (input.kind === 'fuel') {
    if (!input.litres) throw refuse('Enter the litres.');
    if (f.fuel.room !== null && input.litres > f.fuel.room) throw refuse(`${await plateOf(trip.vehicleId)} can take ${litres(f.fuel.room)} more.`);
    suggested = f.fuel.suggested;
    // With no budget set there's nothing to be above, so a new company isn't asked to explain every request.
    over = f.fuel.budget > 0 && input.litres > suggested * 1.001;
  } else {
    if (!input.amount?.amountMinor) throw refuse('Enter an amount.');
    await currencyInfo(input.amount.currencyId);
    suggested = f.cash.suggestedMinor;
    over = f.cash.budgetMinor > 0 && (await toBase(input.amount.amountMinor, input.amount.currencyId)).baseMinor > suggested * 1.001;
  }
  const approval = await routeApproval(input.kind === 'fuel' ? 'fuel_request' : 'cash_advance', input.kind === 'fuel' ? { litres: input.litres! } : input.amount!, over);
  if (over && approval.requireReasonAboveBudget && !input.reason) throw refuse("Say why it's above the budget.");
  const request = new FundRequest({
    number: await nextNumber('fund-requests', input.kind === 'fuel' ? 'FUEL' : 'ADV', at),
    tripId: trip._id, kind: input.kind, ...(input.kind === 'fuel' ? { litres: input.litres } : { amount: input.amount }),
    suggested, overBudget: over, reason: input.reason, status: 'pending', approval, custom: await stepCustom('fund-requests', 'ask', input.custom),
    trail: [trailEntry(ctx, 'requested', at, 'app', input.reason)], createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  await save(request);
  const plain = request.toObject() as Plain;
  await askLevel(plain, trip, ctx, at);
  await fireEvent(trip._id, 'funding_requested', at, ctx.actorId);
  await log(ctx, at, `Requested ${await requestAmount(plain)} ${input.kind === 'fuel' ? 'fuel' : 'advance'} (${plain.number})`, { tripId: trip._id });
  await announce('fund_request.created', trip, ctx, requestNotice(plain, await requestValues(plain), { reason: input.reason }));
  return present(plain);
}

/* ---------- Decide ---------- */

/** The waiting level (or anyone senior to it in the policy) approves or rejects. */
export async function decideRequest(id: string, input: S.DecideInput, ctx: OpsContext) {
  const at = new Date();
  const via: Via = input.via ?? 'app';
  const request = await loadOr404(FundRequest, id, 'Request');
  if (request.get('status') !== 'pending') throw conflict(`${request.get('number')} is already ${request.get('status') === 'issued' ? 'paid' : request.get('status')}.`);
  const approval = request.get('approval') ? (request.toObject().approval as Approval) : await routeApproval(request.get('kind') === 'fuel' ? 'fuel_request' : 'cash_advance', request.get('kind') === 'fuel' ? { litres: Number(request.get('litres')) } : { amountMinor: request.get('amount').amountMinor, currencyId: String(request.get('amount').currencyId) }, Boolean(request.get('overBudget')));
  const upTo = highestEligible(ctx, approval);
  if (upTo < 0) throw new ForbiddenError(`Waiting for ${waitingOn(approval)?.label ?? 'the approver'} to decide ${request.get('number')}.`);
  const trip = (await Trip.findById(request.get('tripId')).lean()) as Plain;
  const plain = request.toObject() as Plain;
  const amount = await requestAmount(plain);
  if (!input.approve) {
    if (!input.note) throw refuse('Give a reason for rejecting.');
    request.set({ status: 'rejected', updatedBy: ctx.actorId });
    request.get('trail').push(trailEntry(ctx, 'rejected', at, via, input.note));
    await save(request);
    await resolve(id, `Rejected by ${ctx.name}`);
    await post(queue('fund-requests'), at, {
      title: `${plain.number} rejected`, text: `${ctx.name}: ${input.note}`,
      rows: [['Trip', String(trip.number)], ['Amount', amount]],
      buttons: [{ label: 'Open trip', nav: { tripId: String(trip._id), view: 'funding' } }],
    }, ctx);
    await log(ctx, at, `Rejected ${plain.number}: ${input.note}`, { tripId: trip._id });
    await announce('fund_request.rejected', trip, ctx, requestNotice(plain, await requestValues(plain), { reason: input.note }));
    return present(request.toObject());
  }
  request.set('custom', await stepCustom('fund-requests', 'approve', input.custom, plain.custom as Plain | undefined));
  const levels = approval.levels.length;
  const from = approval.current;
  approveAs(ctx, approval, upTo, at);
  request.set({ approval, updatedBy: ctx.actorId });
  const done = approval.current >= levels;
  if (done) request.set('status', 'approved');
  request.get('trail').push(trailEntry(ctx, done ? 'approved' : 'sent to owner', at, via, [levels > 1 ? `Level ${from + 1}${upTo > from ? `–${upTo + 1}` : ''} of ${levels}` : '', input.note].filter(Boolean).join(' · ') || undefined));
  await save(request);
  await resolve(id, done ? `Approved by ${ctx.name}` : `Approved by ${ctx.name} · next: ${waitingOn(approval)!.label}`);
  if (!done) {
    await askLevel(request.toObject() as Plain, trip, ctx, at);
    await log(ctx, at, `Approved ${plain.number}; now with ${waitingOn(approval)!.label}`, { tripId: trip._id });
    return present(request.toObject());
  }
  await post(queue('payments'), at, {
    title: `Pay ${plain.number}`,
    text: plain.kind === 'fuel' ? `Issue ${amount} to ${await plateOf(trip.vehicleId)}. How?` : `Pay ${amount} to ${await driverName(trip.driverId)}. How?`,
    buttons: await issueButtons(plain),
    refId: `${id}-issue`,
  }, ctx);
  await log(ctx, at, `Approved ${plain.number}`, { tripId: trip._id });
  await announce('fund_request.approved', trip, ctx, requestNotice(plain, await requestValues(plain), { reason: input.note }));
  return present(request.toObject());
}

/* ---------- Pay out ---------- */

export async function issueRequest(id: string, input: S.IssueInput, ctx: OpsContext) {
  need(ctx, 'payments', 'create', 'Your role does not pay out requests.');
  const at = new Date();
  const request = await loadOr404(FundRequest, id, 'Request');
  if (request.get('status') !== 'approved') throw conflict(`${request.get('number')} isn't approved yet.`);
  const kind = request.get('kind') as 'fuel' | 'cash';
  let medium = input.medium;
  if (input.paymentMethodId) {
    const method = await activeRecord(PaymentMethod, input.paymentMethodId, 'payment method');
    if (!usableFor(method, kind)) throw refuse(`${method.name} is not used for ${kind === 'fuel' ? 'fuel' : 'cash'}.`);
    if (kind === 'cash' && (method.currencyIds as unknown[] | undefined)?.length && !(method.currencyIds as unknown[]).map(String).includes(String(request.get('amount').currencyId))) {
      throw refuse(`${method.name} does not pay in this currency.`);
    }
    if (method.referenceRequired !== false && !input.reference) throw refuse(`Add the ${method.name} reference.`);
    medium = String(method.name);
  }
  if (!medium) throw refuse('Choose how it was paid.');
  if (!input.reference && !input.paymentMethodId) throw refuse('Add how it was paid and the reference.');
  const trip = (await Trip.findById(request.get('tripId')).lean()) as Plain;
  const truck = await truckFacts(trip.vehicleId, false);
  if (kind === 'fuel') {
    const litresIssued = Number(request.get('litres'));
    if (truck.tankL && fuelInTank(trip, truck) + litresIssued > truck.tankL) throw refuse(`The tank holds ${litres(truck.tankL)}.`);
  } else {
    const amount = request.get('amount');
    const { baseMinor, rate } = await toBase(amount.amountMinor, amount.currencyId, at);
    request.set({ baseAmountMinor: baseMinor, rate });
  }
  request.set('custom', await stepCustom('fund-requests', 'pay', input.custom, (request.toObject() as Plain).custom as Plain | undefined));
  request.set({ status: 'issued', paymentMethodId: input.paymentMethodId, medium, reference: input.reference, station: input.station, issuedAt: at, updatedBy: ctx.actorId, ...(kind === 'fuel' && input.unitPrice ? { unitPrice: input.unitPrice } : {}) });
  request.get('trail').push(trailEntry(ctx, 'issued', at, input.via ?? 'app', [medium, input.reference].filter(Boolean).join(' ')));
  await save(request);
  if (kind === 'fuel') await setVehicleState(trip.vehicleId, { fuelL: truck.fuelL + Number(request.get('litres')) }, ctx.actorId);
  await resolve(`${id}-issue`, `Paid · ${medium}`);
  const plain = request.toObject() as Plain;
  const amount = await requestAmount(plain);
  if (trip.driverId) {
    await post(driverThread(trip.driverId), at, {
      title: kind === 'fuel' ? 'Fuel issued' : 'Advance paid',
      text: kind === 'fuel' ? `${amount} for ${truck.plate} by ${medium.toLowerCase()}${input.station ? ` at ${input.station}` : ''}.` : `${amount} by ${medium}. Keep receipts for what you spend.`,
      rows: [['Reference', input.reference ?? '—'], ['Trip', String(trip.number)]],
      wa: { template: 'money_issued', values: [String(trip.number), kind === 'fuel' ? 'fuel issued' : 'advance paid', kind === 'fuel' ? `${amount} for ${truck.plate} by ${medium.toLowerCase()}${input.station ? ` at ${input.station}` : ''}` : `${amount} by ${medium}`, input.reference ?? 'none'] },
    }, ctx);
  }
  const stillOpen = await FundRequest.exists({ tripId: trip._id, status: { $in: OPEN_REQUEST } });
  if (!stillOpen) {
    await fireEvent(trip._id, 'funded', at, ctx.actorId);
    if (!trip.dispatchedAt) {
      await post(queue('trips'), at, {
        title: `${trip.number} is funded`,
        text: `${amount} ${kind === 'fuel' ? 'issued' : 'paid'}. The truck can leave.`,
        buttons: [{ label: 'Dispatch', tone: 'primary', action: { type: 'trip.dispatch', tripId: String(trip._id) } }, { label: 'Open trip', nav: { tripId: String(trip._id) } }],
        refId: `${trip._id}-dispatch`,
      }, ctx);
    }
  }
  await log(ctx, at, `${kind === 'fuel' ? 'Issued' : 'Paid'} ${amount} · ${[medium, input.reference].filter(Boolean).join(' ')}`, { tripId: trip._id });
  await announce('fund_request.paid', trip, ctx, requestNotice(plain, await requestValues(plain), { 'document.number': input.reference }));
  return present(plain);
}

export async function cancelRequest(id: string, ctx: OpsContext) {
  need(ctx, 'fund-requests', 'update');
  const at = new Date();
  const request = await loadOr404(FundRequest, id, 'Request');
  if (!OPEN_REQUEST.includes(request.get('status'))) throw conflict('Only unpaid requests can be cancelled.');
  request.set({ status: 'cancelled', updatedBy: ctx.actorId });
  request.get('trail').push(trailEntry(ctx, 'cancelled', at));
  await save(request);
  await resolve(id, `Cancelled by ${ctx.name}`);
  await resolve(`${id}-issue`, `Cancelled by ${ctx.name}`);
  await log(ctx, at, `Cancelled ${request.get('number')}`, { tripId: request.get('tripId') });
  return present(request.toObject());
}
