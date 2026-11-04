import { useEffect, useMemo, useRef, useState } from "react";
import { useAreas } from "../api/areas";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Bell,
  Check,
  FileText,
  MapPinned,
  Navigation,
  Plus,
  Search,
  Truck as TruckIcon,
  XCircle,
} from "lucide-react";
import { useApp } from "../store";
import { useMay } from "../api/session";
import { useMine } from "./mine";
import { byId, tripKm } from "../domain/calc";
import { activeTrip, placeName, routeLabel } from "../domain/helpers";
import { ACTOR_NAME, nextStep, STAGES, stageIndex, stageTimes } from "../domain/turn";
import type { Move, NextStep, StageId } from "../domain/turn";
import type { Action, Desk, Trip } from "../domain/types";
import { Avatar, Button, Empty, Field, Modal, Segmented } from "../ui/kit";
import { ago, day, hm, km, stamp } from "../ui/format";
import { CantDeliver, UndeliveredNote } from "./CantDeliver";
import { NewTrip } from "./NewTrip";
import { DriverMessages, StagePanel } from "./stages";
import { TripAside } from "./TripAside";

type Filter = "mine" | "active" | "closed";

export function TripsPage({
  tripId,
  stage,
  onSelect,
}: {
  tripId?: string;
  stage?: string;
  onSelect: (tripId: string | undefined, stage?: string) => void;
}) {
  const { data, role } = useApp();
  const may = useMay();
  const mineFor = useMine();
  const [filter, setFilter] = useState<Filter>(role === "owner" ? "active" : "mine");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const messages = useMessageTrips();
  const needsMe = (trip: Trip, step: NextStep) => activeOrUnsettled(trip) && (mineFor(trip, step) || messages.has(trip.id));
  const rows = useMemo(
    () =>
      data.trips
        .map((trip) => ({ trip, step: nextStep(data, trip) }))
        .sort((a, b) => b.trip.createdAt.localeCompare(a.trip.createdAt)),
    [data],
  );
  const counts = {
    mine: rows.filter((r) => needsMe(r.trip, r.step)).length,
    active: rows.filter((r) => activeOrUnsettled(r.trip)).length,
    closed: rows.filter((r) => !activeOrUnsettled(r.trip)).length,
  };
  const q = query.trim().toLowerCase();
  const shown = rows.filter(({ trip, step }) => {
    if (filter === "mine" && !needsMe(trip, step)) return false;
    if (filter === "active" && !activeOrUnsettled(trip)) return false;
    if (filter === "closed" && activeOrUnsettled(trip)) return false;
    if (!q) return true;
    const truck = byId(data.trucks, trip.truckId);
    const driver = byId(data.drivers, trip.driverId);
    return [trip.no, truck?.plate, driver?.name, byId(data.customers, trip.customerId)?.name, routeLabel(data, trip)]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
  const selected = byId(data.trips, tripId);
  useEffect(() => {
    if (!selected && shown[0] && window.innerWidth > 900) onSelect(shown[0].trip.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, shown[0]?.trip.id]);

  return (
    <div className={`trips ${selected ? "has-selection" : ""}`}>
      <section className="trip-list-pane">
        <div className="trip-list-tools">
          <Segmented<Filter>
            label="Filter trips"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "mine", label: role === "owner" ? "Mine" : "Needs me", count: counts.mine },
              { value: "active", label: "Active", count: counts.active },
              { value: "closed", label: "Closed" },
            ]}
          />
          <div className="search">
            <Search size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Truck, driver, trip, customer" aria-label="Search trips" />
          </div>
          {may("trip.create") && (
            <Button tone="primary" onClick={() => setCreating(true)} className="new-trip-btn">
              <Plus /> New trip
            </Button>
          )}
        </div>
        <div className="trip-list" role="list">
          {shown.map(({ trip, step }) => (
            <TripRow key={trip.id} trip={trip} step={step} selected={trip.id === selected?.id} onClick={() => onSelect(trip.id)} />
          ))}
          {!shown.length && (
            <Empty title={filter === "mine" ? "Nothing waiting on you" : "No trips here"}>
              {filter === "mine" && <button className="link-btn" onClick={() => setFilter("active")}>See active trips</button>}
            </Empty>
          )}
        </div>
      </section>
      <section className="trip-detail-pane">
        <AnimatePresence mode="wait">
          {selected ? (
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <TripView trip={selected} stage={stage as StageId | undefined} onStage={(s) => onSelect(selected.id, s)} onBack={() => onSelect(undefined)} />
            </motion.div>
          ) : (
            <div className="trip-none">
              <Empty title="Pick a trip" />
            </div>
          )}
        </AnimatePresence>
      </section>
      <NewTrip open={creating} onClose={() => setCreating(false)} onCreated={(id) => onSelect(id, "funding")} />
    </div>
  );
}

const activeOrUnsettled = (trip: Trip) => !trip.cancelledAt && !trip.settlementId;

/** Trips with a message or photo from the driver waiting for this person to deal with it. */
export function useMessageTrips() {
  const { data } = useApp();
  const may = useMay();
  if (!may("doc.done")) return new Set<string>();
  return new Set(data.docs.filter((d) => d.kind === "other" && d.status === "new" && d.tripId).map((d) => d.tripId!));
}

function TripRow({ trip, step, selected, onClick }: { trip: Trip; step: NextStep; selected: boolean; onClick: () => void }) {
  const { data, role } = useApp();
  const message = useMessageTrips().has(trip.id);
  const truck = byId(data.trucks, trip.truckId);
  const driver = byId(data.drivers, trip.driverId);
  const current = stageIndex(step.stage);
  return (
    <button role="listitem" className={`trip-row ${selected ? "on" : ""}`} onClick={onClick}>
      <div className="trip-row-top">
        <span className="plate">{truck?.plate}</span>
        <Turn trip={trip} step={step} compact />
      </div>
      {message && <div className="trip-row-message">Message from the driver</div>}
      <div className="trip-row-route">{trip.stops.length ? routeLabel(data, trip) : "Route not set"}</div>
      <div className="trip-row-foot">
        <span className="trip-row-bar" aria-hidden>
          {STAGES.map((s, i) => (
            <i key={s.id} className={i < current || step.actor === "done" ? "done" : i === current ? "now" : ""} />
          ))}
        </span>
        <span className="muted">{driver?.name ?? "No driver"}</span>
      </div>
    </button>
  );
}

export function Turn({ trip, step, compact }: { trip: Trip; step: NextStep; compact?: boolean }) {
  const { data } = useApp();
  const mine = useMine()(trip, step);
  if (step.actor === "done")
    return (
      <span className="turn turn-done">
        <Check size={13} /> {step.title}
      </span>
    );
  if (step.actor === "road")
    return (
      <span className="turn turn-road">
        <Navigation size={12} /> {compact ? "On the road" : step.title}
      </span>
    );
  if (mine)
    return <span className="turn turn-you">{compact ? "Your turn" : step.title}</span>;
  return (
    <span className={`turn turn-${step.actor}`}>
      {ACTOR_NAME[step.actor]}
      {!compact && step.since ? ` · ${ago(data, step.since)}` : ""}
    </span>
  );
}

function TripView({
  trip,
  stage,
  onStage,
  onBack,
}: {
  trip: Trip;
  stage?: StageId;
  onStage: (stage: StageId) => void;
  onBack: () => void;
}) {
  const { data, role, setOverlay, me } = useApp();
  const may = useMay();
  const step = nextStep(data, trip);
  const truck = byId(data.trucks, trip.truckId)!;
  const trailer = byId(data.trailers, trip.trailerId);
  const driver = byId(data.drivers, trip.driverId);
  const customer = byId(data.customers, trip.customerId);
  const nomination = byId(data.nominations, trip.nominationId);
  const product = byId(data.products, trip.productId);
  const selectedStage = stage ?? step.stage;
  const panelRef = useRef<HTMLDivElement>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [cantDeliverOpen, setCantDeliverOpen] = useState(false);
  // On the truck and not delivered, and nothing already waiting for the owner.
  const onBoard = data.consignments.find((c) => c.tripId === trip.id && !c.delivered && activeTrip(trip));
  const mayCantDeliver = Boolean(onBoard) && onBoard!.writeOff?.status !== "pending" && data.settings.loadedTripOutcomes.length > 0 && may("trip.undelivered")
    && me.roles.some((r) => ["owner", "admin", ...data.settings.loadedTripRoles].includes(r));
  const focus = (s: StageId) => {
    onStage(s);
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <article className="trip-view">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Trips
      </button>
      <header className="trip-head">
        <div className="trip-head-main">
          <h2>{trip.stops.length ? routeLabel(data, trip) : "New trip"}</h2>
          <div className="trip-head-meta">
            <span className="mono">{trip.no}</span>
            <span>{customer?.name}</span>
            {nomination && <span>{nomination.no}</span>}
          </div>
          <div className="trip-chips">
            <span className="chip">
              <TruckIcon size={15} /> <b>{truck.plate}</b>
              {trailer && <span className="muted">+ {trailer.plate}</span>}
            </span>
            {driver && (
              <span className="chip">
                <Avatar name={driver.name} size={20} /> {driver.name}
              </span>
            )}
            {product && <span className="chip">{product.name}</span>}
            {trip.stops.length > 0 && <span className="chip muted">{km(tripKm(trip))}</span>}
          </div>
        </div>
        <div className="trip-head-actions">
          <Button onClick={() => setOverlay({ document: { kind: "trip-sheet", id: trip.id } })}>
            <FileText /> Trip sheet
          </Button>
          {trip.dispatchedAt && !trip.endedAt && data.settings.stopBeforeLoading && !data.consignments.some((c) => c.tripId === trip.id) && may("trip.stop") && (
            <button className="icon-btn with-label" onClick={() => setStopOpen(true)}>
              <XCircle size={18} />
              <span>Stop trip</span>
            </button>
          )}
          {mayCantDeliver && (
            <button className="icon-btn with-label" onClick={() => setCantDeliverOpen(true)}>
              <XCircle size={18} />
              <span>Can't deliver</span>
            </button>
          )}
          {!trip.dispatchedAt && !trip.cancelledAt && may("trip.cancel") && (
            <button className="icon-btn with-label" onClick={() => setCancelOpen(true)}>
              <XCircle size={18} />
              <span>Cancel trip</span>
            </button>
          )}
        </div>
      </header>

      <Stepper trip={trip} step={step} selected={selectedStage} onSelect={onStage} />
      <NextStepBar trip={trip} step={step} onGo={focus} viewing={selectedStage} />
      {trip.stopReason && !trip.undelivered && <p className="drawer-note">Stopped before loading: {trip.stopReason}</p>}
      <UndeliveredNote trip={trip} load={data.consignments.find((c) => c.tripId === trip.id)} />

      <div className="trip-body">
        <div className="trip-main" ref={panelRef}>
          <DriverMessages trip={trip} />
          <StagePanel trip={trip} stage={selectedStage} step={step} />
        </div>
        <TripAside trip={trip} />
      </div>
      <CancelTrip trip={trip} open={cancelOpen} onClose={() => setCancelOpen(false)} />
      {stopOpen && <StopTrip trip={trip} onClose={() => setStopOpen(false)} />}
      {cantDeliverOpen && <CantDeliver trip={trip} onClose={() => setCantDeliverOpen(false)} />}
    </article>
  );
}

function Stepper({
  trip,
  step,
  selected,
  onSelect,
}: {
  trip: Trip;
  step: NextStep;
  selected: StageId;
  onSelect: (stage: StageId) => void;
}) {
  const { data } = useApp();
  const mine = useMine()(trip, step);
  const times = stageTimes(data, trip);
  const current = step.actor === "done" ? STAGES.length : stageIndex(step.stage);
  return (
    <ol className="stepper" aria-label="Trip stages">
      {STAGES.map((s, i) => {
        const state = i < current ? "done" : i === current ? (mine ? "mine" : "now") : "next";
        return (
          <li key={s.id} className={`step step-${state} ${selected === s.id ? "selected" : ""}`}>
            <button onClick={() => onSelect(s.id)} aria-current={selected === s.id ? "step" : undefined}>
              <span className="step-dot">{state === "done" ? <Check size={12} strokeWidth={3} /> : null}</span>
              <span className="step-label">{s.label}</span>
              <span className="step-time">{times[s.id] ? day(times[s.id]) : state === "now" || state === "mine" ? "Now" : ""}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function NextStepBar({ trip, step, onGo, viewing }: { trip: Trip; step: NextStep; onGo: (stage: StageId) => void; viewing: StageId }) {
  const tracking = useAreas()("tracking");
  const { data, run, setOverlay } = useApp();
  const may = useMay();
  const mine = useMine()(trip, step);
  const actor = step.actor;
  const inline = mine && step.move === "dispatch";
  const target: StageId = step.move === "settle" || step.move === "expenses" ? "settle" : step.stage;
  const showGo = mine && (inline || viewing !== target);
  const verb: Partial<Record<NextStep["move"], string>> = {
    plan: "Open the plan",
    request: "Open funding",
    approve: "Open funding",
    "owner-approve": "Open funding",
    issue: "Open funding",
    dispatch: "Dispatch",
    "confirm-load": "Open loading",
    "confirm-delivery": "Open offloading",
    shortage: "Open offloading",
    end: "Open close",
    expenses: "Open settlement",
    settle: "Open settlement",
  };
  const go = () => {
    if (step.move === "dispatch") run({ type: "trip.dispatch", tripId: trip.id }, `${byId(data.trucks, trip.truckId)?.plate} is on its way.`);
    else onGo(target);
  };
  const canRemind =
    !mine && may("trip.remind") && (actor === "finance" || actor === "owner" || actor === "driver");
  return (
    <section className={`next next-${mine ? "mine" : actor}`} aria-live="polite">
      <div className="next-who">
        {actor === "done" ? (
          <span className="next-icon done"><Check size={18} /></span>
        ) : actor === "road" ? (
          <span className="next-icon road"><Navigation size={17} /></span>
        ) : (
          <Avatar
            name={actor === "driver" ? byId(data.drivers, trip.driverId)?.name ?? "Driver" : data.settings.people[actor as Desk]}
            tone={mine ? "brass" : actor === "driver" ? "sky" : "pine"}
            size={38}
          />
        )}
      </div>
      <div className="next-text">
        <strong>{mine || actor === "done" || actor === "road" ? step.title : step.waiting}</strong>
        <span className="next-label">
          {mine ? "Your turn" : actor === "done" ? "Complete" : actor === "road" ? "On the road" : `${ACTOR_NAME[actor]}'s turn`}
          {step.since && actor !== "done" && <span className="muted"> · {ago(data, step.since)}</span>}
        </span>
        {step.detail && <span className="next-detail">{step.detail}</span>}
      </div>
      <div className="next-actions">
        {showGo && verb[step.move] && (
          <Button tone={inline ? "brass" : "secondary"} size="lg" onClick={go}>
            {verb[step.move]}
          </Button>
        )}
        {actor === "road" && tracking && (
          <Button size="lg" onClick={() => setOverlay({ tracking: trip.id })}>
            <MapPinned /> Track
          </Button>
        )}
        {canRemind && (
          <Button size="lg" onClick={() => run({ type: "trip.remind", tripId: trip.id }, `Reminder sent to ${ACTOR_NAME[actor]} on WhatsApp.`)}>
            <Bell /> Remind
          </Button>
        )}
        {actor === "done" && (
          <Button size="lg" onClick={() => setOverlay({ document: { kind: "trip-sheet", id: trip.id } })}>
            <FileText /> Trip sheet
          </Button>
        )}
      </div>
    </section>
  );
}

/** A trip that left but will never load: close it where the truck is now, and free the truck and driver. */
function StopTrip({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const { data, run } = useApp();
  const reached = [...trip.stops].reverse().find((s) => s.arrivedAt) ?? trip.stops[0];
  const [reason, setReason] = useState("");
  const [placeId, setPlaceId] = useState(reached?.placeId ?? "");
  const [fuel, setFuel] = useState("");
  const ready = reason.trim() && fuel !== "" && Number(fuel) >= 0;
  return (
    <Modal
      open
      title={`Stop ${trip.no}?`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>Keep trip</Button>
          <Button tone="danger" disabled={!ready} onClick={async () => (await run({ type: "trip.stop", tripId: trip.id, reason: reason.trim(), closingFuelL: Number(fuel), placeId: placeId || undefined }, "Trip stopped. The truck and driver are free.")) && onClose()}>
            Stop trip
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <p className="muted">Nothing was loaded. Open money requests are cancelled; cash already paid stays with the driver for settlement.</p>
        <Field label="Reason">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer cancelled the order" autoFocus />
        </Field>
        <Field label="Where the truck is now">
          <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
            {data.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Fuel in the tank (L)">
          <input type="number" min={0} value={fuel} onChange={(e) => setFuel(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
    </Modal>
  );
}

function CancelTrip({ trip, open, onClose }: { trip: Trip; open: boolean; onClose: () => void }) {
  const { run } = useApp();
  const [reason, setReason] = useState("");
  return (
    <Modal
      open={open}
      title={`Cancel ${trip.no}?`}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Keep trip
          </Button>
          <Button
            tone="danger"
            disabled={!reason.trim()}
            onClick={async () => (await run({ type: "trip.cancel", tripId: trip.id, reason }, "Trip cancelled.")) && onClose()}
          >
            Cancel trip
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer postponed" autoFocus />
      </Field>
    </Modal>
  );
}

export function StopsTimeline({ trip }: { trip: Trip }) {
  const { data } = useApp();
  const at = trip.tracking?.km ?? 0;
  let cum = 0;
  return (
    <ol className="stops">
      {trip.stops.map((stop, index) => {
        cum += stop.legKm;
        const reached = Boolean(stop.arrivedAt);
        const here = reached && !stop.leftAt && !trip.endedAt && index < trip.stops.length;
        return (
          <li key={stop.id} className={`stop ${reached ? "reached" : ""} ${here ? "here" : ""} kind-${stop.kind}`}>
            <span className="stop-dot" />
            <div>
              <strong>{placeName(data, stop.placeId)}</strong>
              <span className="muted">
                {stop.kind === "start"
                  ? "Start"
                  : stop.kind === "load"
                    ? "Loading"
                    : stop.kind === "offload"
                      ? "Offloading"
                      : stop.kind === "end"
                        ? "End"
                        : data.places.find((p) => p.id === stop.placeId)?.kind === "border"
                          ? "Border"
                          : "On the way"}
                {index > 0 && stop.legKm > 0 ? ` · ${km(stop.legKm)}` : ""}
              </span>
            </div>
            <span className="stop-time">
              {stop.arrivedAt ? `${day(stop.arrivedAt)}, ${hm(stop.arrivedAt)}${stop.arrivedVia === "simulator" ? " · simulated" : ""}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export { stamp };
