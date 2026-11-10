import { useHeldTrucks } from "../api/areas";
import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api/client";
import { useApp } from "../store";
import { byId, fuelEstimate, leg, stopsFromTruck, validateStops } from "../domain/calc";
import { activeTrip, placeName } from "../domain/helpers";
import type { RouteStop, Truck } from "../domain/types";
import { usePlacement } from "./usePlacement";
import { Button, Drawer, Field, Status } from "../ui/kit";
import { fromLocalInput, km, L, localInput, inBase } from "../ui/format";
import { StopEditor } from "./stages";
import { MiniRoute } from "../tracking/MiniRoute";
import { wl } from "../domain/words";
import { AddNew, FirstTripSteps } from "./firstTrip";
import { capacityLine, ConsignmentRows, consignmentBody, draftConsignment, draftProblem, isEmptyDraft, type DraftConsignment } from "../consignments/ConsignmentRows";

/** Truck first: pick the truck, its driver and trailer follow, the route starts where it stands. */
export function NewTrip({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { data, run } = useApp();
  const busy = useMemo(() => new Set(data.trips.filter(activeTrip).flatMap((t) => [t.truckId, t.driverId, t.trailerId])), [data.trips]);
  const free = data.trucks.filter((t) => !busy.has(t.id));
  const company = usePlacement("trips", "create");
  const held = useHeldTrucks();
  const [truckId, setTruckId] = useState("");
  const truck = byId(data.trucks, truckId) as Truck | undefined;
  const [driverId, setDriverId] = useState("");
  const [trailerId, setTrailerId] = useState("");
  const [customerId, setCustomerId] = useState(data.customers[0]?.id ?? "");
  const [routeId, setRouteId] = useState("");
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [drafts, setDrafts] = useState<DraftConsignment[]>(() => [draftConsignment()]);
  const [start, setStart] = useState(() => localInput(new Date(Date.now() + data.settings.clockOffsetMs + 36e5 * 2).toISOString()));
  useEffect(() => {
    if (!open) return;
    setTruckId("");
    setRouteId("");
    setStops([]);
    setDrafts([draftConsignment()]);
    setStart(localInput(new Date(Date.now() + data.settings.clockOffsetMs + 36e5 * 2).toISOString()));
  }, [open, data.settings.clockOffsetMs]);
  const pickTruck = (id: string) => {
    const t = byId(data.trucks, id);
    setTruckId(id);
    if (!t) return;
    setDriverId(t.driverId && !busy.has(t.driverId) ? t.driverId : "");
    setTrailerId(t.trailerId && !busy.has(t.trailerId) ? t.trailerId : "");
    const r = byId(data.routes, routeId);
    setStops(r ? stopsFromTruck(r.stops, t) : [{ placeId: t.placeId, kind: "start" }, { placeId: "", kind: "load" }, { placeId: "", kind: "offload" }, { placeId: "", kind: "end" }]);
  };
  const pickRoute = (id: string) => {
    setRouteId(id);
    const r = byId(data.routes, id);
    if (r && truck) {
      setStops(stopsFromTruck(r.stops, truck));
    }
  };
  const problem = validateStops(stops);
  const cargoProblem = drafts.map((d, i) => draftProblem(data, d, i + 1)).find(Boolean);
  const onBoard = capacityLine(data, drafts, truck, byId(data.trailers, trailerId));
  const preview = useMemo(() => {
    if (problem || !truck) return undefined;
    const s = stops.map((x, i) => ({ ...x, id: String(i), legKm: i ? leg(data, stops[i - 1].placeId, x.placeId).km : 0, legHours: 0 }));
    return { stops: s, km: s.reduce((a, b) => a + b.legKm, 0), fuel: byId(data.routes, routeId)?.fuelBudgetL ?? fuelEstimate({ stops: s }, truck) };
  }, [data, stops, truck, problem, routeId]);
  const create = async () => {
    if (!truck) return;
    if (
      await run(
        {
          type: "trip.create",
          custom: company.custom,
          customerId,
          truckId: truck.id,
          driverId: driverId || undefined,
          trailerId: trailerId || undefined,
          routeId: routeId || undefined,
          stops,
          plannedStart: fromLocalInput(start),
          consignments: drafts.filter((d) => !isEmptyDraft(d)).map(consignmentBody),
        },
        "Trip created. The driver has it on WhatsApp.",
      )
    ) {
      onClose();
      // The new trip is the truck's open one.
      const open = await api<{ id: string }[]>("/trips", { query: { vehicleId: truck.id, state: "open", limit: 1 } }).catch(() => []);
      if (open[0]) onCreated(open[0].id);
    }
  };
  return (
    <Drawer
      open={open}
      title={`New ${wl(data, "trip")}`}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!truck || !driverId || !customerId || Boolean(problem) || Boolean(cargoProblem) || (onBoard.refuse && onBoard.over.length > 0) || !company.ready} onClick={create}>
            <Check /> Create trip
          </Button>
        </>
      }
    >
      <div className="stack">
        {free.length === 0 && <p className="form-problem">{data.trucks.length ? "Every truck is on a trip right now." : "No trucks yet."}</p>}
        {!data.trucks.length && <FirstTripSteps />}
        <AddNew master="vehicles" what={wl(data, "truck")} onCreated={pickTruck} />
        <div className="truck-pick" role="radiogroup" aria-label="Truck">
          {free.map((t) => (
            <button key={t.id} role="radio" aria-checked={t.id === truckId} disabled={held.has(t.id)} className={`truck-tile ${t.id === truckId ? "on" : ""}`} onClick={() => pickTruck(t.id)}>
              <strong>{t.plate}</strong>
              <span>{placeName(data, t.placeId)}</span>
              {held.has(t.id) ? (
                <Status tone="wait">Held by {held.get(t.id)}</Status>
              ) : (
                <span className="muted">
                  {byId(data.trailers, t.trailerId)?.type ?? "No trailer"} · {L(t.fuelL)}
                </span>
              )}
            </button>
          ))}
        </div>
        {truck && company.block}
        {truck && (
          <>
            <div className="grid-2">
              <Field label="Driver">
                <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                  <option value="">Choose driver</option>
                  {data.drivers
                    .filter((d) => !busy.has(d.id))
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.id === truck.driverId ? " · usual" : ""}
                      </option>
                    ))}
                </select>
                <AddNew master="drivers" what={wl(data, "driver")} onCreated={setDriverId} />
              </Field>
              <Field label="Trailer">
                <select value={trailerId} onChange={(e) => setTrailerId(e.target.value)}>
                  <option value="">No trailer</option>
                  {data.trailers
                    .filter((t) => !busy.has(t.id))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.plate} · {t.type}
                        {t.id === truck.trailerId ? " · paired" : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Customer" hint={!data.customers.length ? `No ${wl(data, "customer", true)} yet: add one to start.` : undefined}>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  {!data.customers.length && <option value="">None yet</option>}
                  {data.customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <AddNew master="parties" what={wl(data, "customer")} initial={{ roles: ["customer"] }} onCreated={setCustomerId} />
              </Field>
              <Field label="Leaves">
                <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="Route">
                <select value={routeId} onChange={(e) => pickRoute(e.target.value)}>
                  <option value="">Custom stops</option>
                  {data.routes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <ConsignmentRows data={data} value={drafts} onChange={setDrafts} />
            {onBoard.text && <p className="framed-line">{onBoard.text}</p>}
            {onBoard.over.map((o) => <p key={o} className="form-problem">{o}{onBoard.refuse ? " Lower a quantity, or choose a bigger truck." : ""}</p>)}
            {cargoProblem && <p className="form-problem">{cargoProblem}</p>}
            <StopEditor stops={stops} onChange={setStops} startLocked={truck.placeId || undefined} />
            <AddNew master="places" what="place" />
            {preview && stops.find((x) => x.kind === "load")?.placeId === stops.find((x) => x.kind === "offload")?.placeId && (
              <p className="muted">Loading and offloading are at the same place. Check that's right.</p>
            )}
            {preview ? (
              <div className="route-summary">
                <MiniRoute stops={preview.stops} height={130} />
                <div className="route-numbers">
                  <div>
                    <span>Distance</span>
                    <strong>{km(preview.km)}</strong>
                  </div>
                  <div>
                    <span>Fuel budget</span>
                    <strong>{L(preview.fuel)}</strong>
                  </div>
                  <div>
                    <span>Cash budget</span>
                    <strong>{inBase(byId(data.routes, routeId)?.cashBudgetBase ?? 0)}</strong>
                  </div>
                </div>
              </div>
            ) : (
              <p className="form-problem">{problem}</p>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
