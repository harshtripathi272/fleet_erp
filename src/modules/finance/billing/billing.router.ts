import { Router } from 'express';
import { z } from 'zod';
import { ApiResponse } from '../../../core/response/index.js';
import { createMasterRouter } from '../../../core/masters/router.js';
import { idParams, objectId } from '../../../core/masters/zod.js';
import { authorize } from '../../../middleware/authorize.js';
import { validate } from '../../../middleware/validate.js';
import { onEvent } from '../../messaging/dispatcher.js';
import { opsContext } from '../../operations/support.js';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { accountCodeDefinition, customerRateDefinition, requireBilling } from './billing.masters.js';
import * as S from './billing.schema.js';
import * as Invoices from './invoices.service.js';
import * as Payments from './payments.service.js';
import * as Revaluation from './revaluation.service.js';
import * as Statements from './statements.service.js';
import { exportCsv } from './export.service.js';

/**
 * Billing (#61), mounted at /api/v1 with a signed-in user: customer rates (a master),
 * invoices and credit notes, and payments received. Everything refuses while the company has Billing off.
 */
const router = Router();
const id = { params: idParams };

// The master belongs to Billing: hidden and refused while the area is off, its rates kept.
router.use('/customer-rates', createMasterRouter(customerRateDefinition));
router.use('/account-codes', createMasterRouter(accountCodeDefinition));
router.use(['/invoices', '/payments-received', '/exchange-differences', '/billing'], requireBilling);

router.get('/invoices', authorize('invoices', 'read'), validate({ query: S.invoiceListQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Invoices.listInvoices(req.query as unknown as S.InvoiceListQuery));
}));
router.get('/invoices/unbilled-trips', authorize('invoices', 'read'), validate({ query: S.unbilledQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Invoices.unbilledTrips(req.query as unknown as S.UnbilledQuery));
}));
router.post('/invoices/draft', authorize('invoices', 'create'), validate({ body: S.draftInvoicesSchema }), asyncHandler(async (req, res) => {
  const result = await Invoices.draftInvoices(req.body, opsContext(req));
  const n = result.drafted.length;
  ApiResponse.success(res, result, n ? `${n} draft invoice${n > 1 ? 's' : ''}` : 'Nothing to draft');
}));
router.get('/invoices/:id', authorize('invoices', 'read'), validate(id), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Invoices.getInvoice(String(req.params.id)));
}));
router.get('/invoices/:id/pdf', authorize('invoices', 'read'), validate(id), asyncHandler(async (req, res) => {
  const { invoicePdf } = await import('./invoicePdf.js');
  const { name, body } = await invoicePdf(String(req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(body);
}));
router.patch('/invoices/:id', authorize('invoices', 'update'), validate({ ...id, body: S.updateDraftSchema }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Invoices.updateDraft(String(req.params.id), req.body, opsContext(req)), 'Draft saved');
}));
router.post('/invoices/:id/approve', authorize('invoices', 'create'), validate({ ...id, body: S.versionBody }), asyncHandler(async (req, res) => {
  const invoice = await Invoices.approveInvoice(String(req.params.id), req.body.version, opsContext(req));
  ApiResponse.success(res, invoice, `${invoice.title} approved`);
}));
router.post('/invoices/:id/send', authorize('invoices', 'update'), validate(id), asyncHandler(async (req, res) => {
  const invoice = await Invoices.sendInvoice(String(req.params.id), opsContext(req));
  ApiResponse.success(res, invoice, `${invoice.title} sent`);
}));
router.post('/invoices/:id/cancel', authorize('invoices', 'update'), validate({ ...id, body: S.cancelInvoiceSchema }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Invoices.cancelInvoice(String(req.params.id), req.body, opsContext(req)), 'Draft cancelled');
}));
router.post('/invoices/:id/credit-notes', authorize('invoices', 'create'), validate({ ...id, body: S.creditNoteSchema }), asyncHandler(async (req, res) => {
  ApiResponse.created(res, await Invoices.draftCreditNote(String(req.params.id), req.body, opsContext(req)), 'Draft credit note');
}));

router.get('/payments-received', authorize('payments-received', 'read'), validate({ query: S.paymentListQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Payments.listPayments(req.query as unknown as S.PaymentListQuery));
}));
router.post('/payments-received', authorize('payments-received', 'create'), validate({ body: S.receivePaymentSchema }), asyncHandler(async (req, res) => {
  const payment = await Payments.receivePayment(req.body, opsContext(req));
  ApiResponse.created(res, payment, `${String((payment as Record<string, unknown>).number)} recorded`);
}));
router.get('/payments-received/:id', authorize('payments-received', 'read'), validate(id), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Payments.getPayment(String(req.params.id)));
}));

const differencesQuery = z.strictObject({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), invoiceId: objectId.optional() });
router.get('/exchange-differences', authorize('invoices', 'read'), validate({ query: differencesQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Payments.listDifferences(req.query as unknown as z.infer<typeof differencesQuery>));
}));

/* ---------- Ageing, statements, revaluation, export (#62) ---------- */

const dayQ = z.string().regex(/^\d{4}-\d\d-\d\d$/, 'A date such as 2026-01-31').transform((v) => new Date(`${v}T00:00:00.000Z`));
const ageingQuery = z.strictObject({ asOf: dayQ.optional(), customerId: objectId.optional() });
const statementQuery = z.strictObject({ from: dayQ.optional(), to: dayQ.optional(), currencyId: objectId.optional() });
const customerParams = z.strictObject({ customerId: objectId });
const exportQuery = z.strictObject({ from: dayQ, to: dayQ });
const revalueBody = z.strictObject({ periodEnd: dayQ.optional() });

router.get('/billing/ageing', authorize('invoices', 'read'), validate({ query: ageingQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Statements.ageing(req.query as unknown as z.infer<typeof ageingQuery>));
}));
router.get('/billing/statements/:customerId', authorize('invoices', 'read'), validate({ params: customerParams, query: statementQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Statements.statement(String(req.params.customerId), req.query as unknown as z.infer<typeof statementQuery>));
}));
router.get('/billing/statements/:customerId/pdf', authorize('invoices', 'read'), validate({ params: customerParams, query: statementQuery }), asyncHandler(async (req, res) => {
  const { name, body } = await Statements.statementPdf(String(req.params.customerId), req.query as unknown as z.infer<typeof statementQuery>);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^ -~]|"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(body);
}));
router.post('/billing/statements/:customerId/send', authorize('invoices', 'update'), validate({ params: customerParams, query: statementQuery }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Statements.sendStatement(String(req.params.customerId), req.query as unknown as z.infer<typeof statementQuery>, opsContext(req)), 'Statement sent');
}));
router.get('/billing/revaluations', authorize('invoices', 'read'), asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { due: await Revaluation.revaluationDue(), runs: await Revaluation.listRuns() });
}));
router.post('/billing/revaluations', authorize('invoices', 'create'), validate({ body: revalueBody }), asyncHandler(async (req, res) => {
  const run = await Revaluation.revalue({ periodEnd: req.body.periodEnd, trigger: 'manual' }, opsContext(req));
  ApiResponse.created(res, run, `Revalued ${run.invoices} open invoice${run.invoices === 1 ? '' : 's'}`);
}));
router.get('/billing/export', authorize('invoices', 'read'), validate({ query: exportQuery }), asyncHandler(async (req, res) => {
  const range = req.query as unknown as z.infer<typeof exportQuery>;
  const { csv } = await exportCsv(range);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="postings-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${csv}`);
}));

// A closed trip is invoiced when the company invoices each closed trip or nomination.
onEvent('trip.closed', async (input) => {
  if (input.ref?.kind === 'trips') await Invoices.onTripClosed(input.ref.id, input.actorId);
});

export default router;
