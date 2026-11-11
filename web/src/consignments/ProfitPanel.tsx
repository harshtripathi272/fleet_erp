import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { w } from "../domain/words";
import type { Trip } from "../domain/types";
import { Button, Empty, Field, Modal, Status, UnitInput } from "../ui/kit";
import { num } from "../ui/format";
import { RevenuePanel } from "./RevenuePanel";

/**
 * The trip's revenue, costs and profit (#135, design 3.11.8), for people who may see profit: one framed line of
 * figures, the revenue by consignment beside the costs by group, a manual cost, what is waiting for approval, and the
 * budget against what was used, in words.
 */

interface Profit {
  status: "estimate" | "provisional" | "final";
  currency: { id: string; code: string; minorUnits: number };
  revenueMinor: number; costMinor: number; profitMinor: number; marginPercent?: number | null; perKm?: number | null;
  /** Paid back by the driver (a shortage or a write-off charged to them): money in, not a negative cost. */
  recovered?: { amountMinor: number; items: { ref: string; label: string; amountMinor: number }[] };
  km?: number; loadedKm?: number; days?: number;
  revenue: { consignmentId: string; number: string; customer?: string; status: string; amountMinor: number; share?: number; counted?: boolean; note?: string | null }[];
  costs: { group: string; label: string; amountMinor: number; litres?: { opening?: number; issued?: number; closing?: number; used?: number }; items: { ref: string; label: string; amountMinor: number }[] }[];
  pending?: { ref: string; label: string; amountMinor: number }[];
  budget?: { fuelL?: number; cashMinor?: number; usedFuelL?: number; usedCashMinor?: number };
  warnings?: string[];
}

const STATUS: Record<Profit["status"], { label: string; tone: "wait" | "info" | "ok" }> = {
  estimate: { label: "Estimate", tone: "wait" }, provisional: { label: "Provisional", tone: "info" }, final: { label: "Final", tone: "ok" },
};

export function ProfitPanel({ trip }: { trip: Trip }) {
  const { data, me, toast } = useApp();
  const profit = useQuery({ queryKey: ["trip-profit", trip.id], queryFn: () => api<Profit>(`/trips/${trip.id}/profit`) });
  const [adding, setAdding] = useState(false);
  const [openCn, setOpenCn] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  if (profit.isLoading) return <p className="muted">Working out the {w(data, "trip").toLowerCase()}'s profit…</p>;
  if (profit.error || !profit.data) return <Empty title="Profit isn't available">{profit.error instanceof ApiError ? profit.error.message : "The server didn't send it."}</Empty>;
  const p = profit.data;
  const m = (minor: number | null | undefined) => (minor === null || minor === undefined ? "—" : `${num(minor / 10 ** p.currency.minorUnits, p.currency.minorUnits, p.currency.minorUnits)} ${p.currency.code}`);
  const st = STATUS[p.status] ?? STATUS.estimate;
  const cn = openCn ? data.cns.find((c) => c.id === openCn) : undefined;
  const mayAdd = can(me, "trip-profit", "update");

  const removeCost = async (ref: string) => {
    try {
      await api(`/trips/${trip.id}/costs/${ref.replace(/^costs:/, "")}`, { method: "DELETE" });
      toast("Cost removed.");
      await profit.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    }
  };

  return (
    <div className="profit-panel">
      <div className="figure-line profit-figures">
        <div><span>Revenue</span><b>{m(p.revenueMinor)}</b></div>
        {p.recovered?.amountMinor ? <div><span>Recovered</span><b>{m(p.recovered.amountMinor)}</b></div> : null}
        <div><span>Costs</span><b>{m(p.costMinor)}</b></div>
        <div><span>Profit</span><b className={p.profitMinor < 0 ? "profit-loss" : ""}>{m(p.profitMinor)}</b></div>
        <div><span>Margin</span><b>{p.marginPercent === null || p.marginPercent === undefined ? "—" : `${num(p.marginPercent, 1, 1)} %`}</b></div>
        <div><span>Per km</span><b>{m(p.perKm)}</b></div>
        <div><span>Status</span><Status tone={st.tone}>{st.label}</Status></div>
      </div>
      {p.warnings?.length ? <ul className="profit-warnings">{p.warnings.map((x) => <li key={x}>{x}</li>)}</ul> : null}

      <div className="profit-tables">
        <section>
          <h4>Revenue</h4>
          <div className="table-frame">
            <table className="table">
              <thead><tr><th>{w(data, "consignment")}</th><th>Customer</th><th>Status</th><th className="num">Amount</th><th className="num">Share</th></tr></thead>
              <tbody>
                {p.revenue.map((r) => (
                  <tr key={r.consignmentId} className="clickable" onClick={() => setOpenCn(r.consignmentId)}>
                    <td className="mono">{r.number}</td>
                    <td className="cn-party">{r.customer ?? "—"}</td>
                    <td>{r.status}{r.counted === false ? <span className="muted"> · not counted</span> : null}</td>
                    <td className="num">{m(r.amountMinor)}</td>
                    <td className="num">{r.share !== undefined ? `${num(r.share, 0, 1)} %` : ""}</td>
                  </tr>
                ))}
                {!p.revenue.length && <tr><td colSpan={5} className="muted">No {w(data, "consignment", true).toLowerCase()} yet.</td></tr>}
                {p.recovered?.items.map((x) => (
                  <tr key={x.ref} className="profit-item">
                    <td colSpan={3}>Recovered from the driver · {x.label}</td>
                    <td className="num">{m(x.amountMinor)}</td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section>
          <h4>Costs</h4>
          <div className="table-frame">
            <table className="table">
              <thead><tr><th>Cost</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {p.costs.map((c) => (
                  <ProfitCostRows key={c.group} c={c} m={m} open={openGroup === c.group} onToggle={() => setOpenGroup(openGroup === c.group ? null : c.group)} onRemove={mayAdd && c.group === "other" ? (ref) => void removeCost(ref) : undefined} />
                ))}
              </tbody>
            </table>
          </div>
          {mayAdd && <div><Button size="sm" onClick={() => setAdding(true)}>Add a cost</Button></div>}
          {p.pending?.length ? (
            <div className="profit-pending">
              <h5>Waiting for approval, not counted yet</h5>
              <ul className="plain">{p.pending.map((x) => <li key={x.ref}>{x.label} · {m(x.amountMinor)}</li>)}</ul>
            </div>
          ) : null}
        </section>
      </div>

      {p.budget && (p.budget.fuelL || p.budget.cashMinor) ? (
        <p className="profit-budget">
          Budget for this {w(data, "trip").toLowerCase()}: fuel {num(p.budget.fuelL ?? 0)}&nbsp;L, cash {m(p.budget.cashMinor ?? 0)}.
          Used: {num(p.budget.usedFuelL ?? 0)}&nbsp;L, {m(p.budget.usedCashMinor ?? 0)}.
        </p>
      ) : null}

      {adding && <AddCost trip={trip} currency={p.currency} onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); await profit.refetch(); }} />}
      {cn?.revenue && (
        <Modal open width={880} title={`${cn.number} · ${cn.consigneeName}`} onClose={() => setOpenCn(null)}>
          <RevenuePanel c={cn} onChanged={() => void profit.refetch()} />
        </Modal>
      )}
    </div>
  );
}

function ProfitCostRows({ c, m, open, onToggle, onRemove }: { c: Profit["costs"][number]; m: (v: number) => string; open: boolean; onToggle: () => void; onRemove?: (ref: string) => void }) {
  return (
    <>
      <tr className={c.items.length ? "clickable" : ""} onClick={c.items.length ? onToggle : undefined}>
        <td>
          {c.label}
          {c.litres?.used !== undefined && <span className="muted"> · {num(c.litres.used)}&nbsp;L used ({num(c.litres.opening ?? 0)} at the start + {num(c.litres.issued ?? 0)} issued − {num(c.litres.closing ?? 0)} at the end)</span>}
          {c.items.length > 0 && <span className="muted"> · {open ? "hide" : `${c.items.length} ${c.items.length === 1 ? "record" : "records"}`}</span>}
        </td>
        <td className="num">{m(c.amountMinor)}</td>
      </tr>
      {open && c.items.map((x) => (
        <tr key={x.ref} className="profit-item">
          <td>{x.label}{onRemove && x.ref.startsWith("costs:") && <> · <button className="link-btn" onClick={(e) => { e.stopPropagation(); onRemove(x.ref); }}>Remove</button></>}</td>
          <td className="num">{m(x.amountMinor)}</td>
        </tr>
      ))}
    </>
  );
}

function AddCost({ trip, currency, onClose, onSaved }: { trip: Trip; currency: Profit["currency"]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const types = useQuery({ queryKey: ["charge-types-cost"], queryFn: async () => (await api<Rec[]>("/charge-types", { query: { status: "active", limit: 100 } })).filter((t) => t.direction === "cost") });
  const [label, setLabel] = useState("");
  const [chargeTypeId, setType] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/trips/${trip.id}/costs`, { method: "POST", body: { label: label.trim(), ...(chargeTypeId ? { chargeTypeId } : {}), amount: { amountMinor: Math.round(Number(amount) * 10 ** currency.minorUnits), currencyId: currency.id }, ...(note.trim() ? { note: note.trim() } : {}) } });
      toast("Cost added.");
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title="Add a cost" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" busy={busy} disabled={!label.trim() || !(Number(amount) > 0)} onClick={() => void save()}>Add the cost</Button></>}>
      <p className="muted">A cost that isn't an expense or a fuel issue, such as a toll account or a hired escort. It lowers this trip's profit only.</p>
      <div className="grid-2">
        <Field label="What it is"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Toll account" /></Field>
        <Field label="Charge type" hint="Optional: a cost charge type, for reports.">
          <select value={chargeTypeId} onChange={(e) => setType(e.target.value)}>
            <option value="">None</option>
            {(types.data ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
          </select>
        </Field>
        <Field label="Amount"><UnitInput label="Amount" unit={currency.code} value={amount} onChange={setAmount} /></Field>
        <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** Revenue, costs and profit in one line at the top of the trip (#135 Part 4), opening the Money tab. */
export function ProfitLine({ trip, onOpen }: { trip: Trip; onOpen: () => void }) {
  const { data } = useApp();
  const profit = useQuery({ queryKey: ["trip-profit", trip.id], queryFn: () => api<Profit>(`/trips/${trip.id}/profit`), staleTime: 30_000 });
  if (!profit.data) return null;
  const p = profit.data;
  const m = (minor: number) => `${num(minor / 10 ** p.currency.minorUnits, 0, p.currency.minorUnits)}\u00a0${p.currency.code}`;
  const st = STATUS[p.status] ?? STATUS.estimate;
  return (
    <button type="button" className="profit-line" onClick={onOpen} aria-label={`${w(data, "trip")} money: open the Money tab`}>
      <span>Revenue <b>{m(p.revenueMinor)}</b></span>
      <span>Costs <b>{m(p.costMinor)}</b></span>
      <span>Profit <b className={p.profitMinor < 0 ? "profit-loss" : ""}>{m(p.profitMinor)}</b></span>
      <Status tone={st.tone}>{st.label}</Status>
    </button>
  );
}
