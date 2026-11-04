import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAreas } from "../api/areas";
import { api } from "../api/client";
import { can } from "../api/session";
import { byId } from "../domain/calc";
import { useApp } from "../store";
import { cash, dayYear, km, num } from "../ui/format";
import { Button, Empty, Segmented, Status } from "../ui/kit";
import { Card } from "./stages";

/**
 * The Maintenance desk (#63): what is due on each truck, the work orders still open, and what each truck
 * costs to keep on the road. Plans and orders are edited in their masters; this page says what needs doing.
 */

interface ServiceRow {
  vehicleId: string; plate: string; planId: string; plan: string; includes?: string; health: "ok" | "due" | "overdue";
  odometerKm?: number; nextKm?: number; nextDate?: string; nextHours?: number; lastServiceAt?: string; reason?: string;
  openWorkOrder?: { id: string; number: string };
}
interface WorkOrder { id: string; number: string; vehicleId: string; stage: "open" | "in_workshop" | "done"; stopsTruck: boolean; workshopPartyId?: string; description?: string; startedAt?: string; createdAt: string }
interface CostRow { vehicleId: string; plate: string; workOrders: number; workOrderMinor: number; tyreMinor: number; costMinor: number; km: number; perKmMinor: number | null }

const HEALTH = { overdue: ["Overdue", "bad"], due: ["Due soon", "wait"], ok: ["Not due", "ok"] } as const;
const STAGE = { open: ["Open", "wait"], in_workshop: ["In the workshop", "info"], done: ["Done", "ok"] } as const;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

export function Maintenance() {
  return (
    <div className="desk">
      <ServicesDue />
      <OpenWorkOrders />
      <CostPerTruck />
    </div>
  );
}

function ServicesDue() {
  const { me, nav, toast } = useApp();
  const client = useQueryClient();
  const [which, setWhich] = useState<"due" | "all">("due");
  const services = useQuery({ queryKey: ["maintenance-services"], queryFn: () => api<ServiceRow[]>("/maintenance/services") });
  const open = useMutation({
    mutationFn: (row: ServiceRow) => api<{ id: string }>("/work-orders", { method: "POST", body: { vehicleId: row.vehicleId, source: "service", servicePlanId: row.planId, description: row.includes } }),
    onSuccess: (order) => {
      void client.invalidateQueries({ queryKey: ["maintenance-services"] });
      void client.invalidateQueries({ queryKey: ["held-trucks"] });
      nav({ view: "masters", masterEntity: "work-orders", masterId: order.id });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "The work order could not be opened.", "error"),
  });
  const rows = (services.data ?? []).filter((r) => which === "all" || r.health !== "ok");
  const mayOpen = can(me, "work-orders", "create");
  return (
    <Card title="Services" aside={<Segmented choice label="Which services" value={which} options={[{ value: "due", label: "Due" }, { value: "all", label: "All" }]} onChange={setWhich} />}>
      {services.isLoading && <p className="muted">Loading…</p>}
      {services.error && <Empty title="Could not load the services">{(services.error as Error).message}</Empty>}
      {services.data && !services.data.length && (
        <Empty title="No service plans yet">
          <Button onClick={() => nav({ view: "masters", masterEntity: "service-plans" })}>Add a service plan</Button>
        </Empty>
      )}
      {services.data && services.data.length > 0 && !rows.length && <Empty title="Nothing is due" />}
      {rows.length > 0 && (
        <div className="table-frame">
          <table className="table">
            <thead><tr><th>Truck</th><th>Service</th><th>Status</th><th>Odometer</th><th>Next due</th><th>Last done</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.vehicleId}-${r.planId}`}>
                  <td className="mono">{r.plate}</td>
                  <td>{r.plan}</td>
                  <td><Status tone={HEALTH[r.health][1]}>{HEALTH[r.health][0]}</Status> <span className="muted">{r.reason}</span></td>
                  <td>{r.odometerKm === undefined ? "No reading" : km(r.odometerKm)}</td>
                  <td>{[r.nextKm !== undefined ? km(r.nextKm) : "", r.nextDate ? dayYear(r.nextDate) : "", r.nextHours !== undefined ? `${num(r.nextHours)} engine hours` : ""].filter(Boolean).join(" or ") || "—"}</td>
                  <td>{r.lastServiceAt ? dayYear(r.lastServiceAt) : "Not yet"}</td>
                  <td>
                    {r.openWorkOrder
                      ? <button className="link-btn" onClick={() => nav({ view: "masters", masterEntity: "work-orders", masterId: r.openWorkOrder!.id })}>{r.openWorkOrder.number}</button>
                      : mayOpen && <Button size="sm" busy={open.isPending && open.variables?.planId === r.planId && open.variables?.vehicleId === r.vehicleId} onClick={() => open.mutate(r)}>Open a work order</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function OpenWorkOrders() {
  const { data, nav } = useApp();
  const orders = useQuery({
    queryKey: ["work-orders-open"],
    queryFn: async () => {
      const [open, inWorkshop] = await Promise.all(["open", "in_workshop"].map((stage) => api<WorkOrder[]>("/work-orders", { query: { stage, limit: 100 } })));
      return [...inWorkshop!, ...open!];
    },
  });
  const workshops = useQuery({ queryKey: ["workshops"], queryFn: () => api<{ id: string; name: string }[]>("/parties", { query: { role: "workshop", limit: 100 } }) });
  const workshopName = (id?: string) => workshops.data?.find((w) => w.id === id)?.name ?? "—";
  return (
    <Card title="Work orders not done" aside={<Button size="sm" onClick={() => nav({ view: "masters", masterEntity: "work-orders" })}>All work orders</Button>}>
      {orders.isLoading && <p className="muted">Loading…</p>}
      {orders.error && <Empty title="Could not load the work orders">{(orders.error as Error).message}</Empty>}
      {orders.data && !orders.data.length && <Empty title="No work orders are open" />}
      {orders.data && orders.data.length > 0 && (
        <div className="table-frame">
          <table className="table">
            <thead><tr><th>Number</th><th>Truck</th><th>Stage</th><th>Stops the truck</th><th>Workshop</th><th>What</th><th>Opened</th></tr></thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id}>
                  <td><button className="link-btn mono" onClick={() => nav({ view: "masters", masterEntity: "work-orders", masterId: o.id })}>{o.number}</button></td>
                  <td className="mono">{byId(data.trucks, o.vehicleId)?.plate ?? "—"}</td>
                  <td><Status tone={STAGE[o.stage][1]}>{STAGE[o.stage][0]}</Status></td>
                  <td>{o.stopsTruck ? "Yes" : "No"}</td>
                  <td>{workshopName(o.workshopPartyId)}</td>
                  <td title={o.description}>{o.description ?? "—"}</td>
                  <td>{dayYear(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CostPerTruck() {
  const tyres = useAreas()("tyres");
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const report = useQuery({
    queryKey: ["maintenance-costs", from, to],
    enabled: Boolean(from && to && from <= to),
    queryFn: () => api<{ currency: string; minorUnits: number; rows: CostRow[] }>("/maintenance/costs", { query: { from, to } }),
  });
  const money = (minor: number) => cash(minor / 10 ** (report.data?.minorUnits ?? 2), report.data?.currency ?? "");
  return (
    <Card
      title="Cost per truck"
      aside={(
        <span className="audit-date-pair">
          <label className="audit-date">From <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="audit-date">to <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        </span>
      )}
    >
      {report.error && <Empty title="Could not work out the costs">{(report.error as Error).message}</Empty>}
      {report.data && !report.data.rows.length && <Empty title="No costs or trips in this period" />}
      {report.data && report.data.rows.length > 0 && (
        <div className="table-frame">
          <table className="table maint-costs">
            <thead>
              <tr>
                <th>Truck</th><th className="num">Work orders</th><th className="num">Their cost</th>
                {tyres && <th className="num">Tyres</th>}
                <th className="num">Total</th><th className="num">Driven</th><th className="num">Per km</th>
              </tr>
            </thead>
            <tbody>
              {report.data.rows.map((r) => (
                <tr key={r.vehicleId}>
                  <td className="mono">{r.plate}</td>
                  <td className="num">{r.workOrders}</td>
                  <td className="num">{money(r.workOrderMinor)}</td>
                  {tyres && <td className="num">{money(r.tyreMinor)}</td>}
                  <td className="num"><strong>{money(r.costMinor)}</strong></td>
                  <td className="num">{km(r.km)}</td>
                  <td className="num">{r.perKmMinor === null ? "—" : money(r.perKmMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
