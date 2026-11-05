import { usePlacement } from "./usePlacement";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, CircleDollarSign, Droplets } from "lucide-react";
import { useApp } from "../store";
import { useMay } from "../api/session";
import { byId, carriedIn, driverBalance, funding } from "../domain/calc";
import { routeLabel, toSettle } from "../domain/helpers";
import type { FundRequest } from "../domain/types";
import { Avatar, Button, Status } from "../ui/kit";
import { ago, cash, L, zmw } from "../ui/format";
import { Card, ExpenseDecision, ReceiptReview, ShortageCard } from "./stages";

export function FinanceToday() {
  const { data, role, run, nav } = useApp();
  const may = useMay();
  // Only the work this person may do: approvals by the company's approval policy, the rest by permission.
  const toApprove = data.requests.filter((r) => (r.status === "pending" || r.status === "owner") && r.mayDecide);
  const toPay = may("request.issue") ? data.requests.filter((r) => r.status === "approved") : [];
  const receipts = may("expense.record") ? data.docs.filter((d) => d.status === "new" && (d.kind === "expense" || d.kind === "fuel")) : [];
  const expenses = data.expenses.filter((e) => e.status === "pending" && e.mayDecide);
  const shortages = data.consignments.filter((c) => c.shortage?.status === "pending" && (may("shortage.decide") || c.shortage.mayWaive));
  const settle = may("settlement.post")
    ? data.drivers
      .map((d) => ({ driver: d, trips: data.trips.filter((t) => t.driverId === d.id && toSettle(t)) }))
      .filter((x) => x.trips.length)
    : [];
  const [picked, setPicked] = useState<string[]>([]);
  const pickable = toApprove;
  const allClear = !toApprove.length && !toPay.length && !receipts.length && !expenses.length && !shortages.length && !settle.length;
  const approvePicked = async () => {
    let ok = 0;
    for (const id of picked) if (await run({ type: "request.decide", id, approve: true })) ok++;
    setPicked([]);
    if (ok) await run({ type: "thread.read", thread: role }, `${ok} approved.`);
  };
  return (
    <div className="desk">
      <div className="kpis">
        <Kpi label="To approve" value={toApprove.length} tone={toApprove.length ? "you" : undefined} />
        <Kpi label="To pay" value={toPay.length} tone={toPay.length ? "you" : undefined} />
        <Kpi label="Receipts" value={receipts.length + expenses.length} tone={receipts.length + expenses.length ? "you" : undefined} />
        <Kpi label="Drivers to settle" value={settle.length} />
        <Kpi label="Cash with drivers" value={zmw(data.drivers.reduce((s, d) => s + Math.max(0, driverBalance(data, d.id)), 0))} />
      </div>
      {allClear && (
        <div className="all-clear">
          <svg viewBox="0 0 80 80" aria-hidden>
            <circle cx="40" cy="40" r="34" />
            <path d="M26 41l10 10 18-22" />
          </svg>
          <strong>Nothing waiting on Finance</strong>
        </div>
      )}
      {toApprove.length > 0 && (
        <Card
          title="Approve"
          aside={
            <AnimatePresence>
              {picked.length > 0 && (
                <motion.span initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                  <Button tone="primary" size="sm" onClick={approvePicked}>
                    <Check /> Approve {picked.length} selected
                  </Button>
                </motion.span>
              )}
            </AnimatePresence>
          }
        >
          <div className="approvals">
            {toApprove.map((r) => (
              <Approval
                key={r.id}
                request={r}
                picked={picked.includes(r.id)}
                onPick={pickable.includes(r) ? () => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id])) : undefined}
              />
            ))}
          </div>
        </Card>
      )}
      {toPay.length > 0 && (
        <Card title="Pay">
          <div className="approvals">
            {toPay.map((r) => (
              <PayRow key={r.id} request={r} />
            ))}
          </div>
        </Card>
      )}
      {(receipts.length > 0 || expenses.length > 0) && (
        <Card title="Driver receipts">
          {receipts.map((d) => (
            <ReceiptReview key={d.id} doc={d} />
          ))}
          {expenses.map((e) => {
            const driver = byId(data.drivers, e.driverId);
            return (
              <div key={e.id} className="doc-line">
                <Avatar name={driver?.name ?? "?"} size={32} />
                <div className="doc-line-text">
                  <strong>
                    {byId(data.categories, e.categoryId)?.name} · <span className="num">{cash(e.amount, e.currency)}</span>
                  </strong>
                  <span className="muted">
                    {driver?.name} · recorded by Operations · {ago(data, e.at)}
                    {e.movedUpFrom ? ` · ${e.movedUpFrom} did not decide in time` : ""}
                  </span>
                </div>
                <ExpenseDecision expense={e} />
              </div>
            );
          })}
        </Card>
      )}
      {shortages.map((c) => {
        const trip = byId(data.trips, c.tripId)!;
        return (
          <div key={c.id} className="labelled">
            <button className="labelled-head" onClick={() => nav({ tripId: trip.id, view: "offloading" })}>
              {trip.no} · {byId(data.drivers, trip.driverId)?.name} <ArrowRight size={14} />
            </button>
            <ShortageCard consignment={c} />
          </div>
        );
      })}
      {settle.length > 0 && (
        <Card title="Settle drivers">
          <div className="settle-list">
            {settle.map(({ driver, trips }) => {
              const balance = driverBalance(data, driver.id);
              return (
                <button key={driver.id} className="settle-row" onClick={() => nav({ view: "settle", driverId: driver.id })}>
                  <Avatar name={driver.name} tone="sky" size={36} />
                  <span className="settle-who">
                    <strong>{driver.name}</strong>
                    <span className="muted">
                      {trips.length} closed trip{trips.length === 1 ? "" : "s"}
                      {driver.settleRequestedAt ? ` · asked ${ago(data, driver.settleRequestedAt)} ago` : ""}
                    </span>
                  </span>
                  <span className={`balance ${balance > 0 ? "holds" : balance < 0 ? "owed" : ""}`}>
                    {balance > 0 ? `Holds ${zmw(balance)}` : balance < 0 ? `Owed ${zmw(-balance)}` : "Clear"}
                  </span>
                  <ArrowRight size={16} />
                </button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: "you" }) {
  return (
    <div className={`kpi ${tone ? "kpi-you" : ""}`}>
      <span>{label}</span>
      <strong className="num">{value}</strong>
    </div>
  );
}

export function Approval({ request, picked, onPick }: { request: FundRequest; picked: boolean; onPick?: () => void }) {
  const company = usePlacement("fund-requests", "approve", request.custom);
  const { data, role, run, nav } = useApp();
  const trip = byId(data.trips, request.tripId)!;
  const truck = byId(data.trucks, trip.truckId);
  const driver = byId(data.drivers, trip.driverId);
  const f = funding(data, trip);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const amount = request.kind === "fuel" ? L(request.amount) : cash(request.amount, request.currency);
  const over = request.amount > request.suggested + 0.001;
  const holds = carriedIn(data, trip);
  const context = useMemo(
    () =>
      request.kind === "fuel"
        ? [
            ["Budget", L(trip.fuelBudgetL)],
            ["In the tank", L(f.fuel.onTruck)],
            ["Suggested", L(request.suggested)],
          ]
        : [
            ["Budget", zmw(trip.cashBudgetZmw)],
            [holds >= 0 ? "Driver holds" : "Company owes", zmw(Math.abs(holds))],
            ["Suggested", zmw(request.suggested)],
          ],
    [request, trip, f, holds],
  );
  return (
    <div className={`approval ${picked ? "picked" : ""} ${over ? "over" : ""}`}>
      {onPick ? (
        <label className="check">
          <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select ${request.no}`} />
          <span />
        </label>
      ) : (
        <span />
      )}
      <span className={`req-kind ${request.kind}`}>{request.kind === "fuel" ? <Droplets size={16} /> : <CircleDollarSign size={16} />}</span>
      <div className="approval-main">
        <div className="approval-top">
          <strong className="num">{amount}</strong>
          <span>{request.kind === "fuel" ? "fuel for" : "advance for"}</span>
          <button className="link-btn" onClick={() => nav({ tripId: trip.id, view: "funding" })}>
            {truck?.plate} · {driver?.name}
          </button>
          {request.level && request.level.current > 1 && <Status tone="wait">Approval {request.level.current} of {request.level.of}</Status>}
          {request.movedUpFrom && <Status tone="wait">{request.movedUpFrom} did not decide in time</Status>}
        </div>
        <span className="muted">
          <span className="mono">{trip.no}</span> · {routeLabel(data, trip)} · asked {ago(data, request.createdAt)} ago
        </span>
        <div className="approval-context">
          {context.map(([k, v]) => (
            <span key={k}>
              {k} <b className="num">{v}</b>
            </span>
          ))}
        </div>
        {over && <p className="over-note">Above the suggestion{request.reason ? `: ${request.reason}` : ""}. {request.level && request.level.current < request.level.of ? "Another level approves after you." : ""}</p>}
        {rejecting && (
          <div className="inline-form">
            <input className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason" />
            <Button tone="danger" size="sm" disabled={!note.trim()} onClick={() => run({ type: "request.decide", id: request.id, approve: false, note }, "Rejected. Operations is told.")}>
              Reject
            </Button>
            <Button tone="quiet" size="sm" onClick={() => setRejecting(false)}>
              Back
            </Button>
          </div>
        )}
      </div>
      {!rejecting && (
        <div className="approval-actions">
          {company.block}
          <Button tone="primary" disabled={!company.ready} onClick={() => run({ type: "request.decide", custom: company.custom, id: request.id, approve: true }, request.level && request.level.current < request.level.of ? "Approved. Sent to the next approver." : "Approved.")}>
            <Check /> Approve
          </Button>
          <Button tone="quiet" onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function PayRow({ request }: { request: FundRequest }) {
  const paying = usePlacement("fund-requests", "pay", request.custom);
  const { data, run } = useApp();
  const trip = byId(data.trips, request.tripId)!;
  const truck = byId(data.trucks, trip.truckId);
  const driver = byId(data.drivers, trip.driverId);
  // The company's payment methods that suit the request.
  const fuelKinds = ["fuel_card", "fuel_voucher", "own_depot"];
  const methods = (data.paymentMethods ?? []).filter((m) => (request.kind === "fuel" ? m.forFuel || fuelKinds.includes(m.kind) : m.forCash && !fuelKinds.includes(m.kind)));
  const media = methods.length ? methods.map((m) => m.name) : request.kind === "fuel" ? ["Own depot", "Fuel card", "Voucher"] : ["Cash", "Bank transfer"];
  const [medium, setMedium] = useState(media[0]);
  const [reference, setReference] = useState("");
  const amount = request.kind === "fuel" ? L(request.amount) : cash(request.amount, request.currency);
  const code = methods.find((m) => m.name === medium)?.name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "PV";
  const suggestion = `${code}-${request.no.slice(-4)}`;
  return (
    <div className="approval pay">
      <span />
      <span className={`req-kind ${request.kind}`}>{request.kind === "fuel" ? <Droplets size={16} /> : <CircleDollarSign size={16} />}</span>
      <div className="approval-main">
        <div className="approval-top">
          <strong className="num">{amount}</strong>
          <span>to</span>
          <strong>{request.kind === "fuel" ? truck?.plate : driver?.name}</strong>
          <span className="mono muted">{request.no}</span>
        </div>
        <div className="pay-form">
          <div className="segmented small">
            {media.map((m) => (
              <button key={m} className={m === medium ? "on" : ""} onClick={() => setMedium(m)}>
                {m}
              </button>
            ))}
          </div>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={suggestion} aria-label="Reference" />
        </div>
      </div>
      <div className="approval-actions">
        {paying.block}
        <Button
          tone="primary"
          disabled={!paying.ready}
          onClick={() =>
            run(
              { type: "request.issue", custom: paying.custom, id: request.id, medium, reference: reference.trim() || suggestion, station: undefined },
              request.kind === "fuel" ? "Fuel issued. The driver is told." : "Paid. The driver is told.",
            )
          }
        >
          <Check /> {request.kind === "fuel" ? "Issued" : "Paid"}
        </Button>
      </div>
    </div>
  );
}
