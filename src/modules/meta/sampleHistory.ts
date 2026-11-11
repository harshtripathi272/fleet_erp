import type { Plain } from '../../core/masters/types.js';
import * as Cargo from '../operations/cargo.service.js';
import * as Consignments from '../operations/consignments.service.js';
import * as Expenses from '../operations/expenses.service.js';
import * as Funding from '../operations/funding.service.js';
import * as Nominations from '../operations/nominations.service.js';
import * as S from '../operations/operations.schema.js';
import * as Settlements from '../operations/settlements.service.js';
import { DESK_NAME, type Desk, type OpsContext } from '../operations/support.js';
import * as Trips from '../operations/trips.service.js';

/**
 * Trips at every stage, made through the same services the desks call: each step is taken by the desk
 * that owns it (Operations, Finance, the Owner, the driver's simulated phone), so approvals, budgets,
 * the 20 °C correction, shortages and settlement rules all apply. Driver documents are sample pictures
 * from the simulated phone and are marked simulated, like everything a simulator makes.
 */
type Ids = Record<string, string>;
type Until = 'planned' | 'dispatched' | 'loaded' | 'ended';

interface Receipt { item: string; category: string; amount: number; currency?: string; docNo: string; recorded?: boolean }
interface TripPlan {
  vehicle: string; trailer: string; driver: string; customer: string; route: string; product: string; tripType?: string;
  startsInDays: number;
  until: Until;
  load?: { invoiceNo: string; consignor: string; qty: number; tempC?: number; density?: number };
  /** Delivered at 20 °C as a share of the loaded 20 °C volume (fuel), or the delivered quantity (other cargo). */
  delivered?: { podNo: string; share?: number; qty?: number; tempC?: number };
  shortage?: 'charge' | { waive: string };
  receipts?: Receipt[];
  closingFuelL?: number;
}

export async function loadSampleHistory(ids: Ids, names: Record<string, string>, actorId?: string) {
  const desk = (d: Desk, roles: string[]): OpsContext => ({ actorId, name: DESK_NAME[d], desk: d, roles, can: () => true });
  const ops = desk('operations', ['operations']);
  const fin = desk('finance', ['finance']);
  const phone = (driver: string): OpsContext => ({ name: names[driver]!, desk: 'driver', roles: [], asDriver: true, simulated: true, driverId: ids[driver], can: () => true });
  const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  let created = 0;

  const sendDoc = async (driver: string, tripId: string, kind: 'loading' | 'delivery' | 'expense', reading: Plain, variant = 0) => {
    // Checked as the simulated phone's message, then filed as WhatsApp, as `POST /whatsapp/simulate` does.
    const input = S.simulateSchema.parse({
      driverId: ids[driver], tripId, kind, reading,
      file: { name: `IMG_${kind.toUpperCase()}_${variant}.jpg`, mime: 'image/jpeg', sampleId: `${kind}:${tripId}:${variant}` },
    });
    const doc = await Cargo.sendDocument({ driverId: input.driverId, tripId, kind, file: input.file, reading: input.reading, channel: 'whatsapp' }, phone(driver));
    created += 1;
    return String(doc.id);
  };
  const receipt = (driver: string, tripId: string, r: Receipt, variant = 0) =>
    sendDoc(driver, tripId, 'expense', { docNo: r.docNo, amount: r.amount, currencyCode: r.currency ?? 'ZMW', categoryId: ids[r.category] }, variant);

  /** Where each route starts; the truck is put there first, since a trip starts where its truck is. */
  const starts: Record<string, string> = { routeDar: 'depot', routeLub: 'depot', routeCopper: 'ndolaYard' };

  async function runTrip(plan: TripPlan): Promise<{ tripId: string; unrecorded: string[] }> {
    const route = plan.route;
    const unrecorded: string[] = [];
    await Trips.correctVehicleState(ids[plan.vehicle]!, { placeId: ids[starts[route]!], fuelL: 200 }, ops);
    const trip = await Trips.createTrip(S.createTripSchema.parse({
      customerId: ids[plan.customer], vehicleId: ids[plan.vehicle], driverId: ids[plan.driver], trailerId: ids[plan.trailer], routeId: ids[route],
      tripTypeId: plan.tripType ? ids[plan.tripType] : undefined, plannedStart: days(plan.startsInDays), productId: ids[plan.product],
    }), ops);
    const tripId = String(trip.id);
    created += 1;
    if (plan.until === 'planned') return { tripId, unrecorded };

    // Funding as suggested from the route budget and the tank, approved by Finance and paid.
    const f = await Trips.getFunding(tripId) as { fuel: { suggested: number }; cash: { suggestedMinor: number } };
    const requests = [];
    if (f.fuel.suggested > 0) requests.push({ request: await Funding.createRequest(S.createRequestSchema.parse({ tripId, kind: 'fuel', litres: f.fuel.suggested }), ops), pay: { paymentMethodId: ids.pmDepot, reference: `DEP-${tripId.slice(-6).toUpperCase()}`, station: 'Lusaka fuel depot' } });
    if (f.cash.suggestedMinor > 0) requests.push({ request: await Funding.createRequest(S.createRequestSchema.parse({ tripId, kind: 'cash', amount: { amountMinor: f.cash.suggestedMinor, currencyId: ids.ZMW } }), ops), pay: { paymentMethodId: ids.pmCash } });
    for (const { request, pay } of requests) {
      await Funding.decideRequest(String(request.id), { approve: true }, fin);
      await Funding.issueRequest(String(request.id), S.issueSchema.parse(pay), fin);
      created += 1;
    }
    await Trips.dispatchTrip(tripId, ops);
    if (plan.until === 'dispatched' || !plan.load) return { tripId, unrecorded };

    const fuel = plan.load.density !== undefined;
    const loaded = { qty: plan.load.qty, ...(fuel ? { ambientL: plan.load.qty, tempC: plan.load.tempC, density: plan.load.density } : {}) };
    const loadDoc = await sendDoc(plan.driver, tripId, 'loading', { docNo: plan.load.invoiceNo, productId: ids[plan.product], consignor: plan.load.consignor, ...loaded });
    const consignment = await Consignments.recordLoading(S.loadingSchema.parse({ tripId, productId: ids[plan.product], invoiceNo: plan.load.invoiceNo, consignor: plan.load.consignor, docId: loadDoc, ...loaded }), ops);
    created += 1;
    const onRoad = await Trips.getTrip(tripId) as { stops: Array<{ id: string; kind: string }> };
    for (const stop of onRoad.stops.filter((s) => s.kind === 'border')) await Trips.arriveAtStop(tripId, stop.id, ops);
    for (const [i, r] of (plan.receipts ?? []).entries()) {
      const docId = await receipt(plan.driver, tripId, r, i);
      if (r.recorded === false) { unrecorded.push(docId); continue; }
      await Expenses.recordExpense(S.expenseSchema.parse({ driverId: ids[plan.driver], tripId, categoryId: ids[r.category], amount: { amountMinor: Math.round(r.amount * 100), currencyId: ids[r.currency ?? 'ZMW'] }, receiptNo: r.docNo, docId, note: r.item }), fin);
      created += 1;
    }
    if (plan.until === 'loaded' || !plan.delivered) return { tripId, unrecorded };

    const load = (consignment as { load: { std20L?: number; qty: number } }).load;
    const delivered = fuel
      ? { qty: plan.load.qty, ambientL: plan.load.qty, tempC: plan.delivered.tempC ?? 22, density: plan.load.density, certStd20L: Math.round(load.std20L! * (plan.delivered.share ?? 1)) }
      : { qty: plan.delivered.qty ?? load.qty };
    const podDoc = await sendDoc(plan.driver, tripId, 'delivery', { docNo: plan.delivered.podNo, ...delivered });
    const result = await Consignments.recordDelivery(String(consignment.id), S.deliverySchema.parse({ podNo: plan.delivered.podNo, docId: podDoc, ...delivered }), ops) as { shortage?: { status: string } };
    if (result.shortage?.status === 'pending' && plan.shortage) {
      await Cargo.decideShortage(String(consignment.id), plan.shortage === 'charge' ? { charge: true } : { charge: false, note: plan.shortage.waive }, fin);
    }
    await Trips.endTrip(tripId, { closingFuelL: plan.closingFuelL ?? 150 }, ops);
    return { tripId, unrecorded };
  }

  async function sharedTrip() {
    await Trips.correctVehicleState(ids.v1!, { placeId: ids.ndolaYard, fuelL: 600 }, ops);
    const usd = (amountMinor: number, basis: 'per_consignment' | 'per_litre_20' = 'per_consignment') => ({ basis, price: { amountMinor, currencyId: ids.USD! } });
    const trip = await Trips.createTrip(S.createTripSchema.parse({
      customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, plannedStart: days(-7),
      stops: [
        { placeId: ids.ndolaYard, kind: 'start' }, { placeId: ids.darPort, kind: 'load' }, { placeId: ids.nakonde, kind: 'border' },
        { placeId: ids.depot, kind: 'offload' }, { placeId: ids.ndolaYard, kind: 'offload' }, { placeId: ids.ndolaYard, kind: 'end' },
      ],
      consignments: [
        { customerId: ids.zambezi, lines: [{ productId: ids.diesel50, plannedQty: 20000 }], consignor: { name: 'Kurasini Oil Jetty Terminal' }, legs: [{ kind: 'pickup', placeId: ids.darPort }, { kind: 'drop', placeId: ids.depot }], rate: usd(9, 'per_litre_20') },
        { customerId: ids.lake, lines: [{ productId: ids.ulp95, plannedQty: 12000 }], consignor: { name: 'Kurasini Oil Jetty Terminal' }, consignee: { name: 'Lake Petroleum, Ndola', phone: '+260977450012' }, legs: [{ kind: 'pickup', placeId: ids.darPort }, { kind: 'drop', placeId: ids.ndolaYard }], rate: usd(1_150_00) },
        { customerId: ids.lake, lines: [{ productId: ids.diesel50, plannedQty: 6000 }], consignor: { name: 'Lusaka fuel depot' }, consignee: { name: 'Lake Petroleum, Ndola', phone: '+260977450012' }, legs: [{ kind: 'pickup', placeId: ids.depot }, { kind: 'drop', placeId: ids.ndolaYard }], rate: usd(420_00) },
      ],
    }), ops);
    const tripId = String(trip.id);
    created += 4;
    await Trips.dispatchTrip(tripId, ops);
    const onTrip = async () => (await Consignments.listConsignments(S.consignmentsQuery.parse({ tripId, limit: 50 }), ops)).data as unknown as Array<{ id: string; version: number; lines: Array<{ id: string; productId: string }>; legs: Array<{ id: string; kind: string; status: string; stopId?: string; placeId?: string; planned?: Array<{ lineId: string; qty: number }> }> }>;
    const record = async (stopId: string, qty: (c: Awaited<ReturnType<typeof onTrip>>[number], leg: { id: string; kind: string; planned?: Array<{ qty: number }> }) => number) => {
      for (const c of await onTrip()) {
        for (const leg of c.legs.filter((l) => l.stopId === stopId && l.status === 'planned')) {
          const q = qty(c, leg);
          const petrol = c.lines[0]!.productId === ids.ulp95;
          await Consignments.recordLeg(c.id, leg.id, S.legRecordSchema.parse({
            measures: [{ lineId: c.lines[0]!.id, qty: q, ambientL: q, tempC: leg.kind === 'pickup' ? 20 : 23, density: petrol ? 745 : 835 }],
            ...(leg.kind === 'pickup' ? { documents: [{ number: `INV-S${c.id.slice(-4).toUpperCase()}` }] } : { pod: { number: `POD-S${leg.id.slice(-4).toUpperCase()}`, receivedBy: 'Depot storeman' } }),
          }), ops);
        }
      }
    };
    const stops = (await Trips.getTrip(tripId) as { stops: Array<{ id: string; kind: string; placeId: string }> }).stops;
    // Every stop in order: each pickup and drop recorded where it is planned; the split decided at the border.
    for (const stop of stops) {
      if (stop.kind === 'border') {
        await Trips.arriveAtStop(tripId, stop.id, ops);
        // After the border, Zambezi asks for 8,000 L of its diesel at Ndola: the delivery is split.
        const diesel = (await onTrip()).find((c) => c.lines[0]!.productId === ids.diesel50 && c.legs.some((l) => l.kind === 'pickup' && l.placeId === ids.darPort))!;
        const line = diesel.lines[0]!.id;
        const pickup = diesel.legs.find((l) => l.kind === 'pickup')!;
        await Consignments.putLegs(diesel.id, S.putLegsSchema.parse({
          version: diesel.version,
          legs: [{ id: pickup.id, kind: 'pickup', placeId: ids.darPort }, { kind: 'drop', placeId: ids.depot, planned: [{ lineId: line, qty: 12000 }] }, { kind: 'drop', placeId: ids.ndolaYard, planned: [{ lineId: line, qty: 8000 }] }],
        }), ops);
      }
      // Loaded as planned; a few litres short at each drop, within the allowance.
      if (stop.kind === 'load' || stop.kind === 'offload') await record(stop.id, (c, leg) => (leg.planned?.[0]?.qty ?? Number((c.lines[0] as { plannedQty?: number }).plannedQty)) - (leg.kind === 'drop' ? 12 : 0));
    }
    await Trips.endTrip(tripId, { closingFuelL: 180 }, ops);
    created += 1;
  }

  const settle = async (driver: string, tripIds: string[], keepMinor: number, note: string) => {
    const { balanceMinor } = await Settlements.getAccount(ids[driver]!);
    await Settlements.postSettlement(S.settlementSchema.parse({ driverId: ids[driver], tripIds, cashMinor: balanceMinor - keepMinor, note }), fin);
    created += 1;
  };

  const dieselLoad = (invoiceNo: string, tempC = 28) => ({ invoiceNo, consignor: 'Kurasini Oil Jetty Terminal', qty: 38000, tempC, density: 835 });
  const petrolLoad = (invoiceNo: string) => ({ invoiceNo, consignor: 'Kurasini Oil Jetty Terminal', qty: 36000, tempC: 29, density: 745 });
  const copperLoad = (invoiceNo: string) => ({ invoiceNo, consignor: 'Copperbelt Minerals plc, Kitwe refinery', qty: 30 });
  const roadCosts: Receipt[] = [
    { item: 'Toll at Tunduma', category: 'ecRoad', amount: 250, docNo: 'TL-20871' },
    { item: 'Meals and lodging, 4 nights', category: 'ecSubsistence', amount: 720, docNo: 'GH-1187' },
  ];

  // Settled: delivered within the allowance, the cash handed back in full.
  const a = await runTrip({ vehicle: 'v3', trailer: 't3', driver: 'd3', customer: 'zambezi', route: 'routeDar', product: 'diesel50', startsInDays: -24, until: 'ended', load: dieselLoad('INV-40112'), delivered: { podNo: 'POD-51012', share: 0.998 }, receipts: roadCosts });
  await settle('d3', [a.tripId], 0, 'Cash handed back at the Lusaka office');

  // Two trips settled together: one short beyond the allowance (charged), part of the cash carried forward.
  const b1 = await runTrip({ vehicle: 'v4', trailer: 't4', driver: 'd4', customer: 'lake', route: 'routeDar', product: 'ulp95', startsInDays: -21, until: 'ended', load: petrolLoad('INV-40177'), delivered: { podNo: 'POD-51088', share: 0.994 }, shortage: 'charge', receipts: roadCosts.slice(0, 1) });
  const b2 = await runTrip({ vehicle: 'v4', trailer: 't4', driver: 'd4', customer: 'zambezi', route: 'routeDar', product: 'diesel50', startsInDays: -12, until: 'ended', load: dieselLoad('INV-40391', 27), delivered: { podNo: 'POD-51240', share: 0.999 }, receipts: roadCosts });
  await settle('d4', [b1.tripId, b2.tripId], 1000_00, 'K 1,000 kept for the next trip');

  // Settled with the company owing the driver: road costs above the advance, paid out.
  const c = await runTrip({
    vehicle: 'v5', trailer: 't5', driver: 'd5', customer: 'copper', route: 'routeCopper', product: 'cuCathodes', tripType: 'ttGeneral', startsInDays: -15, until: 'ended', load: copperLoad('CBM-DN-7781'), delivered: { podNo: 'DAR-GRN-30412' },
    receipts: [...roadCosts, { item: 'Clearing at Tunduma', category: 'ecRoad', amount: 160, currency: 'USD', docNo: 'TCF-5520' }, { item: 'Port gate fee', category: 'ecRoad', amount: 1850, docNo: 'TPA-88123' }],
  });
  await settle('d5', [c.tripId], 0, 'Paid to the driver by Airtel Money');

  // Ended and waiting for settlement; the shortage waived with a reason.
  await runTrip({ vehicle: 'v6', trailer: 't6', driver: 'd6', customer: 'katanga', route: 'routeLub', product: 'diesel50', startsInDays: -9, until: 'ended', load: dieselLoad('INV-40455'), delivered: { podNo: 'POD-LUB-2231', share: 0.993 }, shortage: { waive: 'Meter at the Lubumbashi depot under repair; the customer accepted the loading figures' }, receipts: roadCosts });
  await Settlements.requestSettlement(ids.d6!, ops);

  // On the road: loaded, through the border, a receipt returned to the driver and sent again.
  const e = await runTrip({ vehicle: 'v7', trailer: 't7', driver: 'd7', customer: 'zambezi', route: 'routeDar', product: 'diesel50', startsInDays: -3, until: 'loaded', load: dieselLoad('INV-40610', 26), receipts: [{ ...roadCosts[0]!, recorded: false }] });
  await Cargo.returnDocument(e.unrecorded[0]!, { reason: 'The photo is blurred. Please send the toll receipt again.' }, fin);
  await receipt('d7', e.tripId, roadCosts[0]!, 1);

  // Dispatched, and the loading invoice waiting for Operations to confirm the figures.
  const g = await runTrip({ vehicle: 'v8', trailer: 't8', driver: 'd8', customer: 'katanga', route: 'routeLub', product: 'ulp95', startsInDays: -1, until: 'dispatched' });
  await sendDoc('d8', g.tripId, 'loading', { docNo: 'INV-40702', productId: ids.ulp95, consignor: 'Kurasini Oil Jetty Terminal', qty: 36000, ambientL: 36000, tempC: 30, density: 745 });

  // Planned: fuel approved and waiting to be paid; cash above budget approved by Finance, waiting for the Owner.
  const h = await runTrip({ vehicle: 'v9', trailer: 't9', driver: 'd9', customer: 'lake', route: 'routeLub', product: 'ulp95', startsInDays: 1, until: 'planned' });
  const fuel = await Funding.createRequest(S.createRequestSchema.parse({ tripId: h.tripId, kind: 'fuel', litres: 600 }), ops);
  await Funding.decideRequest(String(fuel.id), { approve: true }, fin);
  const cash = await Funding.createRequest(S.createRequestSchema.parse({ tripId: h.tripId, kind: 'cash', amount: { amountMinor: 12_500_00, currencyId: ids.ZMW }, reason: 'Kasumbalesa clearing fees went up this month' }), ops);
  await Funding.decideRequest(String(cash.id), { approve: true, note: 'Checked with the clearing agent' }, fin);
  created += 2;

  // Planned, nothing asked for yet.
  await runTrip({ vehicle: 'v10', trailer: 't10', driver: 'd10', customer: 'mpika', route: 'routeCopper', product: 'cuCathodes', tripType: 'ttGeneral', startsInDays: 2, until: 'planned' });

  // Several consignments on one truck (#135): two load at Dar es Salaam, one more at Lusaka; the diesel is split late
  // between Lusaka and Ndola; each priced at the rate agreed with its customer; run to the end.
  await sharedTrip();

  // Trucks ready at their yards, and a nomination sent to a customer, waiting for the reply.
  await Trips.correctVehicleState(ids.v1!, { placeId: ids.depot, fuelL: 320 }, ops);
  await Trips.correctVehicleState(ids.v2!, { placeId: ids.ndolaYard, fuelL: 280 }, ops);
  const nomination = await Nominations.createNomination(S.nominationSchema.parse({ customerId: ids.copper, orderSourceId: ids.direct, loadingPlaceId: ids.kitweRefinery, productId: ids.cuCathodes, qtyPerTruck: 30, requiredDate: days(3).slice(0, 10), trucks: [{ vehicleId: ids.v2, driverId: ids.d2 }] }), ops);
  await Nominations.sendNomination(String(nomination.id), ops);
  created += 1;
  return created;
}
