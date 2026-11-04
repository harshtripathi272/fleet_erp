import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import type { Action, Consignment, Trip } from "../domain/types";
import { activeTrip } from "../domain/helpers";
import { useApp } from "../store";
import { Button, Field, Modal, Segmented } from "../ui/kit";
import { zmw } from "../ui/format";

/** A loaded trip that can't deliver (#64): what the company allows, in its words. */
const OUTCOME_LABEL: Record<string, string> = { return: "Return it", transfer: "Move to another truck", write_off: "Write it off" };
const OUTCOME_LINE: Record<string, string> = {
  return: "The trip gets a return leg. It is delivered and closed the usual way when the load is back.",
  transfer: "This trip closes where the truck is. A new trip carries the same load and its measurements.",
  write_off: "The load is recorded as lost, its value goes where you choose, and this trip closes where the truck is.",
};
const CARRIER_LABEL: Record<string, string> = { driver: "The driver", company: "The company", insurance: "An insurance claim" };

export function CantDeliver({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const { data, run, me } = useApp();
  const { loadedTripOutcomes, writeOffCarriers, writeOffDefaultCarrier, writeOffNeedsOwner } = data.settings;
  const [outcome, setOutcome] = useState(loadedTripOutcomes[0] ?? "");
  const reached = [...trip.stops].reverse().find((s) => s.arrivedAt) ?? trip.stops[0];
  const loadStop = trip.stops.find((s) => s.kind === "load");
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [fuel, setFuel] = useState("");
  const [placeId, setPlaceId] = useState(reached?.placeId ?? "");
  const [returnPlaceId, setReturnPlaceId] = useState(loadStop?.placeId ?? "");
  const [truckId, setTruckId] = useState("");
  const [driverId, setDriverId] = useState(trip.driverId ?? "");
  const [trailerId, setTrailerId] = useState(trip.trailerId ?? "");
  const [carrier, setCarrier] = useState(writeOffDefaultCarrier);
  const [insurerId, setInsurerId] = useState("");
  const [claim, setClaim] = useState("");
  const [value, setValue] = useState("");
  const reasons = useQuery({ queryKey: ["trip-reasons"], queryFn: () => api<Rec[]>("/cancellation-reasons", { query: { appliesTo: "trip", status: "active", limit: 100 } }) });
  const insurers = useQuery({ queryKey: ["insurers"], enabled: outcome === "write_off", queryFn: () => api<Rec[]>("/parties", { query: { role: "insurer", status: "active", limit: 100 } }) });
  const busy = new Set(data.trips.filter((t) => activeTrip(t) && t.id !== trip.id).flatMap((t) => [t.truckId, t.driverId, t.trailerId]));
  const fuelOk = fuel !== "" && Number(fuel) >= 0;
  const ready = Boolean(reasonId) && (outcome === "return" || fuelOk) && (outcome !== "transfer" || (truckId && driverId)) && (outcome !== "write_off" || carrier !== "insurance" || insurerId);
  const isOwner = me.roles.some((r) => r === "owner" || r === "admin");
  const submit = async () => {
    const common = { type: "trip.undelivered" as const, tripId: trip.id, reasonId, note: note.trim() || undefined };
    const action: Action = outcome === "return"
      ? { ...common, outcome: "return", returnPlaceId }
      : outcome === "transfer"
        ? { ...common, outcome: "transfer", vehicleId: truckId, driverId, trailerId: trailerId || undefined, placeId, closingFuelL: Number(fuel) }
        : { ...common, outcome: "write_off", carrier, insurerPartyId: carrier === "insurance" ? insurerId : undefined, claimReference: claim.trim() || undefined, amount: value === "" ? undefined : Number(value), placeId, closingFuelL: Number(fuel) };
    const done = outcome === "write_off" && writeOffNeedsOwner && !isOwner ? "Sent to the owner for approval." : "Decided.";
    if (await run(action, done)) onClose();
  };
  return (
    <Modal
      open
      title={`${trip.no} can't deliver`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>Keep going</Button>
          <Button tone="primary" disabled={!ready} onClick={() => void submit()}>{outcome === "write_off" && writeOffNeedsOwner && !isOwner ? "Ask the owner" : OUTCOME_LABEL[outcome]}</Button>
        </>
      }
    >
      <div className="form-stack">
        <Segmented choice label="What happens to the load" value={outcome} options={loadedTripOutcomes.map((o) => ({ value: o, label: OUTCOME_LABEL[o] ?? o }))} onChange={setOutcome} />
        <p className="muted">{OUTCOME_LINE[outcome]}</p>
        <Field label="Reason">
          <select value={reasonId} onChange={(e) => setReasonId(e.target.value)} autoFocus>
            <option value="">Choose…</option>
            {(reasons.data ?? []).map((r) => <option key={String(r.id)} value={String(r.id)}>{String(r.name)}</option>)}
          </select>
        </Field>
        <Field label="More detail">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened" />
        </Field>
        {outcome === "return" && (
          <Field label="Back to">
            <select value={returnPlaceId} onChange={(e) => setReturnPlaceId(e.target.value)}>
              {data.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {outcome === "transfer" && (
          <>
            <Field label="Other truck">
              <select value={truckId} onChange={(e) => setTruckId(e.target.value)}>
                <option value="">Choose…</option>
                {data.trucks.filter((t) => t.id !== trip.truckId && !busy.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.plate}</option>)}
              </select>
            </Field>
            <Field label="Driver">
              <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">Choose…</option>
                {data.drivers.filter((d) => !busy.has(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Trailer">
              <select value={trailerId} onChange={(e) => setTrailerId(e.target.value)}>
                <option value="">No trailer</option>
                {data.trailers.filter((t) => !busy.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.plate}</option>)}
              </select>
            </Field>
          </>
        )}
        {outcome === "write_off" && (
          <>
            <Field label="Who carries it">
              <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                {writeOffCarriers.map((c) => <option key={c} value={c}>{CARRIER_LABEL[c]}</option>)}
              </select>
            </Field>
            {carrier === "insurance" && (
              <>
                <Field label="Insurer">
                  <select value={insurerId} onChange={(e) => setInsurerId(e.target.value)}>
                    <option value="">Choose…</option>
                    {(insurers.data ?? []).map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>)}
                  </select>
                </Field>
                <Field label="Claim reference">
                  <input value={claim} onChange={(e) => setClaim(e.target.value)} />
                </Field>
              </>
            )}
            <Field label={`What the load is worth (${data.baseCurrency?.code ?? ""})`} hint="Empty: the product's shortage price times what was loaded.">
              <input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </>
        )}
        {outcome !== "return" && (
          <>
            <Field label="Where the truck is now">
              <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
                {data.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Fuel left in the tank (L)">
              <input type="number" min={0} value={fuel} onChange={(e) => setFuel(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/** What was decided, and the owner's Approve and Reject while a write-off waits. */
export function UndeliveredNote({ trip, load }: { trip: Trip; load?: Consignment }) {
  const { data, run, me, nav } = useApp();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const pending = load?.writeOff?.status === "pending" ? load.writeOff : undefined;
  const other = trip.transferredToTripId ?? trip.transferredFromTripId;
  const otherNo = data.trips.find((t) => t.id === other)?.no;
  const isOwner = me.roles.some((r) => r === "owner" || r === "admin");
  const said = trip.undelivered
    ? { return: `Load going back: ${trip.undelivered.reason}`, transfer: `Load moved to another truck: ${trip.undelivered.reason}`, write_off: `Load written off: ${trip.undelivered.reason}` }[trip.undelivered.outcome]
    : undefined;
  return (
    <>
      {said && <p className="drawer-note">{said}</p>}
      {other && otherNo && (
        <p className="drawer-note">
          {trip.transferredToTripId ? "The load went on as " : "Took over the load from "}
          <button className="link-btn" onClick={() => nav({ tripId: other })}>{otherNo}</button>
        </p>
      )}
      {load?.writeOff?.status === "rejected" && activeTrip(trip) && <p className="drawer-note">Not written off: {load.writeOff.note}</p>}
      {pending && (
        <div className="drawer-note undelivered-wait">
          <span>Write-off of {zmw(pending.amountZmw)} asked by {pending.requestedByName}, carried by {(CARRIER_LABEL[pending.carrier] ?? pending.carrier).toLowerCase()}: {pending.reason}. {isOwner ? "" : "Waiting for the owner."}</span>
          {isOwner && (
            <span className="row-buttons">
              <Button size="sm" tone="primary" onClick={() => void run({ type: "writeoff.decide", consignmentId: load!.id, approve: true }, "Written off.")}>Approve</Button>
              {rejecting
                ? (
                  <>
                    <input aria-label="Why not" placeholder="Why not?" value={note} onChange={(e) => setNote(e.target.value)} />
                    <Button size="sm" tone="danger" disabled={!note.trim()} onClick={() => void run({ type: "writeoff.decide", consignmentId: load!.id, approve: false, note: note.trim() }, "Not written off.")}>Reject</Button>
                  </>
                )
                : <Button size="sm" onClick={() => setRejecting(true)}>Reject</Button>}
            </span>
          )}
        </div>
      )}
    </>
  );
}
