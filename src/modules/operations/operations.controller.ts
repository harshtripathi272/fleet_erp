import * as Placements from './placements.js';
import * as Undelivered from './undelivered.service.js';
import type { Request, Response } from 'express';
import { ApiResponse, buildPaginationMeta } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as Cargo from './cargo.service.js';
import * as Consignments from './consignments.service.js';
import * as GateService from './gate.js';
import { Trip as TripModel } from './models/trip.model.js';
import { NotFoundError } from '../../core/errors/index.js';
import * as S from './operations.schema.js';
import * as Dashboards from './dashboards.service.js';
import * as DriverApp from './driverApp.service.js';
import * as Expenses from './expenses.service.js';
import * as Funding from './funding.service.js';
import * as Messages from './messages.service.js';
import * as Nominations from './nominations.service.js';
import * as Printouts from './printouts.js';
import * as Settlements from './settlements.service.js';
import * as Stages from './stages.js';
import { opsContext } from './support.js';
import * as Trips from './trips.service.js';
import * as WhatsApp from './whatsapp.service.js';

type Page = { data: unknown[]; total: number; page: number; limit: number };
const paged = (res: Parameters<Parameters<typeof asyncHandler>[0]>[1], result: Page) => ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
const param = (req: Request, key = 'id') => (req.params as Record<string, string>)[key]!;
const query = <T>(req: Request) => req.query as unknown as T;

/** A printout as a file the browser opens or saves, the same PDF the e-mails attach (printouts.ts). */
function sendPdf(res: Response, pdf: { name: string; body: Buffer }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(pdf.name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(pdf.body);
}

/* Trips */
export const listTrips = asyncHandler(async (req, res) => {
  const page = await Trips.listTrips(query(req));
  return paged(res, { ...page, data: page.data.map((t) => Dashboards.withoutProfit(t, req.auth!.can)) });
});
export const getTrip = asyncHandler(async (req, res) => ApiResponse.success(res, Dashboards.withoutProfit(await Trips.getTrip(param(req)), req.auth!.can)));
export const createTrip = asyncHandler(async (req, res) => ApiResponse.created(res, await Trips.createTrip(req.body, opsContext(req)), 'Trip created'));
export const updateTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.updateTrip(param(req), req.body, opsContext(req)), 'Plan updated'));
export const cancelTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.cancelTrip(param(req), req.body, opsContext(req)), 'Trip cancelled'));
export const dispatchTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.dispatchTrip(param(req), opsContext(req), req.body), 'Dispatched'));
export const reportPosition = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.reportPosition(param(req), req.body, opsContext(req))));
export const arriveAtStop = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.arriveAtStop(param(req), param(req, 'stopId'), opsContext(req))));
export const remind = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.remind(param(req), opsContext(req)), 'Reminder sent'));
export const stopTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.stopTrip(param(req), req.body, opsContext(req)), 'Trip stopped'));
export const undelivered = asyncHandler(async (req, res) => ApiResponse.success(res, await Undelivered.handleUndelivered(param(req, 'id'), req.body, opsContext(req)), 'Decided'));
export const decideWriteOff = asyncHandler(async (req, res) => ApiResponse.success(res, await Undelivered.decideWriteOff(param(req, 'id'), req.body, opsContext(req)), 'Decided'));
export const endTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.endTrip(param(req), req.body, opsContext(req)), 'Trip ended'));
export const completeStage = asyncHandler(async (req, res) => ApiResponse.success(res, Trips.presentTrip((await Stages.completeStage(param(req), opsContext(req))).toObject()), 'Stage complete'));
export const funding = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.getFunding(param(req))));
export const tripSheet = asyncHandler(async (req, res) => ApiResponse.success(res, await Dashboards.tripSheet(param(req))));
export const tripSheetPdf = asyncHandler(async (req, res) => sendPdf(res, await Printouts.tripSheetPdf(param(req))));
export const listVehicleStates = asyncHandler(async (_req, res) => ApiResponse.success(res, await Trips.listVehicleStates()));
export const correctVehicleState = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.correctVehicleState(param(req, 'vehicleId'), req.body, opsContext(req)), 'Truck updated'));

/* Money requests */
export const listRequests = asyncHandler(async (req, res) => paged(res, await Funding.listRequests(query(req))));
export const getRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.getRequest(param(req))));
export const createRequest = asyncHandler(async (req, res) => ApiResponse.created(res, await Funding.createRequest(req.body, opsContext(req)), 'Sent for approval'));
export const decideRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.decideRequest(param(req), req.body, opsContext(req))));
export const issueRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.issueRequest(param(req), req.body, opsContext(req)), 'Paid'));
export const cancelRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.cancelRequest(param(req), opsContext(req)), 'Request cancelled'));

/* Driver documents, loading, delivery */
export const listDocuments = asyncHandler(async (req, res) => paged(res, await Cargo.listDocuments(query(req))));
export const getDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.getDocument(param(req))));
export const sendDocument = asyncHandler(async (req, res) => ApiResponse.created(res, await Cargo.sendDocument(req.body, opsContext(req)), 'Document received'));
export const markDocumentDone = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.markDone(param(req), opsContext(req)), 'Done'));
export const returnDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.returnDocument(param(req), req.body, opsContext(req)), 'Returned to the driver'));
export const listConsignments = asyncHandler(async (req, res) => paged(res, await Consignments.listConsignments(query(req), opsContext(req))));
export const getConsignment = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.getConsignment(param(req), opsContext(req))));
export const recordLoading = asyncHandler(async (req, res) => ApiResponse.created(res, await Consignments.recordLoading(req.body, opsContext(req)), 'Loading recorded'));
export const recordDelivery = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.recordDelivery(param(req), req.body, opsContext(req)), 'Delivery recorded'));

/* ---------- Consignments on legs (#135, the API contract's sections 1–2). Mounted by lakshya-t3 while the builder was paused. ---------- */

/** POST /consignments: the new body (it has `lines`), or for one release today's loading body (contract 2.5). */
export const createOrLoad = asyncHandler(async (req, res) => {
  if (Array.isArray((req.body as { lines?: unknown }).lines)) {
    return ApiResponse.created(res, await Consignments.createConsignment(S.createConsignmentSchema.parse(req.body), opsContext(req)), 'Consignment added');
  }
  return ApiResponse.created(res, await Consignments.recordLoading(S.loadingSchema.parse(req.body), opsContext(req)), 'Loading recorded');
});
export const updateConsignment = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.updateConsignment(param(req), req.body, opsContext(req)), 'Consignment saved'));
export const putLegs = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.putLegs(param(req), req.body, opsContext(req)), 'Drops saved'));
export const cancelConsignment = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.cancelConsignment(param(req), req.body, opsContext(req)), 'Consignment cancelled'));
export const recordLeg = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.recordLeg(param(req), param(req, 'legId'), req.body, opsContext(req)), 'Recorded'));
export const recordAtStop = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.recordAtStop(param(req), param(req, 'stopId'), req.body, opsContext(req)), 'Recorded'));
export const attachDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.attachDocument(param(req), req.body, opsContext(req)), 'Paper attached'));
export const detachDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.detachDocument(param(req), param(req, 'docId'), opsContext(req)), 'Paper removed'));
export const fileDriverDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.fileDriverDocument(param(req), req.body, opsContext(req)), 'Filed'));
export const tripCapacity = asyncHandler(async (req, res) => ApiResponse.success(res, await Consignments.tripCapacity(param(req))));
export const tripGate = asyncHandler(async (req, res) => {
  const trip = await TripModel.findById(param(req)).lean();
  if (!trip) throw new NotFoundError('Trip not found');
  ApiResponse.success(res, { gate: await GateService.tripGate(trip as never) });
});
export const decideShortage = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.decideShortage(param(req), req.body, opsContext(req))));

/* Expenses */
export const listExpenses = asyncHandler(async (req, res) => paged(res, await Expenses.listExpenses(query(req))));
export const getExpense = asyncHandler(async (req, res) => ApiResponse.success(res, await Expenses.getExpense(param(req))));
export const recordExpense = asyncHandler(async (req, res) => ApiResponse.created(res, await Expenses.recordExpense(req.body, opsContext(req)), 'Expense recorded'));
export const decideExpense = asyncHandler(async (req, res) => ApiResponse.success(res, await Expenses.decideExpense(param(req), req.body, opsContext(req))));

/* Settlement */
export const listAccounts = asyncHandler(async (_req, res) => ApiResponse.success(res, await Settlements.listAccounts()));
export const getAccount = asyncHandler(async (req, res) => ApiResponse.success(res, await Settlements.getAccount(param(req, 'driverId'))));
export const requestSettlement = asyncHandler(async (req, res) => ApiResponse.success(res, await Settlements.requestSettlement(param(req, 'driverId'), opsContext(req)), 'Finance asked to settle'));
export const listSettlements = asyncHandler(async (req, res) => paged(res, await Settlements.listSettlements(query(req))));
export const getSettlement = asyncHandler(async (req, res) => ApiResponse.success(res, await Settlements.getSettlement(param(req))));
export const statement = asyncHandler(async (req, res) => ApiResponse.success(res, await Settlements.statement(param(req))));
export const statementPdf = asyncHandler(async (req, res) => sendPdf(res, await Printouts.statementPdf(param(req))));
export const postSettlement = asyncHandler(async (req, res) => ApiResponse.created(res, await Settlements.postSettlement(req.body, opsContext(req)), 'Settlement posted'));

/* Nominations */
export const listNominations = asyncHandler(async (req, res) => paged(res, await Nominations.listNominations(query(req))));
export const getNomination = asyncHandler(async (req, res) => ApiResponse.success(res, await Nominations.getNomination(param(req))));
export const createNomination = asyncHandler(async (req, res) => ApiResponse.created(res, await Nominations.createNomination(req.body, opsContext(req)), 'Nomination saved'));
export const updateNomination = asyncHandler(async (req, res) => ApiResponse.success(res, await Nominations.updateNomination(param(req), req.body, opsContext(req)), 'Nomination saved'));
export const sendNomination = asyncHandler(async (req, res) => ApiResponse.success(res, await Nominations.sendNomination(param(req), opsContext(req)), 'Sent to the customer'));
export const acceptNomination = asyncHandler(async (req, res) => ApiResponse.success(res, await Nominations.acceptNomination(param(req), req.body, opsContext(req)), 'Accepted'));
export const convertNomination = asyncHandler(async (req, res) => ApiResponse.success(res, await Nominations.convertNomination(param(req), req.body, opsContext(req)), 'Trips created'));
export const cancelNomination = asyncHandler(async (req, res) => ApiResponse.success(res, await Nominations.cancelNomination(param(req), opsContext(req)), 'Nomination cancelled'));

/* Messages, activity, dashboards, WhatsApp */
const viewer = (req: Request): Messages.Viewer => ({ userId: req.auth!.userId, roles: req.auth!.roles, can: req.auth!.can });
export const listMessages = asyncHandler(async (req, res) => ApiResponse.success(res, await Messages.listMessages(query(req), viewer(req))));
export const listThreads = asyncHandler(async (req, res) => ApiResponse.success(res, await Messages.listThreads(viewer(req))));
export const sendChat = asyncHandler(async (req, res) => ApiResponse.created(res, await Messages.sendChat(req.body, opsContext(req))));
export const markRead = asyncHandler(async (req, res) => ApiResponse.success(res, await Messages.markRead(req.body, req.auth!.userId)));
export const listActivity = asyncHandler(async (req, res) => ApiResponse.success(res, await Messages.listActivity(query(req))));
export const ownerDashboard = asyncHandler(async (_req, res) => ApiResponse.success(res, await Dashboards.ownerDashboard()));
export const financeDashboard = asyncHandler(async (_req, res) => ApiResponse.success(res, await Dashboards.financeDashboard()));
export const sync = asyncHandler(async (req, res) => ApiResponse.success(res, await Dashboards.sync(query<{ since?: Date; from?: Date }>(req).since, viewer(req), query<{ from?: Date }>(req).from)));
export const simulate = asyncHandler(async (req, res) => ApiResponse.created(res, await WhatsApp.simulate(req.body, opsContext(req)), 'Sent from the driver\'s phone'));
export const inbound = asyncHandler(async (req, res) => ApiResponse.success(res, await WhatsApp.inbound(req.get('x-webhook-secret'), req.body)));

/* Driver app: the signed-in driver's own work */
const driverActor = (req: Request): DriverApp.DriverActor => ({ userId: req.auth!.userId, driverId: req.auth!.driverId!, name: req.auth!.name });
export const driverHome = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.home(driverActor(req))));
export const driverStatementPdf = asyncHandler(async (req, res) => sendPdf(res, await DriverApp.statementPdf(driverActor(req), param(req))));
export const driverMessages = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.messages(driverActor(req), query<{ since?: string }>(req).since)));
export const driverSend = asyncHandler(async (req, res) => ApiResponse.created(res, await DriverApp.send(driverActor(req), req.body), 'Sent to the office'));
export const companyFields = asyncHandler(async (_req, res) => ApiResponse.success(res, await Placements.companyFields()));
export const driverFields = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.answerFields(driverActor(req), req.body), 'Sent to the office'));
export const driverDefect = asyncHandler(async (req, res) => ApiResponse.created(res, await DriverApp.reportDefect(driverActor(req), req.body), 'Sent to the office'));
export const driverArrive = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.arrive(driverActor(req), param(req, 'stopId')), 'Arrival recorded'));
