import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import { api, ApiError } from "../api/client";
import { downloadPdf } from "../api/files";
import { useApp } from "../store";
import { w, wl } from "../domain/words";
import { Button, Empty, Modal, Segmented, Switch } from "../ui/kit";
import { calendarDate, num } from "../ui/format";

/**
 * The consignment report (#135, design 3.11.6): the statement a transporter sends a customer, as a real table. Its
 * columns are a choice (the 8 Nov columns by default), remembered for the person on the server, with filters, a
 * pinned totals row and downloads of exactly what is on screen. Money columns come only to those who may see them.
 */

interface Column { key: string; label: string; money?: boolean; unit?: string }
interface ReportData {
  columns: Column[];
  rows: Record<string, unknown>[];
  totals: { count: number; quantities?: { unit: string; qty: number }[]; km?: number; money?: { currency: string; amountMinor: number; minorUnits?: number }[] };
  available: Column[];
}

type DateField = "booked" | "loaded" | "delivered" | "invoiced";

export function Report() {
  const { data, toast } = useApp();
  const [dateField, setDateField] = useState<DateField>("loaded");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [withPod, setWithPod] = useState(false);
  const [columns, setColumns] = useState<string[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const query = {
    dateField, from: from || undefined, to: to || undefined, customerId: customerId || undefined, productId: productId || undefined, vehicleId: vehicleId || undefined,
    withPod: withPod ? "true" : undefined, columns: columns?.join(",") || undefined, limit: 500,
  };
  const report = useQuery({ queryKey: ["consignment-report", query], queryFn: () => api<ReportData>("/consignments/report", { query }) });
  // The person's remembered columns are what the server answers with when none are asked for.
  useEffect(() => { if (report.data && !columns) setColumns(report.data.columns.map((c) => c.key)); }, [report.data, columns]);

  const saveColumns = async (next: string[]) => {
    setColumns(next);
    try { await api("/consignments/report/columns", { method: "PUT", body: { columns: next } }); } catch (err) { toast(err instanceof ApiError ? err.message : "The columns couldn't be remembered.", "error"); }
  };
  const download = (ext: "xlsx" | "csv") => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    void downloadPdf(`/consignments/report.${ext}?${qs}`, `consignments.${ext}`).catch(() => toast("The download didn't work.", "error"));
  };
  const cell = (c: Column, v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "number") return c.money ? num(v, 2, 2) : num(v, 0, 3);
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return calendarDate(v);
    return String(v);
  };
  const r = report.data;
  return (
    <div className="cn-report">
      <div className="desk-tools">
        <Segmented choice label="Dates by" value={dateField} onChange={setDateField}
          options={[{ value: "booked", label: "Booked" }, { value: "loaded", label: "Loaded" }, { value: "delivered", label: "Delivered" }, { value: "invoiced", label: "Invoiced" }]} />
        <input className="input" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" aria-label="Until" value={to} onChange={(e) => setTo(e.target.value)} />
        <select className="input" aria-label={w(data, "customer")} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">Every {wl(data, "customer")}</option>
          {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input" aria-label="Goods" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">All goods</option>
          {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input" aria-label={w(data, "truck")} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">Every {wl(data, "truck")}</option>
          {data.trucks.map((t) => <option key={t.id} value={t.id}>{t.plate}</option>)}
        </select>
        <label className="cn-report-pod"><Switch label="Only with proof of delivery" checked={withPod} onChange={setWithPod} /> Only with proof of delivery</label>
      </div>
      <div className="cn-report-actions">
        <Button onClick={() => setChoosing(true)} disabled={!r}>Columns</Button>
        <Button onClick={() => download("xlsx")} disabled={!r}><Download size={15} /> Download XLSX</Button>
        <Button onClick={() => download("csv")} disabled={!r}><Download size={15} /> Download CSV</Button>
      </div>
      {report.error ? <Empty title="The report couldn't be made">{(report.error as Error).message}</Empty> : !r ? <p className="muted">Making the report…</p> : (
        <div className="table-frame">
          <table className="table cn-table">
            <thead><tr>{r.columns.map((c) => <th key={c.key} className={c.money || c.unit ? "num" : ""}>{c.label}</th>)}</tr></thead>
            <tbody>
              {r.rows.map((row, i) => <tr key={i}>{r.columns.map((c) => <td key={c.key} className={c.money || c.unit ? "num" : ""}>{cell(c, row[c.key])}</td>)}</tr>)}
              {!r.rows.length && <tr><td colSpan={r.columns.length} className="muted">Nothing in this period.</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={r.columns.length}>
                  <b>{num(r.totals.count)} {wl(data, "consignment", r.totals.count !== 1)}</b>
                  {r.totals.quantities?.map((q) => <span key={q.unit}> · {num(q.qty, 0, 3)}&nbsp;{q.unit}</span>)}
                  {r.totals.km ? <span> · {num(r.totals.km)}&nbsp;km</span> : null}
                  {r.totals.money?.map((m) => <span key={m.currency}> · {num(m.amountMinor / 10 ** (m.minorUnits ?? 2), 2, 2)}&nbsp;{m.currency}</span>)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {choosing && r && <ColumnChooser shown={columns ?? r.columns.map((c) => c.key)} available={r.available} onClose={() => setChoosing(false)} onSave={(next) => { setChoosing(false); void saveColumns(next); }} />}
    </div>
  );
}

/** Hide, show and re-order the report's columns; the choice is remembered for this person. */
function ColumnChooser({ shown, available, onClose, onSave }: { shown: string[]; available: Column[]; onClose: () => void; onSave: (next: string[]) => void }) {
  const [order, setOrder] = useState<string[]>(() => [...shown, ...available.map((c) => c.key).filter((k) => !shown.includes(k))]);
  const [on, setOn] = useState<Set<string>>(() => new Set(shown));
  const label = (k: string) => available.find((c) => c.key === k)?.label ?? k;
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };
  return (
    <Modal open title="Columns" onClose={onClose} width={520}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!on.size} onClick={() => onSave(order.filter((k) => on.has(k)))}>Use these columns</Button></>}>
      <p className="muted">Switched-on columns show in this order on the screen and in the downloads. Your choice is kept for next time.</p>
      <ol className="column-list">
        {order.map((k, i) => (
          <li key={k}>
            <Switch label={label(k)} checked={on.has(k)} onChange={(v) => { const next = new Set(on); if (v) next.add(k); else next.delete(k); setOn(next); }} />
            <span>{label(k)}</span>
            <span className="column-move">
              <Button size="sm" tone="quiet" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${label(k)} up`}><ArrowUp size={14} /> Up</Button>
              <Button size="sm" tone="quiet" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${label(k)} down`}><ArrowDown size={14} /> Down</Button>
            </span>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
