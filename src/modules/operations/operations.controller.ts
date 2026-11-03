import type { Request } from 'express';
import { ApiResponse, buildPaginationMeta } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as Cargo from './cargo.service.js';
import * as Dashboards from './dashboards.service.js';
import * as DriverApp from './driverApp.service.js';
import * as Expenses from './expenses.service.js';
import * as Funding from './funding.service.js';
import * as Messages from './messages.service.js';
import * as Nominations from './nominations.service.js';
import * as Settlements from './settlements.service.js';
import * as Stages from './stages.js';
import { opsContext } from './support.js';
import * as Trips from './trips.service.js';
import * as WhatsApp from './whatsapp.service.js';

type Page = { data: unknown[]; total: number; page: number; limit: number };
const paged = (res: Parameters<Parameters<typeof asyncHandler>[0]>[1], result: Page) => ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
const param = (req: Request, key = 'id') => (req.params as Record<string, string>)[key]!;
const query = <T>(req: Request) => req.query as unknown as T;

/* Trips */
export const listTrips = asyncHandler(async (req, res) => paged(res, await Trips.listTrips(query(req))));
export const getTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.getTrip(param(req))));
export const createTrip = asyncHandler(async (req, res) => ApiResponse.created(res, await Trips.createTrip(req.body, opsContext(req)), 'Trip created'));
export const updateTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.updateTrip(param(req), req.body, opsContext(req)), 'Plan updated'));
export const cancelTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.cancelTrip(param(req), req.body, opsContext(req)), 'Trip cancelled'));
export const dispatchTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.dispatchTrip(param(req), opsContext(req)), 'Dispatched'));
export const reportPosition = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.reportPosition(param(req), req.body, opsContext(req))));
export const arriveAtStop = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.arriveAtStop(param(req), param(req, 'stopId'), opsContext(req))));
export const remind = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.remind(param(req), opsContext(req)), 'Reminder sent'));
export const endTrip = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.endTrip(param(req), req.body, opsContext(req)), 'Trip ended'));
export const completeStage = asyncHandler(async (req, res) => ApiResponse.success(res, Trips.presentTrip((await Stages.completeStage(param(req), opsContext(req))).toObject()), 'Stage complete'));
export const funding = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.getFunding(param(req))));
export const tripSheet = asyncHandler(async (req, res) => ApiResponse.success(res, await Dashboards.tripSheet(param(req))));
export const listVehicleStates = asyncHandler(async (_req, res) => ApiResponse.success(res, await Trips.listVehicleStates()));
export const correctVehicleState = asyncHandler(async (req, res) => ApiResponse.success(res, await Trips.correctVehicleState(param(req, 'vehicleId'), req.body, opsContext(req)), 'Truck updated'));

/* Money requests */
export const listRequests = asyncHandler(async (req, res) => paged(res, await Funding.listRequests(query(req))));
export const getRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.getRequest(param(req))));
export const createRequest = asyncHandler(async (req, res) => ApiResponse.created(res, await Funding.createRequest(req.body, opsContext(req)), 'Sent to Finance'));
export const decideRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.decideRequest(param(req), req.body, opsContext(req))));
export const issueRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.issueRequest(param(req), req.body, opsContext(req)), 'Paid'));
export const cancelRequest = asyncHandler(async (req, res) => ApiResponse.success(res, await Funding.cancelRequest(param(req), opsContext(req)), 'Request cancelled'));

/* Driver documents, loading, delivery */
export const listDocuments = asyncHandler(async (req, res) => paged(res, await Cargo.listDocuments(query(req))));
export const getDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.getDocument(param(req))));
export const sendDocument = asyncHandler(async (req, res) => ApiResponse.created(res, await Cargo.sendDocument(req.body, opsContext(req)), 'Document received'));
export const markDocumentDone = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.markDone(param(req), opsContext(req)), 'Done'));
export const returnDocument = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.returnDocument(param(req), req.body, opsContext(req)), 'Returned to the driver'));
export const listConsignments = asyncHandler(async (req, res) => paged(res, await Cargo.listConsignments(query(req))));
export const getConsignment = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.getConsignment(param(req))));
export const recordLoading = asyncHandler(async (req, res) => ApiResponse.created(res, await Cargo.recordLoading(req.body, opsContext(req)), 'Loading recorded'));
export const recordDelivery = asyncHandler(async (req, res) => ApiResponse.success(res, await Cargo.recordDelivery(param(req), req.body, opsContext(req)), 'Delivery recorded'));
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
export const sync = asyncHandler(async (req, res) => ApiResponse.success(res, await Dashboards.sync(query<{ since?: Date }>(req).since, viewer(req))));
export const simulate = asyncHandler(async (req, res) => ApiResponse.created(res, await WhatsApp.simulate(req.body, opsContext(req)), 'Sent from the driver\'s phone'));
export const inbound = asyncHandler(async (req, res) => ApiResponse.success(res, await WhatsApp.inbound(req.get('x-webhook-secret'), req.body)));

/* Driver app: the signed-in driver's own work */
const driverActor = (req: Request): DriverApp.DriverActor => ({ userId: req.auth!.userId, driverId: req.auth!.driverId!, name: req.auth!.name });
export const driverHome = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.home(driverActor(req))));
export const driverMessages = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.messages(driverActor(req), query<{ since?: string }>(req).since)));
export const driverSend = asyncHandler(async (req, res) => ApiResponse.created(res, await DriverApp.send(driverActor(req), req.body), 'Sent to the office'));
export const driverArrive = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverApp.arrive(driverActor(req), param(req, 'stopId')), 'Arrival recorded'));
