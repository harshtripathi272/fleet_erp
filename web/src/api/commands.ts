import type { Action, AppData, Extracted, Role } from "../domain/types";
import { api } from "./client";
import type { Rec } from "./adapter";

/**
 * Runs a desk action against the API. Actions keep the shape the screens and the WhatsApp buttons
 * already use; this maps each to its endpoint, turning amounts into minor units and currency codes into ids.
 */
export class Refusal extends Error {}

const viaOf = (v?: string) => (v === "WhatsApp" ? "whatsapp" : "app");

function currency(data: AppData, code: string) {
  const found = data.currencies?.find((c) => c.code === code.toUpperCase());
  if (!found) throw new Refusal(`Add the ${code} currency under Masters first.`);
  return found;
}
const money = (data: AppData, amount: number, code: string) => {
  const c = currency(data, code);
  return { amountMinor: Math.round(amount * 10 ** c.minorUnits), currencyId: c.id };
};

/** The payment method a button or form names, by id or by name. */
function paymentMethod(data: AppData, medium?: string, id?: string) {
  if (id) return data.paymentMethods?.find((m) => m.id === id);
  const name = medium?.trim().toLowerCase();
  return data.paymentMethods?.find((m) => m.name.toLowerCase() === name);
}

const blank = <T>(v: T | "" | undefined | null) => (v === "" || v === undefined ? undefined : v ?? undefined);
const clean = (body: Rec) => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

function reading(read?: Extracted) {
  if (!read) return undefined;
  const { currency: code, ...rest } = read;
  return clean({ ...rest, currencyCode: code });
}

export async function runCommand(action: Action, ctx: { data: AppData; role: Role; meId: string }): Promise<void> {
  const { data, role } = ctx;
  switch (action.type) {
    /* Nominations */
    case "nomination.save": {
      const source = data.orderSources?.find((s) => s.name === action.source) ?? data.orderSources?.[0];
      const body = clean({
        customerId: action.customerId, orderSourceId: source?.id, reference: blank(action.reference?.trim()), loadingPlaceId: action.loadingPlaceId,
        productId: blank(action.productId), qtyPerTruck: blank(action.qtyPerTruck), requiredDate: action.requiredDate,
        trucks: action.trucks.map((t) => clean({ vehicleId: t.truckId, driverId: blank(t.driverId) })), note: blank(action.note?.trim()),
      });
      if (action.id) {
        const version = data.nominations.find((n) => n.id === action.id)?.version ?? 0;
        await api(`/nominations/${action.id}`, { method: "PATCH", body: { ...body, version } });
      } else await api("/nominations", { method: "POST", body });
      return;
    }
    case "nomination.send": await api(`/nominations/${action.id}/send`, { method: "POST" }); return;
    case "nomination.accept": await api(`/nominations/${action.id}/accept`, { method: "POST", body: {} }); return;
    case "customer.reply": await api(`/nominations/${action.nominationId}/accept`, { method: "POST", body: { customerReply: true } }); return;
    case "nomination.convert": await api(`/nominations/${action.id}/convert`, { method: "POST", body: clean({ routeId: blank(action.routeId), offloadPlaceId: blank(action.offloadPlaceId) }) }); return;
    case "nomination.cancel": await api(`/nominations/${action.id}/cancel`, { method: "POST" }); return;

    /* Trips */
    case "trip.create":
      await api("/trips", {
        method: "POST",
        body: clean({
          customerId: action.customerId, vehicleId: action.truckId, driverId: blank(action.driverId), trailerId: blank(action.trailerId),
          routeId: blank(action.routeId), stops: action.stops, plannedStart: new Date(action.plannedStart).toISOString(),
          productId: blank(action.productId), plannedQty: blank(action.plannedQty),
        }),
      });
      return;
    case "trip.update": {
      const trip = data.trips.find((t) => t.id === action.tripId);
      const nullable = (v: string | undefined) => (v === undefined ? undefined : v || null);
      await api(`/trips/${action.tripId}`, {
        method: "PATCH",
        body: clean({
          version: trip?.version ?? 0, customerId: blank(action.customerId), driverId: nullable(action.driverId), trailerId: nullable(action.trailerId),
          routeId: nullable(action.routeId), stops: action.stops, plannedStart: action.plannedStart ? new Date(action.plannedStart).toISOString() : undefined,
          productId: nullable(action.productId), plannedQty: action.plannedQty === undefined ? undefined : action.plannedQty || null,
          fuelBudgetL: action.fuelBudgetL, cashBudgetMinor: action.cashBudgetZmw === undefined ? undefined : Math.round(action.cashBudgetZmw * 10 ** (data.baseCurrency?.minorUnits ?? 2)),
        }),
      });
      return;
    }
    case "trip.cancel": await api(`/trips/${action.tripId}/cancel`, { method: "POST", body: { reason: action.reason.trim() } }); return;
    case "trip.dispatch": await api(`/trips/${action.tripId}/dispatch`, { method: "POST" }); return;
    case "trip.ping": await api(`/trips/${action.tripId}/position`, { method: "POST", body: { km: Math.max(0, action.km), speed: Math.max(0, Math.min(200, action.speed)) } }); return;
    case "trip.arrive": await api(`/trips/${action.tripId}/stops/${action.stopId}/arrive`, { method: "POST" }); return;
    case "trip.remind": await api(`/trips/${action.tripId}/remind`, { method: "POST" }); return;
    case "trip.end": await api(`/trips/${action.tripId}/end`, { method: "POST", body: { closingFuelL: action.closingFuelL } }); return;

    /* Money requests */
    case "request.create":
      await api("/fund-requests", {
        method: "POST",
        body: action.kind === "fuel"
          ? clean({ tripId: action.tripId, kind: "fuel", litres: action.amount, reason: blank(action.reason?.trim()) })
          : clean({ tripId: action.tripId, kind: "cash", amount: money(data, action.amount, action.currency), reason: blank(action.reason?.trim()) }),
      });
      return;
    case "request.decide": await api(`/fund-requests/${action.id}/decide`, { method: "POST", body: clean({ approve: action.approve, note: blank(action.note?.trim()), via: viaOf(action.via) }) }); return;
    case "request.issue": {
      const command = action as typeof action & { paymentMethodId?: string };
      const method = paymentMethod(data, action.medium, command.paymentMethodId);
      await api(`/fund-requests/${action.id}/issue`, {
        method: "POST",
        body: clean({ paymentMethodId: method?.id, medium: method ? undefined : blank(action.medium?.trim()), reference: blank(action.reference?.trim()), station: blank(action.station?.trim()), via: viaOf(action.via) }),
      });
      return;
    }
    case "request.cancel": await api(`/fund-requests/${action.id}/cancel`, { method: "POST" }); return;

    /* Driver documents, loading, delivery */
    case "doc.send": {
      const file = action.file ? clean({ name: action.file.name, mime: action.file.mime, sampleId: action.file.sampleId, dataUrl: action.file.dataUrl }) : undefined;
      // The driver's own phone (the simulated WhatsApp) goes in as the driver; the office files for them.
      if (role === "driver" || action.channel === "WhatsApp") {
        await api("/whatsapp/simulate", { method: "POST", body: clean({ driverId: action.driverId, tripId: blank(action.tripId), kind: action.kind, text: blank(action.note?.trim()), file, reading: reading(action.read) }) });
      } else {
        await api("/driver-documents", { method: "POST", body: clean({ driverId: action.driverId, tripId: blank(action.tripId), kind: action.kind, note: blank(action.note?.trim()), file, reading: reading(action.read), channel: action.channel === "App" ? "app" : "operations" }) });
      }
      return;
    }
    case "doc.return": await api(`/driver-documents/${action.docId}/return`, { method: "POST", body: { reason: action.reason.trim() } }); return;
    case "load.record":
      await api("/consignments", {
        method: "POST",
        body: clean({ tripId: action.tripId, docId: blank(action.docId), productId: action.productId, invoiceNo: action.invoiceNo.trim(), consignor: action.consignor, consignee: action.consignee, qty: action.qty, ambientL: blank(action.ambientL), tempC: action.tempC ?? undefined, density: action.density ?? undefined, certStd20L: blank(action.certStd20L) }),
      });
      return;
    case "delivery.record":
      await api(`/consignments/${action.consignmentId}/delivery`, {
        method: "POST",
        body: clean({ docId: blank(action.docId), podNo: action.podNo.trim(), qty: action.qty, ambientL: blank(action.ambientL), tempC: action.tempC ?? undefined, density: action.density ?? undefined, certStd20L: blank(action.certStd20L) }),
      });
      return;
    case "shortage.decide": await api(`/consignments/${action.consignmentId}/shortage-decision`, { method: "POST", body: clean({ charge: action.charge, note: blank(action.note?.trim()), via: viaOf(action.via) }) }); return;

    /* Expenses and settlement */
    case "expense.record":
      await api("/expenses", {
        method: "POST",
        body: clean({ driverId: action.driverId, tripId: blank(action.tripId), categoryId: action.categoryId, amount: money(data, action.amount, action.currency), receiptNo: blank(action.receiptNo?.trim()), docId: blank(action.docId), note: blank(action.note?.trim()) }),
      });
      return;
    case "expense.decide": await api(`/expenses/${action.id}/decide`, { method: "POST", body: clean({ approve: action.approve, reason: blank(action.reason?.trim()), via: viaOf(action.via) }) }); return;
    case "settlement.request": await api(`/driver-accounts/${action.driverId}/settlement-request`, { method: "POST" }); return;
    case "settlement.post":
      await api("/settlements", { method: "POST", body: clean({ driverId: action.driverId, tripIds: action.tripIds, cashMinor: Math.round(action.cashZmw * 10 ** (data.baseCurrency?.minorUnits ?? 2)), note: blank(action.note?.trim()) }) });
      return;

    /* Messages */
    case "thread.read": {
      // A desk's phone shows several work threads under the desk's name; mark each read.
      const real = new Set(data.messages.filter((m) => m.thread === action.thread).map((m) => m.realThread ?? m.thread));
      if (!real.size) real.add(action.thread);
      for (const thread of real) if (/^(queue|role|user|driver|customer):/.test(thread)) await api("/messages/read", { method: "POST", body: { thread } });
      return;
    }
    case "chat.send": {
      const text = action.text.trim();
      if (!text) throw new Refusal("Type a message.");
      if (action.thread.startsWith("driver:") && role === "driver") {
        await api("/whatsapp/simulate", { method: "POST", body: { driverId: action.thread.slice(7), text } });
      } else {
        // Writing in a desk's own thread goes to the person's own work thread.
        const thread = /^(queue|role|user|driver|customer):/.test(action.thread) ? action.thread : `user:${ctx.meId}`;
        await api("/messages", { method: "POST", body: { thread, text } });
      }
      return;
    }

    /* Masters and configuration have their own screens on the API. */
    default:
      throw new Refusal("Change this under Masters.");
  }
}
