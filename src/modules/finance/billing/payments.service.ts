import { NotFoundError } from '../../../core/errors/index.js';
import type { Plain } from '../../../core/masters/types.js';
import { notify } from '../../messaging/dispatcher.js';
import {
  activeRecord, baseCurrency, conflict, customerParty, formatMoney, log, need, nextNumber, present, refuse, type OpsContext,
} from '../../operations/support.js';
import { partyName } from '../../operations/trips.service.js';
import { applyRate } from '../finance.service.js';
import { PaymentMethod } from '../models/paymentMethod.model.js';
import { CustomerPayment, ExchangeDifference, Invoice } from './billing.model.js';
import type * as S from './billing.schema.js';
import { setPaymentState } from './invoices.service.js';
import { currencyUnits, rateOrRefuse } from './pricing.js';

/**
 * Payments received from customers (#61): in any currency, part or whole, set against one or more invoices.
 * Each part settles an amount of the invoice in its own currency. In the base currency it was booked at the
 * invoice's rate and is received at the payment's rate; the difference is the realised exchange gain (positive)
 * or loss (negative), recorded on the payment and as an exchange difference for the accounts.
 *
 * A USD 1,000.00 invoice booked at 20.00 is ZMW 20,000.00. USD 600.00 received at 21.00 is ZMW 12,600.00 for
 * ZMW 12,000.00 booked: a gain of ZMW 600.00. The last USD 400.00 at 19.50 is ZMW 7,800.00 for the ZMW 8,000.00
 * still booked: a loss of ZMW 200.00.
 */

interface Planned {
  invoice: Plain;
  amountMinor: number;
  settledMinor: number;
  bookedBaseMinor: number;
  receivedBaseMinor: number;
}

export async function receivePayment(input: S.ReceivePaymentInput, ctx: OpsContext) {
  need(ctx, 'payments-received', 'create');
  await customerParty(input.customerId);
  if (input.paymentMethodId) await activeRecord(PaymentMethod, input.paymentMethodId, 'payment method');
  const base = await baseCurrency();
  const paid = await currencyUnits(input.amount.currencyId);
  const rateToBase = paid.id === base.id ? 1 : await rateOrRefuse(paid.id, base.id, input.date);
  const baseAmountMinor = applyRate(input.amount.amountMinor, rateToBase, paid.minorUnits, base.minorUnits);

  // The invoices it is set against: those named, or the oldest still owed.
  const named = input.allocations?.map((a) => a.invoiceId);
  const invoices = await Invoice.find({
    customerId: input.customerId, kind: 'invoice', status: 'approved',
    ...(named ? { _id: { $in: named } } : { openMinor: { $gt: 0 } }),
  }).sort({ date: 1, _id: 1 }).lean() as Plain[];
  if (named && invoices.length !== new Set(named).size) throw refuse('One of the invoices is not an approved invoice of this customer.');

  const plan: Planned[] = [];
  let left = input.amount.amountMinor;
  const wanted = named ? input.allocations!.map((a) => ({ invoice: invoices.find((i) => String(i._id) === a.invoiceId)!, amountMinor: a.amountMinor })) : invoices.map((invoice) => ({ invoice, amountMinor: undefined as number | undefined }));
  for (const w of wanted) {
    if (left <= 0) break;
    const inv = w.invoice;
    const open = Number(inv.openMinor);
    if (open <= 0) throw refuse(`${inv.number} is already paid.`);
    const own = await currencyUnits(inv.currencyId);
    // payment currency → invoice currency on the payment's date
    const toInvoice = own.id === paid.id ? 1 : await rateOrRefuse(paid.id, own.id, input.date);
    const openInPaid = own.id === paid.id ? open : applyRate(open, 1 / toInvoice, own.minorUnits, paid.minorUnits);
    let amountMinor = w.amountMinor ?? Math.min(left, openInPaid);
    if (amountMinor > left) throw refuse(`The amounts set against invoices add up to more than was received (${formatMoney(input.amount.amountMinor, paid)}).`);
    let settledMinor = own.id === paid.id ? amountMinor : applyRate(amountMinor, toInvoice, paid.minorUnits, own.minorUnits);
    // A minor unit of rounding either way still settles the invoice.
    if (settledMinor > open + 1) throw refuse(`That is more than is owed on ${inv.number} (${formatMoney(open, own)}).`);
    if (settledMinor >= open - 1 && amountMinor >= openInPaid - 1) settledMinor = open;
    if (settledMinor > open) settledMinor = open;
    if (settledMinor <= 0) continue;
    amountMinor = Math.min(amountMinor, left);
    const bookedBaseMinor = settledMinor === open ? Number(inv.baseOpenMinor) : applyRate(settledMinor, Number(inv.rateToBase), own.minorUnits, base.minorUnits);
    const receivedBaseMinor = applyRate(amountMinor, rateToBase, paid.minorUnits, base.minorUnits);
    plan.push({ invoice: inv, amountMinor, settledMinor, bookedBaseMinor, receivedBaseMinor });
    left -= amountMinor;
  }

  // Take each part off its invoice; if one was paid meanwhile, put back what was taken and refuse.
  const done: Planned[] = [];
  for (const p of plan) {
    const res = await Invoice.updateOne(
      { _id: p.invoice._id, status: 'approved', openMinor: { $gte: p.settledMinor } },
      { $inc: { openMinor: -p.settledMinor, baseOpenMinor: -p.bookedBaseMinor, paidMinor: p.settledMinor }, $set: { updatedBy: ctx.actorId } },
    );
    if (!res.modifiedCount) {
      for (const d of done) await Invoice.updateOne({ _id: d.invoice._id }, { $inc: { openMinor: d.settledMinor, baseOpenMinor: d.bookedBaseMinor, paidMinor: -d.settledMinor } });
      throw conflict(`${p.invoice.number} was paid or credited meanwhile. Reload and try again.`);
    }
    done.push(p);
  }
  for (const p of plan) await setPaymentState(p.invoice._id);

  const payment = await CustomerPayment.create({
    number: await nextNumber('payments-received', 'RCT', input.date), customerId: input.customerId, date: input.date,
    amount: input.amount, rateToBase, baseAmountMinor, paymentMethodId: input.paymentMethodId, reference: input.reference, note: input.note,
    allocations: plan.map((p) => ({
      invoiceId: p.invoice._id, invoiceNumber: p.invoice.number, amountMinor: p.amountMinor, settledMinor: p.settledMinor,
      bookedBaseMinor: p.bookedBaseMinor, receivedBaseMinor: p.receivedBaseMinor, gainLossBaseMinor: p.receivedBaseMinor - p.bookedBaseMinor,
    })),
    unallocatedMinor: left, createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  const differences = plan.filter((p) => p.receivedBaseMinor !== p.bookedBaseMinor);
  if (differences.length) {
    await ExchangeDifference.insertMany(differences.map((p) => ({
      kind: 'realised', date: input.date, customerId: input.customerId, invoiceId: p.invoice._id, paymentId: payment._id,
      currencyId: p.invoice.currencyId, baseCurrencyId: base.id, amountMinor: p.receivedBaseMinor - p.bookedBaseMinor,
      bookedRate: p.invoice.rateToBase, actualRate: paid.id === String(p.invoice.currencyId) ? rateToBase : undefined, createdBy: ctx.actorId,
    })));
  }
  const gain = differences.reduce((s, p) => s + p.receivedBaseMinor - p.bookedBaseMinor, 0);
  await log(ctx, new Date(), `${payment.number}: ${formatMoney(input.amount.amountMinor, paid)} received from ${await partyName(input.customerId)}${plan.length ? ` against ${plan.map((p) => p.invoice.number).join(', ')}` : ''}${gain ? ` · exchange ${gain > 0 ? 'gain' : 'loss'} ${formatMoney(Math.abs(gain), base)}` : ''}`, { entity: 'payments-received', entityId: payment._id });
  await notify({
    event: 'payment.received', partyId: input.customerId, receives: 'invoices', ref: { kind: 'payments-received', id: String(payment._id) }, actorId: ctx.actorId,
    variables: { 'payment.number': String(payment.number), 'payment.amount': formatMoney(input.amount.amountMinor, paid), 'payment.invoices': plan.map((p) => p.invoice.number).join(', ') },
  });
  return presentPayment(payment.toObject() as Plain);
}

async function presentPayment(doc: Plain) {
  const currency = await currencyUnits((doc.amount as Plain).currencyId);
  const allocations = (doc.allocations ?? []) as Plain[];
  return {
    ...present(doc), currency: currency.code, minorUnits: currency.minorUnits, customer: await partyName(doc.customerId),
    gainLossBaseMinor: allocations.reduce((s, a) => s + Number(a.gainLossBaseMinor ?? 0), 0),
  };
}

export async function listPayments(query: S.PaymentListQuery) {
  const filter: Plain = query.customerId ? { customerId: query.customerId } : {};
  const [rows, total] = await Promise.all([
    CustomerPayment.find(filter).sort({ date: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    CustomerPayment.countDocuments(filter),
  ]);
  return { data: await Promise.all((rows as Plain[]).map(presentPayment)), page: query.page, limit: query.limit, total };
}

export async function getPayment(id: string) {
  const doc = await CustomerPayment.findById(id).lean() as Plain | null;
  if (!doc) throw new NotFoundError('Payment not found');
  return presentPayment(doc);
}

/** Exchange gains and losses, newest first, for the accounts. */
export async function listDifferences(query: { page: number; limit: number; invoiceId?: string }) {
  const filter: Plain = query.invoiceId ? { invoiceId: query.invoiceId } : {};
  const [rows, total] = await Promise.all([
    ExchangeDifference.find(filter).sort({ date: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    ExchangeDifference.countDocuments(filter),
  ]);
  return { data: (rows as Plain[]).map(present), page: query.page, limit: query.limit, total };
}
