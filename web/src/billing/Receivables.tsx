import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Send } from "lucide-react";
import { api, ApiError, authorizedFetch, request } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Empty, Field, Rows, Status } from "../ui/kit";
import { baseCurrencyCode } from "../ui/format";
import { Card } from "../desks/stages";

/**
 * Billing 2 (#62): ageing of what customers owe, customer statements, the month-end revaluation of
 * foreign-currency invoices, and the accounting export.
 */

const amount = (minor: unknown, of: Rec | "base") => {
  const units = of === "base" ? 2 : Number(of.minorUnits ?? 2);
  const code = of === "base" ? baseCurrencyCode() : String(of.currency ?? "");
  return `${(Number(minor ?? 0) / 10 ** units).toLocaleString("en-GB", { minimumFractionDigits: units, maximumFractionDigits: units })} ${code}`;
};
const day = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

async function download(path: string, name: string, toast: (t: string, tone?: "error") => void) {
  try {
    const res = await authorizedFetch(path);
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "The download failed.");
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error instanceof Error ? error.message : "The download failed.", "error");
  }
}

export function Ageing() {
  const [asOf, setAsOf] = useState(today());
  const [open, setOpen] = useState<string | null>(null);
  const aged = useQuery({ queryKey: ["billing", "ageing", asOf], queryFn: () => api<Rec>("/billing/ageing", { query: { asOf } }) });
  const buckets = ((aged.data?.buckets ?? []) as Rec[]);
  const rows = ((aged.data?.customers ?? []) as Rec[]);
  const totals = ((aged.data?.totals ?? []) as Rec[]);
  return (
    <Card title="Owed by customers" aside={<label className="audit-date">As of <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} /></label>}>
      {aged.isLoading && <p className="muted">Loading…</p>}
      {aged.error && <Empty title="Could not load the ageing">{(aged.error as Error).message}</Empty>}
      {aged.data && !rows.length && <Empty title="Nothing is owed" />}
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>Customer</th>{buckets.map((b) => <th key={String(b.key)} className="right">{String(b.label)}</th>)}<th className="right">Total</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.customerId}:${r.currencyId}`} className="clickable" onClick={() => setOpen(String(r.customerId))}>
                <td>{String(r.customer)}</td>
                {buckets.map((b) => <td key={String(b.key)} className="right num">{Number((r.buckets as Rec)[String(b.key)]) ? amount((r.buckets as Rec)[String(b.key)], r) : "—"}</td>)}
                <td className="right num"><strong>{amount(r.totalMinor, r)}</strong></td>
              </tr>
            ))}
            {totals.map((t) => (
              <tr key={String(t.currencyId)}>
                <td><strong>All customers, {String(t.currency)}</strong></td>
                {buckets.map((b) => <td key={String(b.key)} className="right num">{amount((t.buckets as Rec)[String(b.key)], t)}</td>)}
                <td className="right num"><strong>{amount(t.totalMinor, t)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <StatementDrawer customerId={open} to={asOf} onClose={() => setOpen(null)} />
    </Card>
  );
}

function StatementDrawer({ customerId, to, onClose }: { customerId: string | null; to: string; onClose: () => void }) {
  const { me, toast } = useApp();
  const [from, setFrom] = useState(monthStart());
  const [busy, setBusy] = useState(false);
  const query = { from, to };
  const s = useQuery({ queryKey: ["billing", "statement", customerId, from, to], enabled: Boolean(customerId), queryFn: () => api<Rec>(`/billing/statements/${customerId}`, { query }) });
  const params = new URLSearchParams(query).toString();
  const send = async () => {
    setBusy(true);
    try {
      const res = await request(`/billing/statements/${customerId}/send?${params}`, { method: "POST" });
      toast(res.message ?? "Statement sent");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "It wasn't sent.", "error");
    } finally {
      setBusy(false);
    }
  };
  const data = s.data;
  const entries = (data?.entries ?? []) as Rec[];
  return (
    <Drawer open={Boolean(customerId)} title={data ? `Statement for ${String(data.customer)}` : "Statement"} onClose={onClose} width={720} footer={data && (
      <>
        <Button onClick={() => void download(`/billing/statements/${customerId}/pdf?${params}`, `Statement ${String(data.customer)} ${to}.pdf`, toast)}><Download size={16} /> PDF</Button>
        {can(me, "invoices", "update") && <Button tone="primary" busy={busy} onClick={() => void send()}><Send size={16} /> Send to customer</Button>}
      </>
    )}>
      <Field label="From"><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || monthStart())} /></Field>
      {s.isLoading && <p className="muted">Loading…</p>}
      {s.error && <Empty title="Could not load the statement">{(s.error as Error).message}</Empty>}
      {data && (
        <>
          <Rows rows={[["Period", `${day(data.from)} to ${day(data.to)}`], ["Brought forward", amount(data.openingMinor, data)]]} />
          {!entries.length ? <Empty title="Nothing in this period" /> : (
            <table className="table">
              <thead><tr><th>Date</th><th>Document</th><th>Details</th><th className="right">Charged</th><th className="right">Paid or credited</th><th className="right">Balance</th></tr></thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={`${e.number}-${i}`}>
                    <td>{day(e.date)}</td>
                    <td className="mono">{String(e.number)}</td>
                    <td>{String(e.description)}</td>
                    <td className="right num">{Number(e.debitMinor) ? amount(e.debitMinor, data) : ""}</td>
                    <td className="right num">{Number(e.creditMinor) ? amount(e.creditMinor, data) : ""}</td>
                    <td className="right num">{amount(e.balanceMinor, data)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Rows rows={[
            ["Balance owed", <strong key="b">{amount(data.closingMinor, data)}</strong>],
            ...((data.ageing as Rec).buckets as Rec[]).map((b) => [String(b.label), amount(((data.ageing as Rec).amounts as Rec)[String(b.key)], data)] as [string, string]),
          ]} />
        </>
      )}
    </Drawer>
  );
}

export function Revaluations() {
  const { me, toast } = useApp();
  const client = useQueryClient();
  const runs = useQuery({ queryKey: ["billing", "revaluations"], queryFn: () => api<Rec>("/billing/revaluations") });
  const [periodEnd, setPeriodEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await request("/billing/revaluations", { method: "POST", body: periodEnd ? { periodEnd } : {} });
      toast(res.message ?? "Revalued");
      await client.invalidateQueries({ queryKey: ["billing"] });
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  const list = (runs.data?.runs ?? []) as Rec[];
  const due = runs.data?.due as Rec | undefined;
  return (
    <Card title="Revaluations" aside={can(me, "invoices", "create") && (
      <span className="range-inputs">
        <input className="input" type="date" aria-label="Revalue at" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        <Button size="sm" busy={busy} onClick={() => void run()}>Revalue now</Button>
      </span>
    )}>
      {due && <p className="muted">{due.due ? `Due for ${day(due.periodEnd)}.` : String(due.reason)}</p>}
      {!list.length ? <Empty title="No revaluations yet">Without a day, Revalue now uses the last month's or quarter's end.</Empty> : (
        <table className="table">
          <thead><tr><th>Period end</th><th className="right">Invoices</th><th className="right">Unrealised</th><th className="right">Reversed</th><th>Run</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={String(r.id)}>
                <td>{day(r.periodEnd)}</td>
                <td className="right num">{Number(r.invoices)}</td>
                <td className="right num">{amount(r.netMinor, "base")}</td>
                <td className="right num">{amount(r.reversedMinor, "base")}</td>
                <td>{r.trigger === "schedule" ? "Scheduled" : "By hand"}{((r.missing ?? []) as string[]).length > 0 && <> · <Status tone="wait">No rate for {((r.missing ?? []) as string[]).join(", ")}</Status></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function AccountingExport() {
  const { toast } = useApp();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await download(`/billing/export?from=${from}&to=${to}`, `postings-${from}-${to}.csv`, toast);
    setBusy(false);
  };
  return (
    <Card title="Accounting export">
      <p className="muted">Every posting between the two days, in the base currency, each with its account code from Masters → Account codes: invoices and credit notes, payments with their exchange gain or loss, revaluations, cash advanced to drivers and approved expenses.</p>
      <div className="desk-tools">
        <span className="audit-date">
          <label>From <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || monthStart())} /></label>
          <label>to <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value || today())} /></label>
        </span>
        <Button tone="primary" busy={busy} onClick={() => void run()}><Download size={16} /> Download CSV</Button>
      </div>
    </Card>
  );
}
