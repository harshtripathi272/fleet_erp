import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  Droplets,
  Fuel,
  MapPin,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  FileText,
  Upload,
} from "lucide-react";
import { useApp } from "../store";
import {
  byId,
  carriedIn,
  cumulativeKm,
  driverBalance,
  fuelEstimate,
  fuelNow,
  funding,
  leg,
  legLoaded,
  measureFuel,
  shortageFor,
  tripFuelUsed,
  tripHours,
  tripKm,
  validateStops,
  volume20,
} from "../domain/calc";
import { activeTrip, placeName } from "../domain/helpers";
import type { NextStep, StageId } from "../domain/turn";
import type {
  AppData,
  Consignment,
  Currency,
  DocKind,
  DriverDoc,
  FundRequest,
  RouteStop,
  StopKind,
  Trip,
} from "../domain/types";
import { Button, Empty, Field, Meter, Rows, Status } from "../ui/kit";
import { cash, day, fromLocalInput, hm, hoursText, km, L, localInput, num, stamp, zmw } from "../ui/format";
import { useDocImage } from "../docs/useDocImage";
import { ACCEPT, uploadFile } from "../api/files";
import { useSim } from "../tracking/sim";
import { MiniRoute } from "../tracking/MiniRoute";
import { StopsTimeline } from "./Trips";

export function StagePanel({ trip, stage, step }: { trip: Trip; stage: StageId; step: NextStep }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={stage}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.16 }}
        className="stage"
      >
        {stage === "plan" && <PlanPanel trip={trip} />}
        {stage === "funding" && <FundingPanel trip={trip} step={step} />}
        {stage === "loading" && <LoadingPanel trip={trip} />}
        {stage === "transit" && <TransitPanel trip={trip} />}
        {stage === "offloading" && <OffloadingPanel trip={trip} />}
        {stage === "close" && <ClosePanel trip={trip} />}
        {stage === "settle" && <SettlePanel trip={trip} />}
      </motion.div>
    </AnimatePresence>
  );
}

export function Card({
  title,
  aside,
  children,
  tone,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  tone?: "mine" | "quiet";
}) {
  return (
    <section className={`card ${tone ? `card-${tone}` : ""}`}>
      {(title || aside) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {aside}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

/* ================= Plan ================= */

const KIND_LABEL: Record<StopKind, string> = {
  start: "Start",
  load: "Loading",
  via: "Border or stop",
  border: "Border",
  offload: "Offloading",
  end: "End",
};

function PlanPanel({ trip }: { trip: Trip }) {
  const { data, role, run } = useApp();
  const editable = !trip.dispatchedAt && activeTrip(trip) && (role === "operations" || role === "owner");
  const truck = byId(data.trucks, trip.truckId)!;
  const initial = () => ({
    driverId: trip.driverId ?? "",
    trailerId: trip.trailerId ?? "",
    customerId: trip.customerId,
    plannedStart: localInput(trip.plannedStart),
    productId: trip.productId ?? "",
    plannedQty: trip.plannedQty ? String(trip.plannedQty) : "",
    routeId: trip.routeId ?? "",
    stops: trip.stops.map((s) => ({ placeId: s.placeId, kind: s.kind })) as RouteStop[],
    fuelBudgetL: String(trip.fuelBudgetL),
    cashBudgetZmw: String(trip.cashBudgetZmw),
  });
  const [form, setForm] = useState(initial);
  useEffect(() => {
    setForm(initial());
  }, [trip.id, trip.stops.length, trip.driverId, trip.trailerId, trip.fuelBudgetL, trip.cashBudgetZmw]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<ReturnType<typeof initial>>) => setForm((f) => ({ ...f, ...patch }));
  const busyDrivers = new Set(data.trips.filter((t) => activeTrip(t) && t.id !== trip.id).map((t) => t.driverId));
  const busyTrailers = new Set(data.trips.filter((t) => activeTrip(t) && t.id !== trip.id).map((t) => t.trailerId));
  const stopsProblem = validateStops(form.stops);
  const preview = useMemo(() => {
    if (stopsProblem) return undefined;
    const stops = form.stops.map((s, i) => {
      const prev = form.stops[i - 1];
      const l = prev ? leg(data, prev.placeId, s.placeId) : { km: 0, hours: 0 };
      return { ...s, id: String(i), legKm: l.km, legHours: l.hours };
    });
    return { stops, fuel: fuelEstimate({ stops }, truck) };
  }, [data, form.stops, stopsProblem, truck]);
  const route = byId(data.routes, form.routeId);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());
  const useRoute = (id: string) => {
    const r = byId(data.routes, id);
    if (!r) return set({ routeId: "" });
    const stops = r.stops[0].placeId === truck.placeId ? r.stops : [{ placeId: truck.placeId, kind: "start" as const }, ...r.stops.slice(1)];
    const f = fuelEstimate({ stops: stops.map((s, i) => ({ ...s, id: String(i), legKm: i ? leg(data, stops[i - 1].placeId, s.placeId).km : 0, legHours: 0 })) }, truck);
    set({ routeId: id, stops, fuelBudgetL: String(r.fuelBudgetL ?? f), cashBudgetZmw: String(r.cashBudgetZmw) });
  };
  const save = () =>
    run(
      {
        type: "trip.update",
        tripId: trip.id,
        driverId: form.driverId,
        trailerId: form.trailerId,
        customerId: form.customerId,
        plannedStart: fromLocalInput(form.plannedStart),
        productId: form.productId,
        plannedQty: Number(form.plannedQty) || 0,
        routeId: form.routeId,
        stops: form.stops,
        fuelBudgetL: Number(form.fuelBudgetL),
        cashBudgetZmw: Number(form.cashBudgetZmw),
      },
      "Plan saved.",
    );
  if (!editable)
    return (
      <div className="stack">
        <Card title="Plan">
          <Rows
            rows={[
              ["Customer", byId(data.customers, trip.customerId)?.name],
              ["Truck", `${truck.plate} · ${truck.model}`],
              ["Trailer", byId(data.trailers, trip.trailerId)?.plate ?? "None"],
              ["Driver", byId(data.drivers, trip.driverId)?.name ?? "—"],
              ["Planned start", stamp(trip.plannedStart)],
              ["Cargo", byId(data.products, trip.productId)?.name ?? "On the loading invoice"],
              ["Distance", `${km(tripKm(trip))} · about ${hoursText(tripHours(trip))} driving`],
              ["Fuel budget", L(trip.fuelBudgetL)],
              ["Cash budget", zmw(trip.cashBudgetZmw)],
            ]}
          />
        </Card>
        <Card title="Route">
          <StopsTimeline trip={trip} />
        </Card>
      </div>
    );
  return (
    <div className="stack">
      <Card title="Assignment">
        <div className="grid-3">
          <Field label="Truck">
            <input value={`${truck.plate} · at ${placeName(data, truck.placeId)}`} disabled />
          </Field>
          <Field label="Driver">
            <select value={form.driverId} onChange={(e) => set({ driverId: e.target.value })}>
              <option value="">Choose driver</option>
              {data.drivers
                .filter((d) => !busyDrivers.has(d.id) || d.id === trip.driverId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.id === truck.driverId ? " · usual driver" : ""}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Trailer">
            <select value={form.trailerId} onChange={(e) => set({ trailerId: e.target.value })}>
              <option value="">No trailer</option>
              {data.trailers
                .filter((t) => !busyTrailers.has(t.id) || t.id === trip.trailerId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.plate} · {t.type}
                    {t.id === truck.trailerId ? " · paired" : ""}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Customer">
            <select value={form.customerId} disabled={Boolean(trip.nominationId)} onChange={(e) => set({ customerId: e.target.value })}>
              {data.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Leaves">
            <input type="datetime-local" value={form.plannedStart} onChange={(e) => set({ plannedStart: e.target.value })} />
          </Field>
          <Field label="Cargo">
            <select value={form.productId} onChange={(e) => set({ productId: e.target.value })}>
              <option value="">From the invoice</option>
              {data.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>
      <Card
        title="Route"
        aside={
          <select className="input route-pick" value={form.routeId} onChange={(e) => useRoute(e.target.value)} aria-label="Route template">
            <option value="">Custom stops</option>
            {data.routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        }
      >
        <StopEditor stops={form.stops} onChange={(stops) => set({ stops, routeId: route && JSON.stringify(stops) === JSON.stringify(route.stops) ? form.routeId : "" })} startLocked={truck.placeId} />
        {preview ? (
          <div className="route-summary">
            <MiniRoute stops={preview.stops} height={120} />
            <div className="route-numbers">
              <div>
                <span>Distance</span>
                <strong>{km(preview.stops.reduce((s, x) => s + x.legKm, 0))}</strong>
              </div>
              <div>
                <span>Loaded</span>
                <strong>{km(preview.stops.reduce((s, x, i) => s + (legLoaded(preview.stops, i) ? x.legKm : 0), 0))}</strong>
              </div>
              <div>
                <span>Fuel estimate</span>
                <strong>{L(preview.fuel)}</strong>
              </div>
            </div>
          </div>
        ) : (
          <p className="form-problem">{stopsProblem}</p>
        )}
      </Card>
      <Card title="Budget">
        <div className="grid-2">
          <Field label="Fuel" hint={preview ? `${truck.emptyKmpl} km/L empty, ${truck.loadedKmpl} km/L loaded gives ${L(preview.fuel)}` : undefined}>
            <span className="suffix">
              <input type="number" min={0} value={form.fuelBudgetL} onChange={(e) => set({ fuelBudgetL: e.target.value })} />
              <span>L</span>
            </span>
          </Field>
          <Field label="Driver cash" hint={route ? `${route.name} standard` : undefined}>
            <span className="suffix">
              <input type="number" min={0} value={form.cashBudgetZmw} onChange={(e) => set({ cashBudgetZmw: e.target.value })} />
              <span>ZMW</span>
            </span>
          </Field>
        </div>
      </Card>
      <AnimatePresence>
        {dirty && (
          <motion.div className="savebar" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }}>
            <span>Unsaved changes</span>
            <Button tone="quiet" onClick={() => setForm(initial())}>
              <RotateCcw /> Undo
            </Button>
            <Button tone="primary" disabled={Boolean(stopsProblem) || !form.driverId} onClick={save}>
              Save plan
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StopEditor({
  stops,
  onChange,
  startLocked,
}: {
  stops: RouteStop[];
  onChange: (stops: RouteStop[]) => void;
  startLocked?: string;
}) {
  const { data } = useApp();
  const patch = (index: number, p: Partial<RouteStop>) => onChange(stops.map((s, i) => (i === index ? { ...s, ...p } : s)));
  const add = () => {
    const at = Math.max(1, stops.length - 1);
    onChange([...stops.slice(0, at), { placeId: "", kind: "via" }, ...stops.slice(at)]);
  };
  return (
    <div className="stop-editor">
      {stops.map((stop, i) => {
        const prev = stops[i - 1];
        const l = prev && stop.placeId && prev.placeId ? leg(data, prev.placeId, stop.placeId) : undefined;
        const fixedKind = i === 0 || i === stops.length - 1;
        return (
          <div className={`stop-row kind-${stop.kind}`} key={i}>
            <span className="stop-row-dot" aria-hidden />
            <select
              className="input stop-kind"
              value={stop.kind}
              disabled={fixedKind}
              aria-label={`Stop ${i + 1} type`}
              onChange={(e) => patch(i, { kind: e.target.value as StopKind })}
            >
              {(fixedKind ? [stop.kind] : (["load", "via", "border", "offload"] as StopKind[])).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <select
              className="input stop-place"
              value={stop.placeId}
              disabled={i === 0 && Boolean(startLocked)}
              aria-label={`Stop ${i + 1} place`}
              onChange={(e) => patch(i, { placeId: e.target.value })}
            >
              <option value="">Choose place</option>
              {data.places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="stop-leg">
              {l ? (
                <>
                  <b>{km(l.km)}</b> {l.km ? hoursText(l.hours) : ""}
                  {l.km > 0 && <em className={legLoaded(stops, i) ? "loaded" : "empty"}>{legLoaded(stops, i) ? "Loaded" : "Empty"}</em>}
                </>
              ) : (
                ""
              )}
            </span>
            {!fixedKind ? (
              <button className="icon-btn" aria-label={`Remove stop ${i + 1}`} onClick={() => onChange(stops.filter((_, j) => j !== i))}>
                <Trash2 size={16} />
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      <button className="add-stop" onClick={add}>
        <Plus size={16} /> Add a stop
      </button>
    </div>
  );
}

/* ================= Funding ================= */

function FundingPanel({ trip, step }: { trip: Trip; step: NextStep }) {
  const { data, role, run } = useApp();
  const f = funding(data, trip);
  const requests = data.requests.filter((r) => r.tripId === trip.id).slice().reverse();
  const canRequest = (role === "operations" || role === "owner") && activeTrip(trip) && Boolean(trip.driverId) && trip.stops.length > 0;
  const driver = byId(data.drivers, trip.driverId);
  const truck = byId(data.trucks, trip.truckId)!;
  const both = canRequest && !trip.dispatchedAt && f.fuel.suggested > 0 && f.cash.suggested > 0;
  const mine = step.move === "request" && (role === "operations" || role === "owner");
  return (
    <div className="stack">
      {both && (
        <div className={`quick ${mine ? "quick-mine" : ""}`}>
          <span>
            Request <b>{L(f.fuel.suggested)}</b> of fuel and a <b>{zmw(f.cash.suggested)}</b> advance, as budgeted
          </span>
          <Button
            tone="primary"
            onClick={async () => {
              const base = data.baseCurrency?.code ?? "ZMW";
              if (await run({ type: "request.create", tripId: trip.id, kind: "fuel", amount: f.fuel.suggested, currency: base }))
                await run({ type: "request.create", tripId: trip.id, kind: "cash", amount: f.cash.suggested, currency: base }, "Both sent for approval.");
            }}
          >
            <Send /> Request both
          </Button>
        </div>
      )}
      <div className="fund-grid">
        <FundCard
          icon={<Fuel size={18} />}
          title="Fuel"
          unit="L"
          budget={f.fuel.budget}
          rows={[
            ["Budget", L(f.fuel.budget)],
            ["In the tank", L(f.fuel.onTruck)],
            ["Issued", L(f.fuel.issued)],
            ["Waiting", L(f.fuel.open)],
          ]}
          parts={[
            { value: f.fuel.onTruck, tone: "base", label: "In the tank" },
            { value: f.fuel.issued, tone: "issued", label: "Issued" },
            { value: f.fuel.open, tone: "open", label: "Waiting" },
          ]}
          suggested={f.fuel.suggested}
          suggestionText={f.fuel.suggested ? `Top up ${L(f.fuel.suggested)}` : "Covered"}
          canRequest={canRequest}
          kind="fuel"
          trip={trip}
          max={Number.isFinite(f.fuel.room) ? f.fuel.room : undefined}
        />
        <FundCard
          icon={<CircleDollarSign size={18} />}
          title="Driver cash"
          unit={data.baseCurrency?.code ?? "ZMW"}
          budget={f.cash.budget}
          rows={[
            ["Budget", zmw(f.cash.budget)],
            [f.cash.holds >= 0 ? `${driver?.name.split(" ")[0] ?? "Driver"} already holds` : "Company owes the driver", zmw(Math.abs(f.cash.holds))],
            ["Paid on this trip", zmw(f.cash.issued)],
            ["Waiting", zmw(f.cash.open)],
          ]}
          parts={[
            { value: Math.max(0, f.cash.holds), tone: "base", label: "Holds" },
            { value: f.cash.issued, tone: "issued", label: "Paid" },
            { value: f.cash.open, tone: "open", label: "Waiting" },
          ]}
          suggested={f.cash.suggested}
          suggestionText={f.cash.suggested ? `Advance ${zmw(f.cash.suggested)}` : "Covered"}
          canRequest={canRequest}
          kind="cash"
          trip={trip}
        />
      </div>
      {requests.length > 0 && (
        <Card title="Requests">
          <div className="req-list">
            {requests.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function FundCard({
  icon,
  title,
  unit,
  budget,
  rows,
  parts,
  suggested,
  suggestionText,
  canRequest,
  kind,
  trip,
  max,
}: {
  icon: ReactNode;
  title: string;
  unit: string;
  budget: number;
  rows: [string, string][];
  parts: { value: number; tone: string; label: string }[];
  suggested: number;
  suggestionText: string;
  canRequest: boolean;
  kind: "fuel" | "cash";
  trip: Trip;
  max?: number;
}) {
  const { data, run } = useApp();
  const [amount, setAmount] = useState(String(suggested || ""));
  const [currency, setCurrency] = useState<Currency>((data.baseCurrency?.code ?? "ZMW") as Currency);
  const [reason, setReason] = useState("");
  const [extra, setExtra] = useState(false);
  useEffect(() => {
    setAmount(String(suggested || ""));
  }, [suggested]);
  const value = Number(amount);
  const inZmw = kind === "cash" && currency === "USD" ? value * data.settings.fxZmwPerUsd : value;
  const over = inZmw > suggested + 0.001;
  const submit = async () => {
    if (await run({ type: "request.create", tripId: trip.id, kind, amount: value, currency: kind === "fuel" ? data.baseCurrency?.code ?? "ZMW" : currency, reason }, "Sent for approval.")) setReason("");
  };
  return (
    <section className="card fund-card">
      <header className="card-head">
        <h3>
          <span className="fund-icon">{icon}</span>
          {title}
        </h3>
        <span className={`fund-suggest ${suggested ? "" : "ok"}`}>{suggestionText}</span>
      </header>
      <div className="card-body">
        <Meter total={budget} parts={parts} />
        <Rows rows={rows} />
        {canRequest && !suggested && !extra && (
          <button className="fund-more" onClick={() => setExtra(true)}>
            <Plus size={15} /> Ask for more
          </button>
        )}
        {canRequest && (suggested > 0 || extra) && (
          <div className="fund-form">
            <div className="fund-inputs">
              <span className="suffix amount">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={max}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label={`${title} amount`}
                />
                {kind === "fuel" ? (
                  <span>{unit}</span>
                ) : (
                  <select className="currency" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="Currency">
                    <option>ZMW</option>
                    <option>USD</option>
                  </select>
                )}
              </span>
              <Button tone="primary" disabled={!(value > 0) || (over && !reason.trim())} onClick={submit}>
                <Send /> Request
              </Button>
            </div>
            <AnimatePresence>
              {over && value > 0 && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="over">
                  <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why more than the budget?" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}

function RequestRow({ request }: { request: FundRequest }) {
  const { data, role, run } = useApp();
  const [mode, setMode] = useState<"reject" | "pay" | null>(null);
  const [note, setNote] = useState("");
  // The company's payment methods that suit the request.
  const fuelKinds = ["fuel_card", "fuel_voucher", "own_depot"];
  const methods = (data.paymentMethods ?? []).filter((m) => (request.kind === "fuel" ? m.forFuel || fuelKinds.includes(m.kind) : m.forCash && !fuelKinds.includes(m.kind))).map((m) => m.name);
  const media = methods.length ? methods : request.kind === "fuel" ? ["Own depot", "Fuel card", "Voucher"] : ["Cash", "Bank transfer"];
  const [medium, setMedium] = useState(media[0]);
  const [reference, setReference] = useState("");
  const amount = request.kind === "fuel" ? L(request.amount) : cash(request.amount, request.currency);
  // Who may decide comes from the company's approval policy (worked out by the API's rule).
  const canDecide = (request.status === "pending" || request.status === "owner") && Boolean(request.mayDecide);
  const canPay = request.status === "approved" && (role === "finance" || role === "owner");
  const canCancel = ["pending", "owner", "approved"].includes(request.status) && (role === "operations" || role === "owner");
  const status: Record<FundRequest["status"], [string, "ok" | "wait" | "bad" | "info" | "mute"]> = {
    pending: [`With ${request.waitingOn ?? "the approver"}`, "wait"],
    owner: [`With ${request.waitingOn ?? "the next approver"}${request.level ? ` (${request.level.current} of ${request.level.of})` : ""}`, "wait"],
    approved: ["Approved, to pay", "info"],
    issued: [request.kind === "fuel" ? "Issued" : "Paid", "ok"],
    rejected: ["Rejected", "bad"],
    cancelled: ["Cancelled", "mute"],
  };
  const chain = [
    { label: "Operations", done: true },
    { label: "Approval", done: request.trail.some((t) => t.what === "approved" || t.what === "sent to owner") || request.status === "issued" },
    ...(request.level && request.level.of > 1 ? [{ label: "Next approval", done: ["approved", "issued"].includes(request.status) }] : []),
    { label: request.kind === "fuel" ? "Issued" : "Paid", done: request.status === "issued" },
  ];
  const [label, tone] = status[request.status];
  return (
    <div className={`req req-${request.status}`}>
      <div className="req-main">
        <span className={`req-kind ${request.kind}`}>{request.kind === "fuel" ? <Droplets size={16} /> : <CircleDollarSign size={16} />}</span>
        <div className="req-text">
          <strong className="num">{amount}</strong>
          <span className="muted">
            <span className="mono">{request.no}</span>
            {request.medium ? ` · ${request.medium} ${request.reference}` : ""}
            {request.reason ? ` · ${request.reason}` : ""}
          </span>
        </div>
        <Status tone={tone}>{label}</Status>
      </div>
      {!["rejected", "cancelled"].includes(request.status) && (
        <ol className="chain" aria-label="Approval chain">
          {chain.map((c, i) => (
            <li key={i} className={c.done ? "done" : ""}>
              <i>{c.done && <Check size={10} strokeWidth={3} />}</i>
              {c.label}
            </li>
          ))}
        </ol>
      )}
      {request.status === "rejected" && <p className="req-note">{request.trail.at(-1)?.note}</p>}
      {(canDecide || canPay || canCancel) && (
        <div className="req-actions">
          {canDecide && !mode && (
            <>
              <Button tone="primary" size="sm" onClick={() => run({ type: "request.decide", id: request.id, approve: true }, request.level && request.level.current < request.level.of ? "Approved. Sent for the next approval." : "Approved.")}>
                <Check /> Approve
              </Button>
              <Button tone="danger" size="sm" onClick={() => setMode("reject")}>
                Reject
              </Button>
            </>
          )}
          {canPay && !mode && (
            <Button tone="primary" size="sm" onClick={() => setMode("pay")}>
              {request.kind === "fuel" ? "Issue fuel" : "Pay advance"}
            </Button>
          )}
          {canCancel && !mode && (
            <Button tone="quiet" size="sm" onClick={() => run({ type: "request.cancel", id: request.id }, "Request cancelled.")}>
              <Undo2 /> Cancel
            </Button>
          )}
          {mode === "reject" && (
            <div className="inline-form">
              <input className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason" />
              <Button tone="danger" size="sm" disabled={!note.trim()} onClick={async () => (await run({ type: "request.decide", id: request.id, approve: false, note }, "Rejected.")) && setMode(null)}>
                Reject
              </Button>
              <Button tone="quiet" size="sm" onClick={() => setMode(null)}>
                Back
              </Button>
            </div>
          )}
          {mode === "pay" && (
            <div className="inline-form">
              <select className="input" value={medium} onChange={(e) => setMedium(e.target.value)} aria-label="Paid by">
                {media.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={`Reference, e.g. ${request.kind === "fuel" ? "FV-20931" : "AM-7731-2290"}`} />
              <Button
                tone="primary"
                size="sm"
                disabled={!reference.trim()}
                onClick={async () =>
                  (await run(
                    { type: "request.issue", id: request.id, medium, reference, station: request.kind === "fuel" ? placeName(data, byId(data.trips, request.tripId)?.stops[0]?.placeId) : undefined },
                    request.kind === "fuel" ? "Fuel issued. The driver is told." : "Advance paid. The driver is told.",
                  )) && setMode(null)
                }
              >
                Confirm
              </Button>
              <Button tone="quiet" size="sm" onClick={() => setMode(null)}>
                Back
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= Documents ================= */

export function DocPhoto({ doc, size = "md" }: { doc: DriverDoc; size?: "sm" | "md" }) {
  const { setOverlay } = useApp();
  const { src, pdf } = useDocImage(doc);
  const body = pdf
    ? <span className="doc-photo-pdf"><FileText size={size === "sm" ? 18 : 28} /><span>{doc.file?.name}</span></span>
    : src ? <img src={src} alt={doc.file?.name ?? "Document"} loading="lazy" /> : <span className="doc-photo-none">{doc.note}</span>;
  return (
    <span className="doc-photo-wrap">
      {pdf && src
        ? <a className={`doc-photo doc-photo-${size}`} href={src} target="_blank" rel="noreferrer" aria-label="Open PDF">{body}</a>
        : <button className={`doc-photo doc-photo-${size}`} onClick={() => setOverlay({ document: { kind: "photo", id: doc.id } })} aria-label="Open photo">{body}</button>}
      {doc.simulated && <span className="sim-tag">Simulated</span>}
    </span>
  );
}

function DocHeader({ doc }: { doc: DriverDoc }) {
  const { data } = useApp();
  const driver = byId(data.drivers, doc.driverId);
  return (
    <div className="doc-head">
      <strong>
        {doc.simulated
          ? `Simulated: ${driver?.name.split(" ")[0]}'s phone (sample picture, generated figures)`
          : doc.channel === "Operations" ? "Filed by the office" : `${driver?.name.split(" ")[0]} sent this ${doc.channel === "App" ? "from the driver app" : `on ${doc.channel}`}`}
      </strong>
      <span className="muted">{stamp(doc.at)}</span>
      {doc.status === "recorded" && <Status tone="ok">Recorded · {doc.recordRef}</Status>}
      {doc.status === "returned" && <Status tone="bad">Returned · {doc.returnReason}</Status>}
      {doc.status === "new" && <Status tone="wait">To check</Status>}
    </div>
  );
}

function ReturnDoc({ doc }: { doc: DriverDoc }) {
  const { run } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <Button tone="quiet" size="sm" onClick={() => setOpen(true)}>
        <Undo2 /> Ask again
      </Button>
    );
  return (
    <div className="inline-form">
      <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What's wrong? e.g. photo is blurred" />
      <Button size="sm" disabled={!reason.trim()} onClick={async () => (await run({ type: "doc.return", docId: doc.id, reason }, "Sent back to the driver on WhatsApp.")) && setOpen(false)}>
        Send
      </Button>
    </div>
  );
}

/** The office uploads the real document (a photo or PDF) for the driver; a person then types the figures from it. */
function UploadDoc({ trip, kind, label }: { trip: Trip; kind: DocKind; label: string }) {
  const { run, toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const choose = async (file: File | undefined) => {
    if (!file || !trip.driverId) return;
    setBusy(true);
    try {
      const stored = await uploadFile(file);
      await run({ type: "doc.send", driverId: trip.driverId, tripId: trip.id, kind, channel: "Operations", file: { name: stored.name, mime: stored.mime, fileId: stored.id } }, "Uploaded. Type the figures from it.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "The upload failed.", "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void choose(e.target.files?.[0])} />
      <Button busy={busy} onClick={() => input.current?.click()}>
        <Upload /> {label}
      </Button>
    </>
  );
}

/* ================= Loading ================= */

function MeasureForm({
  trip,
  mode,
  doc,
  consignment,
  onDone,
}: {
  trip: Trip;
  mode: "load" | "deliver";
  doc?: DriverDoc;
  consignment?: Consignment;
  onDone?: () => void;
}) {
  const { data, run } = useApp();
  const read = doc?.read ?? {};
  const [productId, setProductId] = useState(read.productId ?? consignment?.productId ?? trip.productId ?? data.products[0].id);
  const product = byId(data.products, productId)!;
  const [docNo, setDocNo] = useState(read.docNo ?? "");
  const [consignor, setConsignor] = useState(read.consignor ?? "");
  const [consignee, setConsignee] = useState(read.consignee ?? byId(data.customers, trip.customerId)?.name ?? "");
  const [qty, setQty] = useState(String(read.ambientL ?? read.qty ?? ""));
  const [temp, setTemp] = useState(read.tempC != null ? String(read.tempC) : "");
  const [density, setDensity] = useState(read.density != null ? String(read.density) : "");
  const [cert, setCert] = useState("");
  const fuel = product.kind === "fuel";
  const measure = fuel && qty && temp && density ? measureFuel(product, { ambientL: Number(qty), tempC: Number(temp), density: Number(density) }) : undefined;
  const preview =
    mode === "deliver" && consignment && measure
      ? shortageFor(data, { ...consignment, delivered: { ...measure, certStd20L: cert ? Number(cert) : undefined, at: "", podNo: "" } })
      : undefined;
  const submit = async () => {
    const common = {
      qty: Number(qty),
      ambientL: fuel ? Number(qty) : undefined,
      tempC: fuel ? Number(temp) : undefined,
      density: fuel ? Number(density) : undefined,
      certStd20L: cert ? Number(cert) : undefined,
      docId: doc?.id,
    };
    const ok =
      mode === "load"
        ? await run({ type: "load.record", tripId: trip.id, productId, invoiceNo: docNo, consignor, consignee, ...common }, "Loading recorded. The driver is told.")
        : await run({ type: "delivery.record", consignmentId: consignment!.id, podNo: docNo, ...common }, "Delivery recorded.");
    if (ok) onDone?.();
  };
  return (
    <div className="measure">
      <div className="grid-3">
        {mode === "load" && (
          <Field label="Product">
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              {data.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={mode === "load" ? "Invoice no." : "Delivery note no."}>
          <input value={docNo} onChange={(e) => setDocNo(e.target.value)} />
        </Field>
        {mode === "load" && (
          <>
            <Field label="Consignor">
              <input value={consignor} onChange={(e) => setConsignor(e.target.value)} />
            </Field>
            <Field label="Consignee">
              <input value={consignee} onChange={(e) => setConsignee(e.target.value)} />
            </Field>
          </>
        )}
        <Field label={fuel ? "Observed litres" : `Quantity (${product.unit})`}>
          <input type="number" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        {fuel && (
          <>
            <Field label="Temperature">
              <span className="suffix">
                <input type="number" inputMode="decimal" step="0.1" value={temp} onChange={(e) => setTemp(e.target.value)} />
                <span>°C</span>
              </span>
            </Field>
            <Field label="Density">
              <span className="suffix">
                <input type="number" inputMode="decimal" step="0.1" value={density} onChange={(e) => setDensity(e.target.value)} />
                <span>kg/m³</span>
              </span>
            </Field>
            <Field label="Certificate at 20 °C" hint="Only if the terminal printed one">
              <span className="suffix">
                <input type="number" inputMode="decimal" value={cert} onChange={(e) => setCert(e.target.value)} placeholder="Optional" />
                <span>L</span>
              </span>
            </Field>
          </>
        )}
      </div>
      {measure && (
        <div className="calc-strip" aria-live="polite">
          <span>
            {num(Number(qty))} L × <b>{measure.vcf?.toFixed(5)}</b> correction
          </span>
          <ArrowRight size={15} />
          <strong>{L(cert ? Number(cert) : measure.std20L)} at 20 °C</strong>
          {preview && (
            <span className={`calc-short ${preview.netShortL > 0 ? "bad" : "ok"}`}>
              {preview.netShortL > 0
                ? `${L(preview.netShortL)} short beyond ${preview.allowancePct}% · ${zmw(preview.amountZmw)}`
                : `Loss ${L(preview.lossL)}, within ${preview.allowancePct}%`}
            </span>
          )}
        </div>
      )}
      <div className="measure-actions">
        {doc && <ReturnDoc doc={doc} />}
        <Button tone="primary" size="lg" disabled={!docNo.trim() || !(Number(qty) > 0) || (fuel && (!temp || !density))} onClick={submit}>
          <Check /> {mode === "load" ? "Confirm loading" : "Confirm delivery"}
        </Button>
      </div>
    </div>
  );
}

function Ticket({ consignment, part }: { consignment: Consignment; part: "load" | "deliver" }) {
  const { data } = useApp();
  const product = byId(data.products, consignment.productId);
  const m = part === "load" ? consignment.load : consignment.delivered!;
  const fuel = product?.kind === "fuel";
  return (
    <div className="ticket">
      <div className="ticket-head">
        <span className="ticket-kicker">{part === "load" ? "Loading ticket" : "Delivery ticket"}</span>
        <span className="mono">{consignment.no}</span>
      </div>
      <div className="ticket-title">
        <strong>{product?.name}</strong>
        <span>
          {consignment.consignor} → {consignment.consignee}
        </span>
      </div>
      <dl className="ticket-grid">
        <div>
          <dt>{part === "load" ? "Invoice" : "Delivery note"}</dt>
          <dd className="mono">{part === "load" ? consignment.invoiceNo : consignment.delivered?.podNo}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{stamp(part === "load" ? consignment.loadedAt : consignment.delivered?.at)}</dd>
        </div>
        {fuel ? (
          <>
            <div>
              <dt>Observed</dt>
              <dd>{L(m.ambientL)}</dd>
            </div>
            <div>
              <dt>Temperature</dt>
              <dd>{num(m.tempC, 1)} °C</dd>
            </div>
            <div>
              <dt>Density</dt>
              <dd>{num(m.density, 1)} kg/m³</dd>
            </div>
            <div>
              <dt>Correction</dt>
              <dd>{m.vcf?.toFixed(5)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Quantity</dt>
            <dd>
              {num(m.qty, 2)} {m.unit}
            </dd>
          </div>
        )}
      </dl>
      {fuel && (
        <div className="ticket-total">
          <span>At 20 °C</span>
          <strong>{L(volume20(m))}</strong>
        </div>
      )}
      <span className="ticket-punch" aria-hidden />
    </div>
  );
}

function LoadingPanel({ trip }: { trip: Trip }) {
  const { data, role } = useApp();
  const [manual, setManual] = useState(false);
  const load = trip.stops.find((s) => s.kind === "load");
  const consignment = data.consignments.find((c) => c.tripId === trip.id);
  const docs = data.docs.filter((d) => d.tripId === trip.id && d.kind === "loading").slice().reverse();
  const open = docs.find((d) => d.status === "new");
  const ops = role === "operations" || role === "owner";
  if (!trip.dispatchedAt)
    return (
      <Card>
        <Empty title={`Loading at ${placeName(data, load?.placeId)}`}>
          <span>Opens once the truck is dispatched.</span>
        </Empty>
      </Card>
    );
  return (
    <div className="stack">
      <Card
        title={placeName(data, load?.placeId)}
        aside={load?.arrivedAt ? <Status tone="ok">Arrived {stamp(load.arrivedAt)}</Status> : <Status tone="info">On the way</Status>}
      >
        {consignment ? (
          <Ticket consignment={consignment} part="load" />
        ) : open ? (
          <div className="doc-review">
            <DocPhoto doc={open} />
            <div className="doc-review-form">
              <DocHeader doc={open} />
              {ops ? <MeasureForm key={open.id} trip={trip} mode="load" doc={open} /> : <p className="muted">Operations is checking it.</p>}
            </div>
          </div>
        ) : manual && ops ? (
          <MeasureForm trip={trip} mode="load" onDone={() => setManual(false)} />
        ) : (
          <div className="waiting">
            <span className="waiting-pulse" aria-hidden />
            <div>
              <strong>{load?.arrivedAt ? "Waiting for the loading invoice" : `Arriving at ${placeName(data, load?.placeId)}`}</strong>
              <span className="muted">The driver sends a photo from the driver app, or you upload it here.</span>
            </div>
            {ops && <UploadDoc trip={trip} kind="loading" label="Upload the invoice" />}
            {ops && (
              <Button tone="quiet" onClick={() => setManual(true)}>
                Type it without a photo
              </Button>
            )}
          </div>
        )}
      </Card>
      {docs.filter((d) => d !== open && d.status !== "recorded").length > 0 && (
        <Card title="Earlier photos" tone="quiet">
          {docs
            .filter((d) => d !== open && d.status !== "recorded")
            .map((d) => (
              <div key={d.id} className="doc-line">
                <DocPhoto doc={d} size="sm" />
                <DocHeader doc={d} />
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}

/* ================= Transit ================= */

function TransitPanel({ trip }: { trip: Trip }) {
  const { data, role, run, setOverlay } = useApp();
  const sim = useSim();
  const total = tripKm(trip);
  const at = trip.tracking?.km ?? 0;
  const cum = cumulativeKm(trip);
  const nextIndex = cum.findIndex((k, i) => i > 0 && !trip.stops[i].arrivedAt);
  const next = trip.stops[nextIndex];
  const remainingKm = next ? cum[nextIndex] - at : 0;
  const eta = next ? new Date(Date.now() + data.settings.clockOffsetMs + (remainingKm / 60) * 36e5).toISOString() : undefined;
  const receipts = data.docs.filter((d) => d.tripId === trip.id && (d.kind === "expense" || d.kind === "fuel"));
  const running = sim.tripId === trip.id && sim.running;
  const ops = role === "operations" || role === "owner";
  const cons = data.consignments.filter((c) => c.tripId === trip.id);
  const blocked =
    (!cons.length && nextIndex > trip.stops.findIndex((s) => s.kind === "load")) ||
    (!cons.every((c) => c.delivered) && nextIndex > trip.stops.findIndex((s) => s.kind === "offload"));
  if (!trip.dispatchedAt)
    return (
      <Card>
        <Empty title="Not on the road yet" />
      </Card>
    );
  return (
    <div className="stack">
      <Card
        title="Live"
        aside={
          <Button size="sm" onClick={() => setOverlay({ tracking: trip.id })}>
            <MapPin /> Open map
          </Button>
        }
      >
        <div className="progress-line" aria-label={`${Math.round(at)} of ${Math.round(total)} km`}>
          <div className="progress-track">
            <motion.span className="progress-fill" animate={{ width: `${(at / Math.max(total, 1)) * 100}%` }} transition={{ type: "spring", stiffness: 90, damping: 20 }} />
            {cum.map((k, i) => (i > 0 && i < cum.length - 1 ? <i key={i} style={{ left: `${(k / Math.max(total, 1)) * 100}%` }} className={trip.stops[i].arrivedAt ? "hit" : ""} /> : null))}
          </div>
          <div className="progress-ends">
            <span>{placeName(data, trip.stops[0].placeId)}</span>
            <span>{placeName(data, trip.stops.at(-1)?.placeId)}</span>
          </div>
        </div>
        <div className="live-stats">
          <div>
            <span>Covered</span>
            <strong>{km(at)}</strong>
          </div>
          <div>
            <span>Speed</span>
            <strong>{activeTrip(trip) ? `${Math.round(trip.tracking?.speed ?? 0)} km/h` : "Parked"}</strong>
          </div>
          <div>
            <span>Next</span>
            <strong>{next ? placeName(data, next.placeId) : "Arrived"}</strong>
          </div>
          <div>
            <span>ETA</span>
            <strong>{eta && activeTrip(trip) ? `${day(eta)}, ${hm(eta)}` : "—"}</strong>
          </div>
          <div>
            <span>Fuel now</span>
            <strong>{L(fuelNow(data, trip))}</strong>
          </div>
        </div>
        {ops && activeTrip(trip) && (
          <div className="sim-row">
            <Button tone={running ? "secondary" : "primary"} onClick={() => (running ? sim.stop() : sim.start(trip.id))}>
              {running ? <Pause /> : <Play />} {running ? "Pause" : "Simulate drive"}
            </Button>
            {next && !running && !blocked && (
              <Button tone="quiet" onClick={() => run({ type: "trip.arrive", tripId: trip.id, stopId: next.id }, `Marked at ${placeName(data, next.placeId)}.`)}>
                Mark at {placeName(data, next.placeId)}
              </Button>
            )}
            {sim.note && sim.tripId === trip.id && <span className="muted">{sim.note}</span>}
          </div>
        )}
      </Card>
      <Card title="Stops">
        <StopsTimeline trip={trip} />
      </Card>
      {receipts.length > 0 && (
        <Card title="Receipts from the road">
          {receipts.map((d) => (
            <div key={d.id} className="doc-line">
              <DocPhoto doc={d} size="sm" />
              <div className="doc-line-text">
                <strong>{d.read?.amount ? cash(d.read.amount, d.read.currency ?? "ZMW") : "Receipt"}</strong>
                <span className="muted">
                  {byId(data.categories, d.read?.categoryId)?.name} · {stamp(d.at)}
                </span>
              </div>
              <ReceiptStatus doc={d} />
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function ReceiptStatus({ doc }: { doc: DriverDoc }) {
  const { data } = useApp();
  const expense = data.expenses.find((e) => e.docId === doc.id);
  if (doc.status === "returned") return <Status tone="bad">Returned</Status>;
  if (!expense) return <Status tone="wait">With Finance</Status>;
  return expense.status === "approved" ? <Status tone="ok">Approved</Status> : expense.status === "rejected" ? <Status tone="bad">Rejected</Status> : <Status tone="wait">With Finance</Status>;
}

/* ================= Offloading ================= */

function OffloadingPanel({ trip }: { trip: Trip }) {
  const { data, role } = useApp();
  const [manual, setManual] = useState(false);
  const offload = trip.stops.find((s) => s.kind === "offload");
  const consignment = data.consignments.find((c) => c.tripId === trip.id);
  const docs = data.docs.filter((d) => d.tripId === trip.id && d.kind === "delivery").slice().reverse();
  const open = docs.find((d) => d.status === "new");
  const ops = role === "operations" || role === "owner";
  if (!consignment)
    return (
      <Card>
        <Empty title={`Offloading at ${placeName(data, offload?.placeId)}`}>
          <span>Opens after loading.</span>
        </Empty>
      </Card>
    );
  return (
    <div className="stack">
      <Card
        title={placeName(data, offload?.placeId)}
        aside={offload?.arrivedAt ? <Status tone="ok">Arrived {stamp(offload.arrivedAt)}</Status> : <Status tone="info">On the way</Status>}
      >
        {consignment.delivered ? (
          <div className="ticket-pair">
            <Ticket consignment={consignment} part="load" />
            <Ticket consignment={consignment} part="deliver" />
          </div>
        ) : open ? (
          <div className="doc-review">
            <DocPhoto doc={open} />
            <div className="doc-review-form">
              <DocHeader doc={open} />
              {ops ? <MeasureForm key={open.id} trip={trip} mode="deliver" doc={open} consignment={consignment} /> : <p className="muted">Operations is checking it.</p>}
            </div>
          </div>
        ) : manual && ops ? (
          <MeasureForm trip={trip} mode="deliver" consignment={consignment} onDone={() => setManual(false)} />
        ) : (
          <div className="waiting">
            <span className="waiting-pulse" aria-hidden />
            <div>
              <strong>{offload?.arrivedAt ? "Waiting for the delivery note" : `Driving to ${placeName(data, offload?.placeId)}`}</strong>
              <span className="muted">Loaded {consignment.load.unit === "L" ? L(volume20(consignment.load)) + " at 20 °C" : `${consignment.load.qty} ${consignment.load.unit}`}.</span>
            </div>
            {ops && offload?.arrivedAt && <UploadDoc trip={trip} kind="delivery" label="Upload the delivery note" />}
            {ops && offload?.arrivedAt && <Button tone="quiet" onClick={() => setManual(true)}>Type it without a photo</Button>}
          </div>
        )}
      </Card>
      {consignment.shortage && <ShortageCard consignment={consignment} />}
    </div>
  );
}

export function ShortageCard({ consignment }: { consignment: Consignment }) {
  const { role, run } = useApp();
  const s = consignment.shortage!;
  const [note, setNote] = useState("");
  const [waiving, setWaiving] = useState(false);
  const finance = role === "finance" || role === "owner";
  return (
    <Card
      title="Fuel reconciliation"
      tone={s.status === "pending" && finance ? "mine" : undefined}
      aside={
        s.status === "none" ? (
          <Status tone="ok">Within allowance</Status>
        ) : s.status === "pending" ? (
          <Status tone="wait">With Finance</Status>
        ) : s.status === "charged" ? (
          <Status tone="bad">Charged to driver</Status>
        ) : (
          <Status tone="mute">Waived</Status>
        )
      }
    >
      <table className="recon">
        <tbody>
          <tr>
            <td>Loaded at 20 °C</td>
            <td className="num">{L(s.loaded20L)}</td>
          </tr>
          <tr>
            <td>Delivered at 20 °C</td>
            <td className="num">− {L(s.delivered20L)}</td>
          </tr>
          <tr className="sub">
            <td>Transit loss</td>
            <td className="num">{L(s.lossL)}</td>
          </tr>
          <tr>
            <td>Allowance {s.allowancePct}%</td>
            <td className="num">− {L(s.allowanceL)}</td>
          </tr>
          <tr className="sub">
            <td>Net shortage</td>
            <td className="num">{L(s.netShortL)}</td>
          </tr>
          <tr className="total">
            <td>
              At {s.rateUsd} USD per litre
            </td>
            <td className="num">{zmw(s.amountZmw)}</td>
          </tr>
        </tbody>
      </table>
      {s.status === "pending" && finance && (
        <div className="req-actions">
          {!waiving ? (
            <>
              <Button tone="primary" onClick={() => run({ type: "shortage.decide", consignmentId: consignment.id, charge: true }, "Charged to the driver's account.")}>
                Charge {zmw(s.amountZmw)}
              </Button>
              <Button tone="quiet" onClick={() => setWaiving(true)}>
                Waive
              </Button>
            </>
          ) : (
            <div className="inline-form">
              <input className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why waive it?" />
              <Button disabled={!note.trim()} onClick={() => run({ type: "shortage.decide", consignmentId: consignment.id, charge: false, note }, "Shortage waived.")}>
                Waive
              </Button>
            </div>
          )}
        </div>
      )}
      {s.note && <p className="req-note">{s.note}</p>}
    </Card>
  );
}

/* ================= Close ================= */

function ClosePanel({ trip }: { trip: Trip }) {
  const { data, role, run } = useApp();
  const truck = byId(data.trucks, trip.truckId)!;
  const estimate = Math.round(fuelNow(data, trip) / 5) * 5;
  const [closing, setClosing] = useState(String(estimate));
  const delivered = data.consignments.some((c) => c.tripId === trip.id) && data.consignments.filter((c) => c.tripId === trip.id).every((c) => c.delivered);
  const issued = data.requests.filter((r) => r.tripId === trip.id && r.kind === "fuel" && r.status === "issued").reduce((s, r) => s + r.amount, 0);
  const used = trip.openingFuelL + issued - Number(closing || 0);
  const variance = used - trip.fuelBudgetL;
  const ops = role === "operations" || role === "owner";
  if (trip.endedAt) {
    const actual = tripFuelUsed(data, trip) ?? 0;
    return (
      <Card title={`Ended at ${placeName(data, trip.stops.at(-1)?.placeId)}`} aside={<Status tone="ok">{stamp(trip.endedAt)}</Status>}>
        <Rows
          rows={[
            ["Distance", km(tripKm(trip))],
            ["Fuel at start", L(trip.openingFuelL)],
            ["Fuel issued", L(issued)],
            ["Fuel left", L(trip.closingFuelL)],
            ["Fuel used", `${L(actual)} · ${num(tripKm(trip) / Math.max(actual, 1), 2)} km/L`],
            ["Against budget", <span className={actual > trip.fuelBudgetL ? "bad" : "ok"}>{actual > trip.fuelBudgetL ? "+" : ""}{L(actual - trip.fuelBudgetL)}</span>],
            ["Truck", `${truck.plate} is free at ${placeName(data, truck.placeId)}`],
          ]}
        />
      </Card>
    );
  }
  if (!delivered)
    return (
      <Card>
        <Empty title="Close the trip after delivery" />
      </Card>
    );
  return (
    <Card title={`End at ${placeName(data, trip.stops.at(-1)?.placeId)}`} tone={ops ? "mine" : undefined}>
      <div className="close-grid">
        <Field label="Fuel left in the tank" hint={`Our estimate from ${km(tripKm(trip))} driven is ${L(estimate)}`}>
          <span className="suffix">
            <input type="number" min={0} value={closing} onChange={(e) => setClosing(e.target.value)} disabled={!ops} />
            <span>L</span>
          </span>
        </Field>
        <div className="fuel-check">
          <Rows
            rows={[
              ["Used", L(used)],
              ["Budget", L(trip.fuelBudgetL)],
              ["Difference", <span className={variance > 0 ? "bad" : "ok"}>{variance > 0 ? "+" : ""}{L(variance)}</span>],
            ]}
          />
        </div>
      </div>
      {ops && (
        <div className="measure-actions">
          <Button tone="primary" size="lg" onClick={() => run({ type: "trip.end", tripId: trip.id, closingFuelL: Number(closing) }, `${truck.plate} is free at ${placeName(data, trip.stops.at(-1)?.placeId)}.`)}>
            <Check /> End trip and free the truck
          </Button>
        </div>
      )}
    </Card>
  );
}

/* ================= Settlement ================= */

function SettlePanel({ trip }: { trip: Trip }) {
  const { data, role, run, nav } = useApp();
  const driver = byId(data.drivers, trip.driverId);
  const settlement = byId(data.settlements, trip.settlementId);
  const advances = data.requests.filter((r) => r.tripId === trip.id && r.kind === "cash" && r.status === "issued");
  const expenses = data.expenses.filter((e) => e.tripId === trip.id);
  const receipts = data.docs.filter((d) => d.tripId === trip.id && (d.kind === "expense" || d.kind === "fuel") && d.status === "new");
  const shortage = data.consignments.filter((c) => c.tripId === trip.id && c.shortage?.status === "charged");
  const adv = advances.reduce((s, r) => s + (r.currency === "USD" ? r.amount * (r.fxAtIssue ?? data.settings.fxZmwPerUsd) : r.amount), 0);
  const exp = expenses.filter((e) => e.status === "approved").reduce((s, e) => s + e.amountZmw, 0);
  const sh = shortage.reduce((s, c) => s + c.shortage!.amountZmw, 0);
  const finance = role === "finance" || role === "owner";
  return (
    <div className="stack">
      <Card title="This trip's cash" aside={settlement ? <Status tone="ok">Settled in {settlement.no}</Status> : trip.endedAt ? <Status tone="wait">Next statement</Status> : undefined}>
        <table className="recon">
          <tbody>
            <tr>
              <td>Advances paid</td>
              <td className="num">{zmw(adv)}</td>
            </tr>
            <tr>
              <td>Approved expenses</td>
              <td className="num">− {zmw(exp)}</td>
            </tr>
            {sh > 0 && (
              <tr>
                <td>Fuel shortage charged</td>
                <td className="num">+ {zmw(sh)}</td>
              </tr>
            )}
            <tr className="total">
              <td>Left with {driver?.name.split(" ")[0]} from this trip</td>
              <td className="num">{zmw(adv - exp + sh)}</td>
            </tr>
          </tbody>
        </table>
        {driver && (
          <div className="settle-foot">
            <span className="muted">
              {driver.name}'s whole account: <b className="num">{zmw(driverBalance(data, driver.id))}</b>
            </span>
            {finance && trip.endedAt && !settlement && (
              <Button tone="primary" onClick={() => nav({ view: "settle", driverId: driver.id })}>
                Open statement <ArrowRight />
              </Button>
            )}
            {!finance && trip.endedAt && !settlement && (
              <Button disabled={Boolean(driver.settleRequestedAt)} onClick={() => run({ type: "settlement.request", driverId: driver.id }, "Finance asked on WhatsApp.")}>
                {driver.settleRequestedAt ? "Finance asked" : "Ask Finance to settle"}
              </Button>
            )}
            {settlement && (
              <Button onClick={() => nav({ view: "statement", driverId: driver.id })}>View statement</Button>
            )}
          </div>
        )}
      </Card>
      {(expenses.length > 0 || receipts.length > 0) && (
        <Card title="Expenses">
          {receipts.map((d) => (
            <ReceiptReview key={d.id} doc={d} />
          ))}
          {expenses.map((e) => (
            <div key={e.id} className="doc-line">
              {e.docId && byId(data.docs, e.docId) ? <DocPhoto doc={byId(data.docs, e.docId)!} size="sm" /> : <span className="doc-photo doc-photo-sm blank" />}
              <div className="doc-line-text">
                <strong>
                  {byId(data.categories, e.categoryId)?.name} · <span className="num">{cash(e.amount, e.currency)}</span>
                </strong>
                <span className="muted">
                  <span className="mono">{e.no}</span> · {stamp(e.at)}
                </span>
              </div>
              {e.status === "pending" && finance ? (
                <span className="row-buttons">
                  <Button size="sm" tone="primary" onClick={() => run({ type: "expense.decide", id: e.id, approve: true }, "Approved.")}>
                    Approve
                  </Button>
                  <Button size="sm" tone="danger" onClick={() => run({ type: "expense.decide", id: e.id, approve: false, reason: "No valid receipt" }, "Rejected.")}>
                    Reject
                  </Button>
                </span>
              ) : (
                <Status tone={e.status === "approved" ? "ok" : e.status === "rejected" ? "bad" : "wait"}>{e.status === "approved" ? "Approved" : e.status === "rejected" ? "Rejected" : "With Finance"}</Status>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export function ReceiptReview({ doc }: { doc: DriverDoc }) {
  const { data, role, run } = useApp();
  const read = doc.read ?? {};
  const [categoryId, setCategoryId] = useState(read.categoryId ?? data.categories[0].id);
  const [amount, setAmount] = useState(String(read.amount ?? ""));
  const [currency, setCurrency] = useState<Currency>(read.currency ?? ((data.baseCurrency?.code ?? "ZMW") as Currency));
  const finance = role === "finance" || role === "owner";
  const driver = byId(data.drivers, doc.driverId);
  return (
    <div className="receipt-review">
      <DocPhoto doc={doc} />
      <div className="receipt-form">
        <div className="doc-head">
          <strong>{driver?.name}</strong>
          <span className="muted">
            {byId(data.trips, doc.tripId)?.no ?? "No trip"} · {stamp(doc.at)} · read from photo
          </span>
        </div>
        <div className="grid-3">
          <Field label="Type">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!finance}>
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!finance} />
          </Field>
          <Field label="Currency">
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} disabled={!finance}>
              <option>ZMW</option>
              <option>USD</option>
            </select>
          </Field>
        </div>
        {finance ? (
          <div className="row-buttons">
            <ReturnDoc doc={doc} />
            <Button
              tone="primary"
              disabled={!(Number(amount) > 0)}
              onClick={() =>
                run(
                  { type: "expense.record", driverId: doc.driverId, tripId: doc.tripId, categoryId, amount: Number(amount), currency, receiptNo: read.docNo, docId: doc.id },
                  "Approved. It's off the driver's balance.",
                )
              }
            >
              <Check /> Approve {Number(amount) > 0 ? cash(Number(amount), currency) : ""}
            </Button>
          </div>
        ) : (
          <Status tone="wait">With Finance</Status>
        )}
      </div>
    </div>
  );
}

export type { AppData };
