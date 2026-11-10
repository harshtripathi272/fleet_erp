import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { placeName } from "../domain/helpers";
import { Button, Field, Modal, SwitchField, UnitInput } from "../ui/kit";
import { num, phonePlaceholder } from "../ui/format";
import { AddNew } from "../desks/firstTrip";
import type { Cn } from "./model";

/**
 * Splitting a delivery (#135, design 3.11.5): the 40,000 L to four depots case. The drops already done stay as they
 * are; the rest is placed on drops here, each with its place, who receives it and how much, until nothing is left
 * to place, or the rest is left to be confirmed. Saving replaces the planned drops in one request
 * (`PUT /consignments/:id/legs`); the server adds the stops after the truck's position and tells the driver.
 */

type Row = { key: string; id?: string; placeId: string; name: string; phone: string; qty: string };
let keys = 0;
const row = (patch: Partial<Row> = {}): Row => ({ key: `d${++keys}`, placeId: "", name: "", phone: "", qty: "", ...patch });

export function SplitDelivery({ c, onClose, onSaved }: { c: Cn; onClose: () => void; onSaved: () => void }) {
  const { data } = useApp();
  const line = c.lines[0];
  // Fuel is placed in litres at 20 °C, as the server counts what is on board; other goods in their own unit.
  const corrected = c.legs.some((l) => l.kind === "pickup" && l.actual?.some((m) => m.lineId === line?.id && (m.certStd20L ?? m.std20L) !== undefined));
  const unit = corrected ? "L at 20 °C" : line?.unit ?? "";
  const measured = (m: { qty: number; std20L?: number; certStd20L?: number }) => (corrected ? m.certStd20L ?? m.std20L ?? m.qty : m.qty);
  const doneDrops = c.legs.filter((l) => l.kind === "drop" && l.status === "done");
  const loaded = c.legs.filter((l) => l.kind === "pickup" && l.status === "done").flatMap((l) => l.actual ?? []).filter((m) => m.lineId === line?.id).reduce((s, m) => s + measured(m), 0);
  const dropped = doneDrops.flatMap((l) => l.actual ?? []).filter((m) => m.lineId === line?.id).reduce((s, m) => s + measured(m), 0);
  const toPlace = Math.max(0, (loaded || line?.plannedQty || 0) - dropped);
  const [rows, setRows] = useState<Row[]>(() => {
    const open = c.legs.filter((l) => l.kind === "drop" && l.status === "planned");
    return open.length
      ? open.map((l) => row({ id: l.id, placeId: l.placeId ?? "", name: l.contact?.name ?? "", phone: l.contact?.phone ?? "", qty: String(l.planned?.find((p) => p.lineId === line?.id)?.qty ?? "") }))
      : [row()];
  });
  const [leaveRest, setLeaveRest] = useState(false);
  const [parts, setParts] = useState("4");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const placed = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const left = Math.round((toPlace - placed) * 1000) / 1000;
  const set = (key: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const places = useMemo(() => [...data.places].sort((a, b) => a.name.localeCompare(b.name)), [data.places]);

  const splitEqually = () => {
    const n = Math.max(1, Math.min(20, Math.round(Number(parts) || 1)));
    const each = Math.floor(toPlace / n);
    const next = Array.from({ length: n }, (_, i) => rows[i] ?? row());
    setRows(next.map((r, i) => ({ ...r, qty: String(i === n - 1 ? toPlace - each * (n - 1) : each) })));
  };
  const restOnLast = () => {
    if (!rows.length) return;
    const last = rows[rows.length - 1]!;
    set(last.key, { qty: String((Number(last.qty) || 0) + left) });
  };

  const save = async () => {
    setBusy(true);
    setProblem("");
    try {
      const legs: Rec[] = [
        ...c.legs.filter((l) => l.kind === "pickup").map((l) => ({ id: l.id, kind: "pickup", ...(l.placeId ? { placeId: l.placeId } : {}), ...(l.stopId ? { stopId: l.stopId } : {}) })),
        ...doneDrops.map((l) => ({ id: l.id, kind: "drop", ...(l.placeId ? { placeId: l.placeId } : {}) })),
        ...rows.filter((r) => r.placeId || Number(r.qty) > 0).map((r) => ({
          ...(r.id ? { id: r.id } : {}), kind: "drop", ...(r.placeId ? { placeId: r.placeId } : {}),
          ...(line && Number(r.qty) > 0 ? { planned: [{ lineId: line.id, qty: Number(r.qty) }] } : {}),
          ...(r.name.trim() ? { contact: { name: r.name.trim(), ...(r.phone.trim() ? { phone: r.phone.trim() } : {}) } } : {}),
        })),
      ];
      await api(`/consignments/${c.id}/legs`, { method: "PUT", body: { version: c.version, legs, ...(leaveRest ? { leaveRest: true } : {}) } });
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const ready = rows.some((r) => r.placeId || Number(r.qty) > 0) && (Math.abs(left) < 0.001 || (leaveRest && left > 0)) && left >= -0.001;
  return (
    <Modal open width={880} title={`Split the delivery of ${c.number}`} onClose={onClose}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" busy={busy} disabled={!ready} onClick={() => void save()}>Save the split</Button></>}>
      <p>{num(toPlace, 0, 3)}&nbsp;{unit} {loaded ? "on board" : "planned"} for {c.consigneeName}. Where is it going?</p>
      {c.lines.length > 1 && <p className="muted">This places the first goods line ({line?.description || data.products.find((p) => p.id === line?.productId)?.name || "line 1"}). The other lines keep their drops.</p>}
      {problem && <p className="form-problem" role="alert">{problem}</p>}
      <div className="table-frame">
        <table className="table split-table">
          <thead><tr><th>Drop</th><th>Place</th><th>Received by</th><th>Phone</th><th className="num">Quantity</th><th /></tr></thead>
          <tbody>
            {doneDrops.map((l, i) => (
              <tr key={l.id} className="muted">
                <td>{i + 1}</td><td>{l.placeId ? placeName(data, l.placeId) : "—"}</td><td>{l.pod?.receivedBy ?? l.contact?.name ?? ""}</td><td>{l.contact?.phone ?? ""}</td>
                <td className="num">{num(l.actual?.reduce((s, m) => s + measured(m), 0) ?? 0, 0, 3)}&nbsp;{unit}</td><td>Done</td>
              </tr>
            ))}
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td>{doneDrops.length + i + 1}</td>
                <td>
                  <select className="input" aria-label={`Drop ${doneDrops.length + i + 1} place`} value={r.placeId} onChange={(e) => set(r.key, { placeId: e.target.value })}>
                    <option value="">To be confirmed</option>
                    {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </td>
                <td><input className="input" aria-label={`Drop ${doneDrops.length + i + 1} received by`} value={r.name} placeholder={c.consigneeName} onChange={(e) => set(r.key, { name: e.target.value })} /></td>
                <td><input className="input" aria-label={`Drop ${doneDrops.length + i + 1} phone`} type="tel" value={r.phone} placeholder={phonePlaceholder()} onChange={(e) => set(r.key, { phone: e.target.value })} /></td>
                <td><UnitInput label={`Drop ${doneDrops.length + i + 1} quantity`} unit={unit} value={r.qty} onChange={(v) => set(r.key, { qty: v })} /></td>
                <td>{rows.length > 1 && <Button size="sm" tone="quiet" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>Remove</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="split-tools">
        <Button size="sm" onClick={() => setRows([...rows, row()])}><Plus size={14} /> Add a drop</Button>
        <span className="split-equal">
          <Button size="sm" onClick={splitEqually}>Split equally into</Button>
          <UnitInput label="How many drops" unit="drops" step={1} value={parts} onChange={setParts} />
        </span>
        <Button size="sm" disabled={!rows.length || left <= 0} onClick={restOnLast}>Put the rest on the last drop</Button>
        <AddNew master="places" what="place" />
      </div>
      <p className={`framed-line ${left < -0.001 ? "split-over" : ""}`}>
        Placed {num(placed, 0, 3)} of {num(toPlace, 0, 3)}&nbsp;{unit} · {left >= 0 ? `${num(left, 0, 3)} left to place` : `${num(-left, 0, 3)} more than there is`}.
      </p>
      {left > 0.001 && <SwitchField label="Leave the rest to be confirmed" hint="It stays on a drop to be confirmed, to be placed later." checked={leaveRest} onChange={setLeaveRest} />}
      <p className="muted">Saving adds a stop for each new place after where the truck is now, takes away stops nothing needs any more, and sends the driver the new list of drops.</p>
    </Modal>
  );
}
