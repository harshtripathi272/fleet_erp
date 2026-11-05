import { baseCurrencyCode, num } from "../ui/format";
import { byId, driverBalance, funding, volume20 } from "./calc";
import { closedAt, firstName, litres, money, placeName, toSettle, inBase } from "./helpers";
import type { AppData, Desk, Role, Trip } from "./types";
import { stageName, stageOn } from "./words";

export type StageId = "plan" | "funding" | "loading" | "transit" | "offloading" | "close" | "settle";
export const STAGES: { id: StageId; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "funding", label: "Funding" },
  { id: "loading", label: "Loading" },
  { id: "transit", label: "Transit" },
  { id: "offloading", label: "Offloading" },
  { id: "close", label: "Close" },
  { id: "settle", label: "Settlement" },
];

export type Actor = Desk | "driver" | "road" | "done";
export type Move =
  | "plan"
  | "request"
  | "approve"
  | "owner-approve"
  | "issue"
  | "dispatch"
  | "confirm-load"
  | "confirm-delivery"
  | "shortage"
  | "end"
  | "expenses"
  | "settle"
  | "none";

export interface NextStep {
  actor: Actor;
  stage: StageId;
  move: Move;
  /** Phrased for the person who acts. */
  title: string;
  /** Phrased for everyone else. */
  waiting: string;
  detail?: string;
  since?: string;
  refId?: string;
}

export const ACTOR_NAME: Record<Actor, string> = {
  owner: "Owner",
  operations: "Operations",
  finance: "Finance",
  driver: "Driver",
  road: "On the road",
  done: "Complete",
};

export function isMine(step: NextStep, role: Role) {
  if (step.actor === role) return true;
  if (role === "owner" && (step.actor === "finance" || step.actor === "operations")) return false;
  return false;
}

/** The stages the company works (#73), under its own names, in their fixed physical order. */
export function visibleStages(data: AppData): { id: StageId; label: string }[] {
  return STAGES.filter((s) => stageOn(data, s.id)).map((s) => ({ id: s.id, label: stageName(data, s.id) }));
}

/**
 * The trip's next step, for a company that may not work every stage: without Funding, dispatch belongs to the
 * plan; without Settlement, a closed trip is complete.
 */
export function nextStep(data: AppData, trip: Trip): NextStep {
  const step = workedStep(data, trip);
  if (step.stage === "funding" && !stageOn(data, "funding")) return { ...step, stage: "plan" };
  if (step.stage === "settle" && !stageOn(data, "settle")) return { actor: "done", stage: "close", move: "none", title: "Complete", waiting: "Complete", since: step.since };
  return step;
}

function workedStep(data: AppData, trip: Trip): NextStep {
  const driver = byId(data.drivers, trip.driverId);
  const who = firstName(driver?.name) || "The driver";
  const load = trip.stops.find((s) => s.kind === "load");
  const offload = trip.stops.find((s) => s.kind === "offload");
  const requests = data.requests.filter((r) => r.tripId === trip.id);
  const consignments = data.consignments.filter((c) => c.tripId === trip.id);
  const docs = data.docs.filter((d) => d.tripId === trip.id && d.status === "new");

  if (trip.cancelledAt)
    return { actor: "done", stage: "plan", move: "none", title: "Cancelled", waiting: "Cancelled", since: trip.cancelledAt };

  if (!trip.driverId || trip.stops.length < 2)
    return {
      actor: "operations",
      stage: "plan",
      move: "plan",
      title: !trip.driverId ? "Assign the driver" : "Set the route",
      waiting: "Operations is planning this trip",
      since: trip.createdAt,
    };

  if (!trip.dispatchedAt) {
    const owner = requests.find((r) => r.status === "owner");
    const pending = requests.find((r) => r.status === "pending");
    const approved = requests.find((r) => r.status === "approved");
    const describe = (r: (typeof requests)[number]) =>
      `${r.kind === "fuel" ? "fuel" : "advance"} ${r.kind === "fuel" ? litres(r.amount) : money(r.amount, r.currency)}`;
    if (pending)
      return {
        actor: "finance",
        stage: "funding",
        move: "approve",
        title: `Approve the ${describe(pending)}`,
        waiting: `${pending.waitingOn ?? "Finance"} is approving the ${describe(pending)}`,
        detail: pending.no,
        since: pending.createdAt,
        refId: pending.id,
      };
    if (owner)
      return {
        actor: "owner",
        stage: "funding",
        move: "owner-approve",
        title: `Approve the ${describe(owner)}`,
        waiting: `${owner.waitingOn ?? "The next approver"} is approving the ${describe(owner)}`,
        detail: owner.reason,
        since: owner.trail.at(-1)?.at,
        refId: owner.id,
      };
    if (approved)
      return {
        actor: "finance",
        stage: "funding",
        move: "issue",
        title: `Pay the ${describe(approved)}`,
        waiting: `Finance is paying the ${describe(approved)}`,
        detail: approved.no,
        since: approved.trail.at(-1)?.at,
        refId: approved.id,
      };
    const f = funding(data, trip);
    const issued = requests.some((r) => r.status === "issued");
    // A company that doesn't fund trips (Funding off) goes straight from the plan to dispatch.
    if (!issued && stageOn(data, "funding") && (f.fuel.suggested > 0 || f.cash.suggested > 0))
      return {
        actor: "operations",
        stage: "funding",
        move: "request",
        title: f.fuel.suggested && f.cash.suggested ? "Request fuel and advance" : f.fuel.suggested ? "Request fuel" : "Request the advance",
        waiting: "Operations is preparing the funding request",
        detail: [f.fuel.suggested ? litres(f.fuel.suggested) : "", f.cash.suggested ? inBase(f.cash.suggested) : ""]
          .filter(Boolean)
          .join(" and "),
        since: trip.createdAt,
      };
    return {
      actor: "operations",
      stage: "funding",
      move: "dispatch",
      title: "Dispatch the truck",
      waiting: "Ready to leave",
      detail: `${who} leaves ${placeName(data, trip.stops[0].placeId)} with ${litres(byId(data.trucks, trip.truckId)?.fuelL ?? 0)} in the tank and ${inBase(Math.max(0, f.cash.holds) + f.cash.issued)} cash`,
      since: requests.filter((r) => r.issuedAt).map((r) => r.issuedAt!).sort().at(-1) ?? trip.createdAt,
    };
  }

  if (!trip.endedAt) {
    const loaded = consignments.length > 0;
    if (!loaded) {
      const doc = docs.find((d) => d.kind === "loading");
      if (doc)
        return {
          actor: "operations",
          stage: "loading",
          move: "confirm-load",
          title: "Confirm the loading",
          waiting: "Operations is checking the loading invoice",
          detail: `${who} sent ${doc.read?.docNo ?? "the invoice"}`,
          since: doc.at,
          refId: doc.id,
        };
      if (load?.arrivedAt)
        return {
          actor: "driver",
          stage: "loading",
          move: "none",
          title: "Send the loading invoice",
          waiting: `Waiting for ${who}'s loading invoice`,
          detail: `At ${placeName(data, load.placeId)}`,
          since: load.arrivedAt,
        };
      return {
        actor: "road",
        stage: "loading",
        move: "none",
        title: `Driving to ${placeName(data, load?.placeId)}`,
        waiting: `Driving to ${placeName(data, load?.placeId)}`,
        detail: "Empty",
        since: trip.dispatchedAt,
      };
    }
    const open = consignments.find((c) => !c.delivered);
    if (open) {
      const doc = docs.find((d) => d.kind === "delivery");
      if (doc)
        return {
          actor: "operations",
          stage: "offloading",
          move: "confirm-delivery",
          title: "Confirm the delivery",
          waiting: "Operations is checking the delivery note",
          detail: `${who} sent ${doc.read?.docNo ?? "the delivery note"}`,
          since: doc.at,
          refId: doc.id,
        };
      if (offload?.arrivedAt)
        return {
          actor: "driver",
          stage: "offloading",
          move: "none",
          title: "Send the delivery note",
          waiting: `Waiting for ${who}'s delivery note`,
          detail: `At ${placeName(data, offload.placeId)}`,
          since: offload.arrivedAt,
        };
      const product = byId(data.products, open.productId);
      return {
        actor: "road",
        stage: "transit",
        move: "none",
        title: `Driving to ${placeName(data, offload?.placeId)}`,
        waiting: `Driving to ${placeName(data, offload?.placeId)}`,
        detail: `${product?.kind === "fuel" ? litres(volume20(open.load) ?? open.load.qty) + " at 20 °C" : `${open.load.qty} ${open.load.unit}`} of ${product?.name.toLowerCase()}`,
        since: open.loadedAt,
      };
    }
    const end = trip.stops.at(-1)!;
    return {
      actor: "operations",
      stage: "close",
      move: "end",
      title: "End the trip and free the truck",
      waiting: "Operations is closing the trip",
      detail: `Record the fuel left in the tank at ${placeName(data, end.placeId)}`,
      since: consignments.map((c) => c.delivered?.at ?? "").sort().at(-1),
    };
  }

  if (trip.settlementId) {
    const s = byId(data.settlements, trip.settlementId);
    return {
      actor: "done",
      stage: "settle",
      move: "none",
      title: "Settled",
      waiting: "Settled",
      detail: s ? `In ${s.no}` : undefined,
      since: s?.postedAt,
    };
  }
  const shortage = consignments.find((c) => c.shortage?.status === "pending");
  if (shortage)
    return {
      actor: "finance",
      stage: "settle",
      move: "shortage",
      title: shortage.shortage!.unit === "L" ? "Decide the fuel shortage" : "Decide the shortage",
      waiting: shortage.shortage!.unit === "L" ? "Finance is reviewing the fuel shortage" : "Finance is reviewing the shortage",
      detail: `${shortage.shortage!.unit === "L" ? litres(shortage.shortage!.netShortL) : `${num(shortage.shortage!.netShortL, 0, 2)} ${shortage.shortage!.unit}`} beyond the allowance · ${inBase(shortage.shortage!.amountBase)}`,
      since: shortage.delivered?.at,
      refId: shortage.id,
    };
  const pendingExpenses = data.expenses.filter((e) => e.tripId === trip.id && e.status === "pending");
  const receipts = data.docs.filter((d) => d.tripId === trip.id && d.status === "new" && (d.kind === "expense" || d.kind === "fuel"));
  if (pendingExpenses.length || receipts.length)
    return {
      actor: "finance",
      stage: "settle",
      move: "expenses",
      title: "Check the driver's receipts",
      waiting: "Finance is checking receipts",
      detail: `${pendingExpenses.length + receipts.length} to check`,
      since: [...pendingExpenses.map((e) => e.at), ...receipts.map((d) => d.at)].sort()[0],
    };
  return {
    actor: "finance",
    stage: "settle",
    move: "settle",
    title: `Settle ${who}'s account`,
    waiting: `Waiting for ${who}'s settlement`,
    detail: driver ? `Balance ${inBase(driverBalance(data, driver.id))}` : undefined,
    since: trip.endedAt,
  };
}

/** Where a stage sits among the stages the company works; with no data, among all of them. */
export function stageIndex(stage: StageId, data?: AppData) {
  return (data ? visibleStages(data) : STAGES).findIndex((s) => s.id === stage);
}

/** When each stage finished, for the stepper. */
export function stageTimes(data: AppData, trip: Trip): Partial<Record<StageId, string>> {
  const out: Partial<Record<StageId, string>> = {};
  const consignments = data.consignments.filter((c) => c.tripId === trip.id);
  if (trip.driverId && trip.stops.length) out.plan = trip.createdAt;
  if (trip.dispatchedAt) out.funding = trip.dispatchedAt;
  if (consignments.length) out.loading = consignments[0].loadedAt;
  const delivered = consignments.length && consignments.every((c) => c.delivered);
  const offload = trip.stops.find((s) => s.kind === "offload");
  if (offload?.arrivedAt && consignments.length) out.transit = offload.arrivedAt;
  if (delivered) out.offloading = consignments.map((c) => c.delivered!.at).sort().at(-1);
  if (trip.endedAt) out.close = trip.endedAt;
  if (trip.settlementId) out.settle = byId(data.settlements, trip.settlementId)?.postedAt;
  return out;
}

/** Everything waiting on a desk, across trips and accounts. */
export interface QueueItem {
  key: string;
  tripId?: string;
  driverId?: string;
  docId?: string;
  title: string;
  detail: string;
  since?: string;
  move: Move | "receipt";
}

export function queueFor(data: AppData, desk: Desk): QueueItem[] {
  const items: QueueItem[] = [];
  for (const trip of data.trips) {
    const step = nextStep(data, trip);
    const truck = byId(data.trucks, trip.truckId);
    const mine = step.actor === desk || (desk === "owner" && step.actor === "owner");
    if (!mine) continue;
    if (desk === "finance" && (step.move === "settle" || step.move === "expenses")) continue;
    items.push({
      key: `${trip.id}-${step.move}`,
      tripId: trip.id,
      title: step.title,
      detail: `${trip.no} · ${truck?.plate}${step.detail ? ` · ${step.detail}` : ""}`,
      since: step.since,
      move: step.move,
    });
  }
  if (desk === "finance" || desk === "owner") {
    if (desk === "finance") {
      for (const r of data.requests.filter((r) => r.status === "pending" || r.status === "approved")) {
        const trip = byId(data.trips, r.tripId)!;
        if (!trip.dispatchedAt) continue;
        items.push({
          key: r.id,
          tripId: trip.id,
          title: `${r.status === "pending" ? "Approve" : "Pay"} the ${r.kind === "fuel" ? "fuel" : "advance"} ${r.kind === "fuel" ? litres(r.amount) : money(r.amount, r.currency)}`,
          detail: `${trip.no} · on the road · ${r.reason ?? r.no}`,
          since: r.trail.at(-1)?.at,
          move: r.status === "pending" ? "approve" : "issue",
        });
      }
      for (const d of data.docs.filter((d) => d.status === "new" && (d.kind === "expense" || d.kind === "fuel"))) {
        const driver = byId(data.drivers, d.driverId);
        items.push({
          key: d.id,
          docId: d.id,
          tripId: d.tripId,
          driverId: d.driverId,
          title: `Check ${firstName(driver?.name)}'s receipt`,
          detail: `${d.read?.amount ? money(d.read.amount, d.read.currency ?? baseCurrencyCode()) : "Receipt"}${d.tripId ? ` · ${byId(data.trips, d.tripId)?.no}` : ""}`,
          since: d.at,
          move: "receipt",
        });
      }
      for (const e of data.expenses.filter((e) => e.status === "pending")) {
        const driver = byId(data.drivers, e.driverId);
        items.push({
          key: e.id,
          tripId: e.tripId,
          driverId: e.driverId,
          title: `Approve ${firstName(driver?.name)}'s ${byId(data.categories, e.categoryId)?.name.toLowerCase()}`,
          detail: `${money(e.amount, e.currency)} · ${e.no}`,
          since: e.at,
          move: "expenses",
        });
      }
      for (const driver of data.drivers) {
        const trips = data.trips.filter((t) => t.driverId === driver.id && toSettle(t));
        if (!trips.length) continue;
        items.push({
          key: `${driver.id}-settle`,
          driverId: driver.id,
          title: `Settle ${driver.name}`,
          detail: `${trips.length} closed trip${trips.length === 1 ? "" : "s"} · balance ${inBase(driverBalance(data, driver.id))}${driver.settleRequestedAt ? " · requested" : ""}`,
          since: driver.settleRequestedAt ?? trips.map((t) => closedAt(t)!).sort()[0],
          move: "settle",
        });
      }
    } else {
      for (const r of data.requests.filter((r) => r.status === "owner")) {
        const trip = byId(data.trips, r.tripId)!;
        if (!trip.dispatchedAt) continue;
        items.push({
          key: r.id,
          tripId: trip.id,
          title: `Approve the ${r.kind === "fuel" ? "fuel" : "advance"} ${r.kind === "fuel" ? litres(r.amount) : money(r.amount, r.currency)}`,
          detail: `${trip.no} · on the road · ${r.reason ?? ""}`,
          since: r.trail.at(-1)?.at,
          move: "owner-approve",
        });
      }
    }
  }
  if (desk === "operations") {
    for (const d of data.docs.filter((d) => d.status === "new" && (d.kind === "other" || !d.tripId))) {
      const driver = byId(data.drivers, d.driverId);
      items.push({
        key: d.id,
        docId: d.id,
        tripId: d.tripId,
        driverId: d.driverId,
        title: `Message from ${driver?.name}`,
        detail: d.note ?? "Photo",
        since: d.at,
        move: "receipt",
      });
    }
  }
  return items.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
}
