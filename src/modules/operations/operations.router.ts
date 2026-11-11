import { Router, type RequestHandler } from 'express';
import { ForbiddenError } from '../../core/errors/index.js';
import { idParams } from '../../core/masters/zod.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as C from './operations.controller.js';
import * as S from './operations.schema.js';
import { requireArea } from '../company/areas.js';
import { defectSchema } from '../maintenance/maintenance.schema.js';
import { requireModule } from './settings.js';
import './usage.js';

/**
 * Trips and money: nominations, trips, money requests, driver documents, loading and delivery,
 * expenses, settlement, messages and dashboards. Mounted at /api/v1.
 * Routes check the area's permission; services check the rules, including who may approve, which
 * comes from the company's approval policies.
 */
const router = Router();
const id = { params: idParams };

/** Mounted ahead of the masters without a blanket `authenticate`, so it signs in only its own paths. */
export const OPERATIONS_PATHS = [
  '/operations', '/dashboards', '/trips', '/vehicle-states', '/fund-requests', '/driver-documents', '/consignments', '/expenses',
  '/driver-accounts', '/settlements', '/nominations', '/messages', '/activity', '/whatsapp/simulate', '/driver-app',
];
router.use(OPERATIONS_PATHS, authenticate, requireModule('trips'));
/** Money areas need the company's Finance module as well; position reports need Tracking. */
router.use(['/fund-requests', '/expenses', '/settlements', '/driver-accounts', '/dashboards/finance'], requireModule('finance'));
const finance = requireModule('finance');
/** The driver app is only for accounts linked to a driver, and only when the company uses it. */
router.use('/driver-app', requireModule('driver-app'), (req, _res, next) => {
  if (!req.auth?.driverId) throw new ForbiddenError('The driver app is for driver accounts');
  next();
});
const tracking = requireModule('tracking');

router.get('/operations/sync', authorize('trips', 'read'), validate({ query: S.syncQuery }), C.sync);
router.get('/dashboards/owner', authorize('trips', 'read'), C.ownerDashboard);
router.get('/dashboards/finance', authorize('fund-requests', 'read'), C.financeDashboard);

router.get('/trips', authorize('trips', 'read'), validate({ query: S.tripListQuery }), C.listTrips);
router.post('/trips', authorize('trips', 'create'), validate({ body: S.createTripSchema }), C.createTrip);
router.get('/trips/:id', authorize('trips', 'read'), validate(id), C.getTrip);
router.patch('/trips/:id', authorize('trips', 'update'), validate({ ...id, body: S.updateTripSchema }), C.updateTrip);
router.get('/trips/:id/funding', finance, authorize('trips', 'read'), validate(id), C.funding);
router.get('/trips/:id/sheet', authorize('trips', 'read'), validate(id), C.tripSheet);
router.get('/trips/:id/sheet.pdf', authorize('trips', 'read'), validate(id), C.tripSheetPdf);
router.post('/trips/:id/cancel', authorize('trips', 'update'), validate({ ...id, body: S.reasonSchema }), C.cancelTrip);
router.get('/operations/company-fields', C.companyFields);
router.post('/trips/:id/driver', authorize('trips', 'update'), validate({ ...id, body: S.changeDriverSchema }), C.changeDriver);
router.post('/trips/:id/dispatch', authorize('trips', 'update'), validate({ ...id, body: S.dispatchSchema }), C.dispatchTrip);
router.post('/trips/:id/position', tracking, authorize('trips', 'update'), validate({ ...id, body: S.positionSchema }), C.reportPosition);
router.post('/trips/:id/stops/:stopId/arrive', authorize('trips', 'update'), validate({ params: S.tripStopParams }), C.arriveAtStop);
router.post('/trips/:id/remind', authorize('messages', 'create'), validate(id), C.remind);
router.post('/trips/:id/end', authorize('trips', 'update'), validate({ ...id, body: S.endTripSchema }), C.endTrip);
router.post('/trips/:id/stop', authorize('trips', 'update'), validate({ ...id, body: S.stopTripSchema }), C.stopTrip);
router.post('/trips/:id/undelivered', authorize('trips', 'update'), validate({ ...id, body: S.undeliveredSchema }), C.undelivered);
router.post('/consignments/:id/write-off-decision', authorize('consignments', 'read'), validate({ ...id, body: S.writeOffDecisionSchema }), C.decideWriteOff);
router.post('/trips/:id/stages/complete', authorize('trips', 'read'), validate(id), C.completeStage);

router.get('/vehicle-states', authorize('vehicle-states', 'read'), C.listVehicleStates);
router.put('/vehicle-states/:vehicleId', authorize('vehicle-states', 'update'), validate({ params: S.vehicleParams, body: S.vehicleStateSchema }), C.correctVehicleState);

router.get('/fund-requests', authorize('fund-requests', 'read'), validate({ query: S.requestListQuery }), C.listRequests);
router.post('/fund-requests', authorize('fund-requests', 'create'), validate({ body: S.createRequestSchema }), C.createRequest);
router.get('/fund-requests/:id', authorize('fund-requests', 'read'), validate(id), C.getRequest);
router.post('/fund-requests/:id/decide', authorize('fund-requests', 'read'), validate({ ...id, body: S.decideSchema }), C.decideRequest);
router.post('/fund-requests/:id/issue', authorize('payments', 'create'), validate({ ...id, body: S.issueSchema }), C.issueRequest);
router.post('/fund-requests/:id/cancel', authorize('fund-requests', 'update'), validate(id), C.cancelRequest);

router.get('/driver-documents', authorize('driver-documents', 'read'), validate({ query: S.documentListQuery }), C.listDocuments);
router.post('/driver-documents', authorize('driver-documents', 'create'), validate({ body: S.sendDocumentSchema }), C.sendDocument);
router.get('/driver-documents/:id', authorize('driver-documents', 'read'), validate(id), C.getDocument);
router.post('/driver-documents/:id/done', authorize('driver-documents', 'update'), validate(id), C.markDocumentDone);
router.post('/driver-documents/:id/return', authorize('driver-documents', 'update'), validate({ ...id, body: S.reasonSchema }), C.returnDocument);

router.get('/consignments', authorize('consignments', 'read'), validate({ query: S.consignmentsQuery }), C.listConsignments);
// A new consignment (#135), or today's loading body, kept for one release (design 3.10): the invoice number tells them apart.
const newConsignment = validate({ body: S.createConsignmentSchema });
const oldLoading = validate({ body: S.loadingSchema });
const consignmentBody = Object.assign<RequestHandler, { meta: object }>((req, res, next) => (req.body && typeof req.body === 'object' && 'invoiceNo' in req.body ? oldLoading : newConsignment)(req, res, next), { meta: (newConsignment as unknown as { meta: object }).meta });
router.post('/consignments', authorize('consignments', 'create'), consignmentBody, C.createConsignment);
// The report sits before /consignments/:id, which would otherwise take "report" for an id.
router.get('/consignments/report', authorize('consignments', 'read'), validate({ query: S.reportQuery }), C.consignmentReport);
router.get('/consignments/report.xlsx', authorize('consignments', 'read'), validate({ query: S.reportQuery }), C.consignmentReportFile('xlsx'));
router.get('/consignments/report.csv', authorize('consignments', 'read'), validate({ query: S.reportQuery }), C.consignmentReportFile('csv'));
router.get('/consignments/:id', authorize('consignments', 'read'), validate(id), C.getConsignment);
router.patch('/consignments/:id', authorize('consignments', 'update'), validate({ ...id, body: S.updateConsignmentSchema }), C.updateConsignment);
router.put('/consignments/:id/legs', authorize('consignments', 'update'), validate({ ...id, body: S.putLegsSchema }), C.putLegs);
router.post('/consignments/:id/legs/:legId/record', authorize('consignments', 'update'), validate({ params: S.legParams, body: S.legRecordSchema }), C.recordLeg);
router.post('/consignments/:id/refusals/:refusalId/decide', authorize('consignments', 'update'), validate({ params: S.refusalParams, body: S.refusalDecisionSchema }), C.decideRefusal);
router.post('/consignments/:id/cancel', authorize('consignments', 'update'), validate({ ...id, body: S.cancelConsignmentSchema }), C.cancelConsignment);
router.post('/consignments/:id/documents', authorize('consignments', 'update'), validate({ ...id, body: S.attachDocumentSchema }), C.attachDocument);
router.delete('/consignments/:id/documents/:docId', authorize('consignments', 'update'), validate({ params: S.documentParams }), C.detachDocument);
router.post('/consignments/:id/delivery', authorize('consignments', 'update'), validate({ ...id, body: S.deliverySchema }), C.recordDelivery);
router.post('/trips/:id/stops/:stopId/record', authorize('consignments', 'update'), validate({ params: S.tripStopParams, body: S.stopRecordSchema }), C.recordAtStop);
router.post('/trips/:id/stops/:stopId/pass', authorize('stop-gate-override', 'create'), validate({ params: S.tripStopParams, body: S.passStopSchema }), C.passStop);
router.put('/trips/:id/stops', authorize('trips', 'update'), validate({ ...id, body: S.putStopsSchema }), C.putStops);
router.get('/trips/:id/gate', authorize('trips', 'read'), validate(id), C.tripGate);
router.get('/trips/:id/capacity', authorize('trips', 'read'), validate(id), C.tripCapacity);
router.post('/driver-documents/:id/file', authorize('driver-documents', 'update'), validate({ ...id, body: S.fileDocumentSchema }), C.fileDriverDocument);
router.post('/consignments/:id/shortage-decision', finance, authorize('consignments', 'read'), validate({ ...id, body: S.shortageDecisionSchema }), C.decideShortage);

router.get('/expenses', authorize('expenses', 'read'), validate({ query: S.expenseListQuery }), C.listExpenses);
router.post('/expenses', authorize('expenses', 'create'), validate({ body: S.expenseSchema }), C.recordExpense);
router.get('/expenses/:id', authorize('expenses', 'read'), validate(id), C.getExpense);
router.post('/expenses/:id/decide', authorize('expenses', 'read'), validate({ ...id, body: S.expenseDecisionSchema }), C.decideExpense);

router.get('/driver-accounts', authorize('settlements', 'read'), C.listAccounts);
router.get('/driver-accounts/:driverId', authorize('settlements', 'read'), validate({ params: S.driverParams }), C.getAccount);
router.post('/driver-accounts/:driverId/settlement-request', authorize('settlement-requests', 'create'), validate({ params: S.driverParams }), C.requestSettlement);
router.get('/settlements', authorize('settlements', 'read'), validate({ query: S.settlementListQuery }), C.listSettlements);
router.post('/settlements', authorize('settlements', 'create'), validate({ body: S.settlementSchema }), C.postSettlement);
router.get('/settlements/:id', authorize('settlements', 'read'), validate(id), C.getSettlement);
router.post('/settlements/:id/reverse', authorize('settlements', 'create'), validate({ ...id, body: S.reverseSettlementSchema }), C.reverseSettlement);
router.get('/settlements/:id/statement', authorize('settlements', 'read'), validate(id), C.statement);
router.get('/settlements/:id/statement.pdf', authorize('settlements', 'read'), validate(id), C.statementPdf);

router.get('/nominations', authorize('nominations', 'read'), validate({ query: S.nominationListQuery }), C.listNominations);
router.post('/nominations', authorize('nominations', 'create'), validate({ body: S.nominationSchema }), C.createNomination);
router.get('/nominations/:id', authorize('nominations', 'read'), validate(id), C.getNomination);
router.patch('/nominations/:id', authorize('nominations', 'update'), validate({ ...id, body: S.nominationUpdateSchema }), C.updateNomination);
router.post('/nominations/:id/send', authorize('nominations', 'update'), validate(id), C.sendNomination);
router.post('/nominations/:id/accept', authorize('nominations', 'update'), validate({ ...id, body: S.acceptSchema }), C.acceptNomination);
router.post('/nominations/:id/convert', authorize('trips', 'create'), validate({ ...id, body: S.convertSchema }), C.convertNomination);
router.post('/nominations/:id/cancel', authorize('nominations', 'update'), validate(id), C.cancelNomination);

router.get('/messages', authorize('messages', 'read'), validate({ query: S.messageListQuery }), C.listMessages);
router.get('/messages/threads', authorize('messages', 'read'), C.listThreads);
router.post('/messages', authorize('messages', 'create'), validate({ body: S.chatSchema }), C.sendChat);
router.post('/messages/read', authorize('messages', 'read'), validate({ body: S.readSchema }), C.markRead);
router.get('/activity', authorize('activity', 'read'), validate({ query: S.activityListQuery }), C.listActivity);

router.get('/driver-app/home', C.driverHome);
router.get('/driver-app/settlements/:id/statement.pdf', validate(id), C.driverStatementPdf);
router.get('/driver-app/messages', validate({ query: S.driverMessagesQuery }), C.driverMessages);
// The driver app queues these on a weak signal and may send one twice; the Idempotency-Key keeps it to one.
router.post('/driver-app/fields', idempotent, validate({ body: S.driverFieldsSchema }), C.driverFields);
router.post('/driver-app/send', idempotent, validate({ body: S.driverSendSchema }), C.driverSend);
router.post('/driver-app/defects', requireArea('maintenance'), idempotent, validate({ body: defectSchema }), C.driverDefect);
router.post('/driver-app/stops/:stopId/arrive', idempotent, validate({ params: S.driverStopParams }), C.driverArrive);

router.post('/whatsapp/simulate', authorize('driver-documents', 'create'), validate({ body: S.simulateSchema }), C.simulate);

export default router;

/** Marichi Talks calls this without a user session; it proves itself with the shared secret. */
export const webhookRouter = Router();
webhookRouter.post('/inbound', validate({ body: S.inboundSchema }), C.inbound);
