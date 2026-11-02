import { useMemo, useState } from "react";
import { Check, MessageCircle, Pencil, Plus, Send, Truck as TruckIcon, X } from "lucide-react";
import { useApp } from "../store";
import { byId, leg } from "../domain/calc";
import { activeTrip, placeName } from "../domain/helpers";
import { nextStep } from "../domain/turn";
import type { Nomination } from "../domain/types";
import { Avatar, Button, Drawer, Empty, Field, Modal, Segmented, Status } from "../ui/kit";
import { ago, day, hoursText, km, localDate } from "../ui/format";
import { Turn } from "./Trips";

const STEPS = ["draft", "sent", "accepted", "converted"] as const;
const STEP_LABEL = { draft: "Draft", sent: "With customer", accepted: "Accepted", converted: "Trips created" };

export function Nominations() {
  const { data, role } = useApp();
  const [editing, setEditing] = useState<Nomination | "new" | null>(null);
  const [converting, setConverting] = useState<Nomination | null>(null);
  const [filter, setFilter] = useState<"open" | "done">("open");
  const list = data.nominations
    .filter((n) => (filter === "open" ? !["converted", "cancelled"].includes(n.status) : ["converted", "cancelled"].includes(n.status)))
    .slice()
    .reverse();
  return (
    <div className="desk">
      <div className="desk-tools">
        <Segmented
          label="Nominations"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: "Open", count: data.nominations.filter((n) => !["converted", "cancelled"].includes(n.status)).length },
            { value: "done", label: "Done" },
          ]}
        />
        {role !== "finance" && (
          <Button tone="primary" onClick={() => setEditing("new")}>
            <Plus /> New nomination
          </Button>
        )}
      </div>
      <div className="nom-list">
        {list.map((n) => (
          <NominationCard key={n.id} n={n} onEdit={() => setEditing(n)} onConvert={() => setConverting(n)} />
        ))}
        {!list.length && <Empty title={filter === "open" ? "No open nominations" : "Nothing here yet"} />}
      </div>
      <NominationForm open={editing !== null} editing={editing === "new" ? undefined : editing ?? undefined} onClose={() => setEditing(null)} />
      <Convert n={converting} onClose={() => setConverting(null)} />
    </div>
  );
}

function NominationCard({ n, onEdit, onConvert }: { n: Nomination; onEdit: () => void; onConvert: () => void }) {
  const { data, role, run, setOverlay } = useApp();
  const customer = byId(data.customers, n.customerId)!;
  const product = byId(data.products, n.productId);
  const at = STEPS.indexOf(n.status as (typeof STEPS)[number]);
  const ops = role !== "finance";
  return (
    <article className={`nom nom-${n.status}`}>
      <header className="nom-head">
        <div>
          <span className="mono muted">{n.no}</span>
          <h3>{customer.name}</h3>
          <span className="muted">
            {n.source}
            {n.reference ? ` · ${n.reference}` : ""} · created {ago(data, n.createdAt)} ago
          </span>
        </div>
        {n.status !== "cancelled" ? (
          <ol className="nom-steps" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>
                <i>{i < at && <Check size={10} strokeWidth={3} />}</i>
                {STEP_LABEL[s]}
              </li>
            ))}
          </ol>
        ) : (
          <Status tone="mute">Cancelled</Status>
        )}
      </header>
      <div className="nom-facts">
        <div>
          <span>Loading at</span>
          <strong>{placeName(data, n.loadingPlaceId)}</strong>
        </div>
        <div>
          <span>Needed</span>
          <strong>{day(n.requiredDate)}</strong>
        </div>
        <div>
          <span>Cargo</span>
          <strong>
            {product?.name ?? "To confirm"}
            {n.qtyPerTruck ? ` · ${n.qtyPerTruck.toLocaleString("en-GB")} ${product?.unit ?? ""} each` : ""}
          </strong>
        </div>
        <div>
          <span>Trucks</span>
          <strong>{n.trucks.length}</strong>
        </div>
      </div>
      {n.status === "converted" ? (
        <div className="nom-trips">
          {n.tripIds.map((id) => {
            const t = byId(data.trips, id);
            if (!t) return null;
            return (
              <div key={id} className="nom-trip">
                <TruckIcon size={15} />
                <b>{byId(data.trucks, t.truckId)?.plate}</b>
                <span className="mono muted">{t.no}</span>
                <Turn step={nextStep(data, t)} role={role} compact />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="nom-trucks">
          {n.trucks.map((t) => {
            const truck = byId(data.trucks, t.truckId);
            const driver = byId(data.drivers, t.driverId ?? truck?.driverId);
            return (
              <span key={t.truckId} className="chip">
                <TruckIcon size={14} /> <b>{truck?.plate}</b> <span className="muted">{driver?.name ?? "Driver to confirm"}</span>
              </span>
            );
          })}
        </div>
      )}
      {n.note && <p className="nom-note">{n.note}</p>}
      {ops && !["converted", "cancelled"].includes(n.status) && (
        <footer className="nom-actions">
          {(n.status === "draft" || n.status === "sent") && (
            <Button tone="quiet" size="sm" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
          )}
          <Button tone="quiet" size="sm" onClick={() => run({ type: "nomination.cancel", id: n.id }, "Nomination cancelled.")}>
            <X /> Cancel
          </Button>
          <span className="spacer" />
          {n.status === "draft" && (
            <Button tone="primary" onClick={() => run({ type: "nomination.send", id: n.id }, `Sent to ${customer.name} on WhatsApp.`)}>
              <Send /> Send to {customer.contact.split(" ")[0]}
            </Button>
          )}
          {n.status === "sent" && (
            <>
              <Button onClick={() => setOverlay({ phone: true })}>
                <MessageCircle /> See chat
              </Button>
              <Button tone="primary" onClick={() => run({ type: "nomination.accept", id: n.id }, "Marked accepted.")}>
                <Check /> Customer accepted
              </Button>
            </>
          )}
          {n.status === "accepted" && (
            <Button tone="brass" onClick={onConvert}>
              Create {n.trucks.length} trip{n.trucks.length === 1 ? "" : "s"}
            </Button>
          )}
        </footer>
      )}
    </article>
  );
}

function NominationForm({ open, editing, onClose }: { open: boolean; editing?: Nomination; onClose: () => void }) {
  const { data, run } = useApp();
  const now = new Date(Date.now() + data.settings.clockOffsetMs).toISOString();
  const [customerId, setCustomerId] = useState(editing?.customerId ?? data.customers[0].id);
  const [source, setSource] = useState<Nomination["source"]>(editing?.source ?? "Direct");
  const [reference, setReference] = useState(editing?.reference ?? "");
  const [loadingPlaceId, setLoading] = useState(editing?.loadingPlaceId ?? "IND");
  const [productId, setProductId] = useState(editing?.productId ?? "");
  const [qty, setQty] = useState(editing?.qtyPerTruck ? String(editing.qtyPerTruck) : "");
  const [date, setDate] = useState(editing?.requiredDate ?? localDate(new Date(Date.parse(now) + 864e5).toISOString()));
  const [picked, setPicked] = useState<string[]>(editing?.trucks.map((t) => t.truckId) ?? []);
  const [note, setNote] = useState(editing?.note ?? "");
  const key = `${open}-${editing?.id}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setCustomerId(editing?.customerId ?? data.customers[0].id);
    setSource(editing?.source ?? "Direct");
    setReference(editing?.reference ?? "");
    setLoading(editing?.loadingPlaceId ?? "IND");
    setProductId(editing?.productId ?? "");
    setQty(editing?.qtyPerTruck ? String(editing.qtyPerTruck) : "");
    setDate(editing?.requiredDate ?? localDate(new Date(Date.parse(now) + 864e5).toISOString()));
    setPicked(editing?.trucks.map((t) => t.truckId) ?? []);
    setNote(editing?.note ?? "");
  }
  const busy = new Set(data.trips.filter(activeTrip).map((t) => t.truckId));
  const held = new Set(
    data.nominations.filter((n) => ["draft", "sent", "accepted"].includes(n.status) && n.id !== editing?.id).flatMap((n) => n.trucks.map((t) => t.truckId)),
  );
  const trucks = useMemo(
    () =>
      data.trucks
        .map((t) => ({ truck: t, away: leg(data, t.placeId, loadingPlaceId), busy: busy.has(t.id), held: held.has(t.id) }))
        .sort((a, b) => Number(a.busy || a.held) - Number(b.busy || b.held) || a.away.km - b.away.km),
    [data, loadingPlaceId, busy, held],
  );
  const save = async () => {
    if (
      await run(
        {
          type: "nomination.save",
          id: editing?.id,
          customerId,
          source,
          reference,
          loadingPlaceId,
          productId: productId || undefined,
          qtyPerTruck: Number(qty) || undefined,
          requiredDate: date,
          trucks: picked.map((truckId) => ({ truckId, driverId: byId(data.trucks, truckId)?.driverId })),
          note,
        },
        editing ? "Nomination updated." : "Nomination saved. Send it when ready.",
      )
    )
      onClose();
  };
  return (
    <Drawer
      open={open}
      title={editing ? `Edit ${editing.no}` : "New nomination"}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!picked.length} onClick={save}>
            <Check /> Save {picked.length ? `with ${picked.length} truck${picked.length === 1 ? "" : "s"}` : ""}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Customer">
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              {data.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order came">
            <Segmented
              label="Order source"
              value={source}
              onChange={setSource}
              options={[
                { value: "Direct", label: "Direct" },
                { value: "Broker", label: "Broker" },
                { value: "Sales", label: "Sales" },
              ]}
            />
          </Field>
          <Field label={source === "Broker" ? "Broker reference" : "Customer order no."}>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={source === "Broker" ? "BRK-2291 · Kasonde Freight" : "PO-7731"} />
          </Field>
          <Field label="Loading at">
            <select value={loadingPlaceId} onChange={(e) => setLoading(e.target.value)}>
              {data.places
                .filter((p) => p.kind !== "border")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Cargo">
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">To confirm</option>
              {data.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Needed on">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={`Per truck${productId ? ` (${byId(data.products, productId)?.unit})` : ""}`}>
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <div>
          <div className="pick-head">
            <strong>Trucks</strong>
            <span className="muted">Nearest to {placeName(data, loadingPlaceId)} first</span>
          </div>
          <div className="truck-list">
            {trucks.map(({ truck, away, busy: onTrip, held: nominated }) => {
              const driver = byId(data.drivers, truck.driverId);
              const on = picked.includes(truck.id);
              const disabled = (onTrip || nominated) && !on;
              return (
                <button
                  key={truck.id}
                  className={`truck-line ${on ? "on" : ""}`}
                  disabled={disabled}
                  onClick={() => setPicked((p) => (p.includes(truck.id) ? p.filter((x) => x !== truck.id) : [...p, truck.id]))}
                >
                  <span className="check-box">{on && <Check size={13} strokeWidth={3} />}</span>
                  <span className="truck-line-main">
                    <strong>{truck.plate}</strong>
                    <span className="muted">
                      {byId(data.trailers, truck.trailerId)?.type ?? "No trailer"} · {driver?.name ?? "No usual driver"}
                    </span>
                  </span>
                  <span className="truck-line-away">
                    {onTrip ? (
                      <Status tone="info">On a trip</Status>
                    ) : nominated ? (
                      <Status tone="mute">In another nomination</Status>
                    ) : away.km ? (
                      <>
                        <b>{km(away.km)}</b>
                        <span className="muted">{hoursText(away.hours)} away</span>
                      </>
                    ) : (
                      <Status tone="ok">At the site</Status>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Drawer>
  );
}

function Convert({ n, onClose }: { n: Nomination | null; onClose: () => void }) {
  const { data, run } = useApp();
  const routes = n ? data.routes.filter((r) => r.stops.some((s) => s.kind === "load" && s.placeId === n.loadingPlaceId)) : [];
  const [routeId, setRouteId] = useState("");
  const [offloadId, setOffloadId] = useState("");
  const chosen = routeId || routes[0]?.id || "";
  return (
    <Modal
      open={Boolean(n)}
      title={n ? `Create ${n.trucks.length} trips` : ""}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={!chosen && !offloadId}
            onClick={async () => {
              if (n && (await run({ type: "nomination.convert", id: n.id, routeId: chosen || undefined, offloadPlaceId: chosen ? undefined : offloadId }, "Trips created. Each driver has theirs on WhatsApp."))) onClose();
            }}
          >
            <Check /> Create trips
          </Button>
        </>
      }
    >
      {n && (
        <div className="stack">
          <div className="convert-trucks">
            {n.trucks.map((t) => {
              const truck = byId(data.trucks, t.truckId);
              return (
                <span key={t.truckId} className="chip">
                  <Avatar name={byId(data.drivers, t.driverId ?? truck?.driverId)?.name ?? "?"} size={20} /> {truck?.plate}
                </span>
              );
            })}
          </div>
          {routes.length > 0 ? (
            <Field label="Route">
              <select value={chosen} onChange={(e) => setRouteId(e.target.value)}>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Offloading at">
              <select value={offloadId} onChange={(e) => setOffloadId(e.target.value)}>
                <option value="">Choose</option>
                {data.places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}
