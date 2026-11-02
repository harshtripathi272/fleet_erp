import { NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { ExpenseCategory } from '../trips/models/expense.model.js';
import { DriverDocument } from './models/cargo.model.js';
import { Expense } from './models/money.model.js';
import { Trip } from './models/trip.model.js';
import {
  activeDriver, activeRecord, conflict, currencyInfo, driverThread, formatMoney, loadOr404, log, need, nextNumber, post, present, refuse,
  resolve, save, toBase, type OpsContext,
} from './support.js';
import type * as S from './operations.schema.js';

export async function listExpenses(query: S.ExpenseListQuery) {
  const filter: Plain = {};
  for (const key of ['tripId', 'driverId', 'status'] as const) if (query[key]) filter[key] = query[key];
  const [rows, total] = await Promise.all([
    Expense.find(filter).sort({ at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Expense.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: query.page, limit: query.limit };
}

export async function getExpense(id: string) {
  const doc = await Expense.findById(id).lean();
  if (!doc) throw new NotFoundError('Expense not found');
  return present(doc);
}

/** A trip cost against a driver. Recorded by someone who may approve expenses, it is approved at once. */
export async function recordExpense(input: S.ExpenseInput, ctx: OpsContext) {
  need(ctx, 'expenses', 'create');
  const at = new Date();
  const driver = await activeDriver(input.driverId);
  const trip = input.tripId ? ((await Trip.findById(input.tripId).lean()) as Plain | null) : null;
  if (input.tripId && !trip) throw new NotFoundError('Trip not found');
  if (trip && String(trip.driverId) !== String(driver._id)) throw refuse('This trip belongs to another driver.');
  if (trip?.settlementId) throw conflict('That trip is settled. Put it on the next trip.');
  const category = await activeRecord(ExpenseCategory, input.categoryId, 'expense type');
  const currency = await currencyInfo(input.amount.currencyId);
  const { baseMinor, rate } = await toBase(input.amount.amountMinor, input.amount.currencyId, at);
  const doc = input.docId ? await DriverDocument.findById(input.docId) : null;
  if (input.docId && !doc) throw refuse('The receipt was not found.');
  if (doc && doc.get('status') !== 'new') throw conflict('That receipt was already handled.');
  const approved = ctx.can('expense-approvals', 'create');
  const expense = new Expense({
    number: await nextNumber('expenses', 'EXP', at), tripId: trip?._id, driverId: driver._id, categoryId: category._id,
    amount: input.amount, baseAmountMinor: baseMinor, rate, receiptNo: input.receiptNo, docId: input.docId, note: input.note,
    status: approved ? 'approved' : 'pending', recordedByDesk: ctx.desk, decidedAt: approved ? at : undefined, decidedBy: approved ? ctx.actorId : undefined,
    at, createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  await save(expense);
  const number = String(expense.get('number'));
  if (doc) {
    doc.set({ status: 'recorded', recordRef: number });
    await save(doc);
    await resolve(String(doc._id), approved ? `Approved · ${number}` : `Recorded · ${number}`);
  }
  const amount = formatMoney(input.amount.amountMinor, currency);
  if (approved) {
    await post(driverThread(driver._id), at, { title: 'Expense approved', text: `${category.name} ${amount}${trip ? ` on ${trip.number}` : ''}. It's off your balance.` }, ctx);
  } else {
    await post('finance', at, {
      title: `Expense ${number}`, text: `Operations recorded this for ${driver.name}.`,
      rows: [['Type', String(category.name)], ['Amount', amount], ['Trip', String(trip?.number ?? '—')]],
      buttons: [
        { label: 'Approve', tone: 'primary', action: { type: 'expense.decide', id: String(expense._id), approve: true, via: 'whatsapp' } },
        { label: 'Reject', tone: 'danger', action: { type: 'expense.decide', id: String(expense._id), approve: false, via: 'whatsapp' } },
      ],
      refId: String(expense._id),
    }, ctx);
  }
  await log(ctx, at, `${approved ? 'Approved' : 'Recorded'} ${category.name} ${amount} (${number})`, { tripId: trip?._id, entity: 'expenses', entityId: expense._id });
  return present(expense.toObject());
}

export async function decideExpense(id: string, input: S.ExpenseDecisionInput, ctx: OpsContext) {
  need(ctx, 'expense-approvals', 'create', 'Finance approves expenses.');
  const at = new Date();
  const expense = await loadOr404(Expense, id, 'Expense');
  if (expense.get('status') !== 'pending') throw conflict('Already decided.');
  if (!input.approve && !input.reason) throw refuse('Give a reason.');
  expense.set({ status: input.approve ? 'approved' : 'rejected', decidedAt: at, decidedBy: ctx.actorId, reason: input.reason, updatedBy: ctx.actorId });
  await save(expense);
  await resolve(id, input.approve ? 'Approved' : 'Rejected');
  const category = String((await ExpenseCategory.findById(expense.get('categoryId')).select('name').lean())?.name ?? 'Expense');
  const amount = formatMoney(expense.get('amount').amountMinor, await currencyInfo(expense.get('amount').currencyId));
  await post(driverThread(expense.get('driverId')), at, {
    title: input.approve ? 'Expense approved' : 'Expense not accepted',
    text: input.approve ? `${category} ${amount}. It's off your balance.` : `${category} ${amount}: ${input.reason}`,
  }, ctx);
  await log(ctx, at, `${input.approve ? 'Approved' : 'Rejected'} ${expense.get('number')}`, { tripId: expense.get('tripId'), entity: 'expenses', entityId: expense._id });
  return present(expense.toObject());
}
