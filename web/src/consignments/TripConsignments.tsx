import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../api/client";
import { useApp } from "../store";
import { placeName } from "../domain/helpers";
import { byId } from "../domain/calc";
import { w, wl } from "../domain/words";
import type { AppData, Trip } from "../domain/types";
import { Button, Empty, Status } from "../ui/kit";
import { clockTime, day, km, num } from "../ui/format";
import { ConsignmentDrawer } from "./ConsignmentDrawer";
import { cnTotals, CN_STATUS_LABEL, cnStatusTone, REVENUE_LABEL, type Cn } from "./model";

/**
 * The trip's Consignments tab (#135, design 3.11.2): what is on board now, one row per consignment, and the route
 * with what happens at each stop. A row opens the consignment.
 */

const STOP_KIND: Record<string, string> = { start: "Start", load: "Loading", offload: "Offloading", border: "Border", via: "Via", end: "End" };

export const qtyText = (qty: number | undefined, unit: string) => (qty === undefined ? "—" : `${num(qty, 0, 3)} ${unit}`);

/** Money in minor units of a currency the app knows: "3,548.95 USD". */
export function moneyText(data: AppData, minor: number | undefined, currencyId?: string) {
  if (minor === undefined || minor === null) return "—";
  const c = data.currencies?.find((x) => x.id === currencyId);
  const units = c?.minorUnits ?? 2;
  return `${num(minor / 10 ** units, units, units)} ${c?.code ?? ""}`.trim();
}

/** "In", "Waiting" or "Not due": whether each drop done has its proof of delivery. */
export function podState(c: Cn): { label: string; tone: "ok" | "wait" | "mute" } {
  const done = c.legs.filter((l) => l.kind === "drop" && l.status === "done");
  if (!done.length) return { label: "Not due", tone: "mute" };
  return done.every((l) => l.pod?.number || l.pod?.docIds?.length) ? { label: "In", tone: "ok" } : { label: "Waiting", tone: "wait" };
}

/** First pickup → last drop, and how many more drops there are. */
export function cnRoute(data: AppData, c: Cn) {
  const pickups = c.legs.filter((l) => l.kind === "pickup");
  const drops = c.legs.filter((l) => l.kind === "drop" && l.status !== "skipped");
  const from = pickups[0]?.placeId ? placeName(data, pickups[0].placeId) : "To be confirmed";
  const last = drops[drops.length - 1];
  const to = last ? (last.placeId ? placeName(data, last.placeId) : "To be confirmed") : "—";
  return { from, to, more: Math.max(0, drops.length - 1) };
}

export function productText(data: AppData, c: Cn) {
  const first = byId(data.products, c.lines[0]?.productId)?.name ?? "—";
  return c.lines.length > 1 ? `${first} +${c.lines.length - 1}` : first;
}

export function TripConsignments({ trip }: { trip: Trip }) {
  const { data } = useApp();
  const [open, setOpen] = useState<string | "new" | null>(null);
  const list = data.cns.filter((c) => c.tripId === trip.id);
  const rules = data.settings.freight;
  const mayAdd = !trip.endedAt && !trip.cancelledAt && (!rules.maxConsignmentsPerTrip || list.length < rules.maxConsignmentsPerTrip);
  const capacity = useQuery({ queryKey: ["trip-capacity", trip.id, list.length, list.map((c) => c.version).join()], queryFn: () => api<Capacity>(`/trips/${trip.id}/capacity`).catch(() => null) });
  const seesMoney = list.some((c) => c.revenue);
  return (
    <section className="trip-consignments">
      <div className="cn-toolbar">
        {mayAdd && <Button onClick={() => setOpen("new")}><Plus size={15} /> Add {wl(data, "consignment")}</Button>}
        {capacity.data && <span className="cn-onboard">{onBoardText(capacity.data)}</span>}
      </div>
      {capacity.data?.notes?.map((n) => <p key={n} className="muted cn-note">{n}</p>)}

      {!list.length ? (
        <Empty title={`No ${wl(data, "consignment", true)} on this ${wl(data, "trip")} yet`}>
          {rules.consignmentBy === "loading" ? `Add one now, or at the loading stop.` : `The ${wl(data, "trip")} can't leave without one.`}
        </Empty>
      ) : (
        <div className="table-frame">
          <table className="table cn-table">
            <thead>
              <tr>
                <th>Number</th><th>Status</th><th>Consignor</th><th>Consignee</th><th>Goods</th>
                <th className="num">Planned</th><th className="num">Loaded</th><th className="num">Delivered</th>
                <th>From → To</th><th className="num">Lead</th><th>Papers</th>{seesMoney && <th className="num">Revenue</th>}<th>Proof of delivery</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const t = cnTotals(c);
                const r = cnRoute(data, c);
                const pod = podState(c);
                return (
                  <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                    <td className="mono">{c.number}</td>
                    <td><Status tone={cnStatusTone(c.status)}>{CN_STATUS_LABEL[c.status] ?? c.status}</Status></td>
                    <td className="cn-party">{c.consignorName}</td>
                    <td className="cn-party">{c.consigneeName}</td>
                    <td>{productText(data, c)}</td>
                    <td className="num">{qtyText(t.planned || undefined, t.unit)}</td>
                    <td className="num">{qtyText(t.loaded, t.unit)}</td>
                    <td className="num">{qtyText(t.delivered, t.unit)}</td>
                    <td>{r.from} → {r.to}{r.more ? <span className="muted"> +{r.more} {r.more === 1 ? "drop" : "drops"}</span> : null}</td>
                    <td className="num">{c.leadKm ? km(c.leadKm) : "—"}</td>
                    <td>{c.documents.length ? `${c.documents.length} ${c.documents.length === 1 ? "paper" : "papers"}` : <span className="muted">None yet</span>}</td>
                    {seesMoney && (
                      <td className="num">
                        {!c.revenue ? "—" : c.revenue.status === "unpriced" ? <span className="cn-unpriced">No price</span>
                          : <>{moneyText(data, c.revenue.totalMinor, c.revenue.currencyId)}{c.revenue.status === "estimated" && <span className="muted"> est.</span>}</>}
                      </td>
                    )}
                    <td><Status tone={pod.tone}>{pod.label}</Status></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RouteAndStops data={data} trip={trip} list={list} onOpen={setOpen} />
      {open && <ConsignmentDrawer id={open === "new" ? undefined : open} tripId={trip.id} onClose={() => setOpen(null)} />}
    </section>
  );
}

interface Capacity { limits: { kg?: number; l?: number }; onBoard: { kg: number; l: number }; planned?: { stopId: string; place: string; kg: number; l: number; over: boolean }[]; notes?: string[] }

function onBoardText(c: Capacity) {
  const parts: string[] = [];
  if (c.limits.kg || c.onBoard.kg) parts.push(`${num(c.onBoard.kg / 1000, 0, 2)} t${c.limits.kg ? ` of ${num(c.limits.kg / 1000, 0, 2)} t` : ""}`);
  if (c.limits.l || c.onBoard.l) parts.push(`${num(c.onBoard.l)} L${c.limits.l ? ` of ${num(c.limits.l)} L` : ""}`);
  return parts.length ? `On board now: ${parts.join(" · ")}` : "Nothing on board";
}

/** The trip's stops in order, each with the pickups and drops done or planned there (design 3.11.2, point 3). */
function RouteAndStops({ data, trip, list, onOpen }: { data: AppData; trip: Trip; list: Cn[]; onOpen: (id: string) => void }) {
  const legsAt = (stopId: string) => list.flatMap((c) => c.legs.filter((l) => l.stopId === stopId).map((l) => ({ c, l })));
  const unplaced = list.flatMap((c) => c.legs.filter((l) => !l.stopId && l.status !== "skipped").map((l) => ({ c, l })));
  const qty = (c: Cn, l: Cn["legs"][number]) => {
    const unit = c.lines[0]?.unit ?? "";
    const done = l.actual?.reduce((s, m) => s + (m.accepted ?? m.qty), 0);
    const planned = l.planned?.reduce((s, p) => s + (p.qty ?? 0), 0);
    return l.status === "done" ? qtyText(done, unit) : planned ? qtyText(planned, unit) : "";
  };
  return (
    <section className="cn-stops">
      <h3>Route and stops</h3>
      <ol className="cn-stop-list">
        {trip.stops.map((s, i) => (
          <li key={s.id}>
            <div className="cn-stop">
              <span className="cn-stop-n">{i + 1}</span>
              <strong>{placeName(data, s.placeId)}</strong>
              <span className="muted">{STOP_KIND[s.kind] ?? s.kind}</span>
              <span className="muted cn-stop-time">{s.arrivedAt ? `Arrived ${day(s.arrivedAt)} ${clockTime(s.arrivedAt)}` : ""}{s.leftAt ? ` · Left ${clockTime(s.leftAt)}` : ""}</span>
            </div>
            {legsAt(s.id).length > 0 && (
              <ul className="cn-stop-legs">
                {legsAt(s.id).map(({ c, l }) => (
                  <li key={l.id}>
                    <button className="link-btn mono" onClick={() => onOpen(c.id)}>{c.number}</button>
                    <span>{l.kind === "pickup" ? "Pickup" : "Drop"}</span>
                    <span className="num">{qty(c, l)}</span>
                    <Status tone={l.status === "done" ? "ok" : l.status === "skipped" ? "mute" : "wait"}>{l.status === "done" ? "Done" : l.status === "skipped" ? "Skipped" : "Planned"}</Status>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {unplaced.length > 0 && (
        <p className="muted">
          To be confirmed: {unplaced.map(({ c, l }, i) => <span key={l.id}>{i ? ", " : ""}{c.number} {l.kind === "drop" ? "drop" : "pickup"} {qty(c, l)}</span>)}.
        </p>
      )}
      <p className="muted">{w(data, "consignment", true)} add their own stops when their pickups and drops are at places the route doesn't stop at.</p>
    </section>
  );
}
