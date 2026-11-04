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
import { customerRateDefinition, requireBilling } from './billing.masters.js';
import * as S from './billing.schema.js';
import * as Invoices from './invoices.service.js';
import * as Payments from './payments.service.js';

/**
 * Billing (#61), mounted at /api/v1 with a signed-in user: customer rates (a master),
 * invoices and credit notes, and payments received. Everything refuses while the company has Billing off.
 */
const router = Router();
const id = { params: idParams };

router.use('/customer-rates', createMasterRouter(customerRateDefinition, (r) => { r.use(requireBilling); }));
router.use(['/invoices', '/payments-received', '/exchange-differences'], requireBilling);

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

// A closed trip is invoiced when the company invoices each closed trip or nomination.
onEvent('trip.closed', async (input) => {
  if (input.ref?.kind === 'trips') await Invoices.onTripClosed(input.ref.id, input.actorId);
});

export default router;
