import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { request } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { byId } from "../domain/calc";
import { w, wl } from "../domain/words";
import { Button, Empty, Segmented, Status } from "../ui/kit";
import { calendarDate } from "../ui/format";
import { cnFrom, CN_STATUS_LABEL, cnStatusTone, cnTotals, type Cn } from "./model";
import { cnRoute, moneyText, podState, productText, qtyText } from "./TripConsignments";
import { ConsignmentDrawer } from "./ConsignmentDrawer";
import { Report } from "./Report";

/**
 * Every consignment, on and off the trips (#135, design 3.11.6): underline tabs for the lists the desks work from,
 * one framed table paged on the server, and the Report: the statement transporters send their customers.
 */

type Tab = "all" | "to_load" | "on_road" | "to_deliver" | "waiting_pod" | "unpriced" | "report";

export default function ConsignmentsScreen() {
  const { data } = useApp();
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Cn | null>(null);
  const list = useQuery({
    queryKey: ["consignments-list", tab, q, customerId, productId, from, to, page],
    enabled: tab !== "report",
    queryFn: () => request<Rec[]>("/consignments", { query: { tab: tab === "all" ? undefined : tab, q: q.trim() || undefined, customerId: customerId || undefined, productId: productId || undefined, from: from || undefined, to: to || undefined, page, limit: 50 } }),
  });
  const partyName = (id: unknown) => (id ? byId(data.customers, String(id))?.name : undefined);
  const partyPhone = (id: unknown) => (id ? byId(data.customers, String(id))?.phone : undefined);
  const rows = (list.data?.data ?? []).map((c) => cnFrom(c, partyName, partyPhone));
  const meta = list.data?.meta as (Rec & { page?: number; total?: number; totalPages?: number; pages?: number }) | undefined;
  const pages = Number(meta?.totalPages ?? meta?.pages ?? 1);
  const seesMoney = rows.some((c) => c.revenue);
  const tabs: { value: Tab; label: string }[] = [
    { value: "all", label: "All" }, { value: "to_load", label: "To load" }, { value: "on_road", label: "On the road" }, { value: "to_deliver", label: "To deliver" },
    { value: "waiting_pod", label: "Waiting for proof of delivery" }, { value: "unpriced", label: "Unpriced" }, { value: "report", label: "Report" },
  ];
  const reset = () => setPage(1);
  return (
    <div className="desk consignments-screen">
      <Segmented label={w(data, "consignment", true)} value={tab} options={tabs} onChange={(v) => { setTab(v); reset(); }} />
      {tab === "report" ? <Report /> : (
        <>
          <div className="desk-tools">
            <label className="search">
              <Search size={15} />
              <input value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder={`Number, reference, party or ${wl(data, "trip")}`} aria-label="Search" />
            </label>
            <select className="input" value={customerId} onChange={(e) => { setCustomerId(e.target.value); reset(); }} aria-label={w(data, "customer")}>
              <option value="">Every {wl(data, "customer")}</option>
              {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input" value={productId} onChange={(e) => { setProductId(e.target.value); reset(); }} aria-label="Goods">
              <option value="">All goods</option>
              {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="input" type="date" aria-label="Booked from" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />
            <input className="input" type="date" aria-label="Booked until" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
          </div>
          {list.error ? <Empty title="Could not load">{(list.error as Error).message}</Empty> : (
            <div className="table-frame">
              <table className="table cn-table">
                <thead>
                  <tr>
                    <th>Number</th><th>Booked</th><th>Status</th><th>{w(data, "customer")}</th><th>Consignor</th><th>Consignee</th><th>Goods</th><th className="num">Quantity</th>
                    <th>From → To</th><th>{w(data, "trip")}</th><th>{w(data, "truck")}</th><th>Loaded on</th><th>Delivered on</th><th>Proof of delivery</th>
                    {seesMoney && <th className="num">Revenue</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const trip = byId(data.trips, c.tripId ?? undefined);
                    const t = cnTotals(c);
                    const r = cnRoute(data, c);
                    const pod = podState(c);
                    return (
                      <tr key={c.id} className="clickable" onClick={() => c.tripId && setOpen(c)}>
                        <td className="mono">{c.number}</td>
                        <td>{calendarDate(c.bookedAt)}</td>
                        <td><Status tone={cnStatusTone(c.status)}>{CN_STATUS_LABEL[c.status] ?? c.status}</Status></td>
                        <td className="cn-party">{byId(data.customers, c.customerId)?.name ?? "—"}</td>
                        <td className="cn-party">{c.consignorName}</td>
                        <td className="cn-party">{c.consigneeName}</td>
                        <td>{productText(data, c)}</td>
                        <td className="num">{qtyText(t.delivered ?? t.loaded ?? (t.planned || undefined), t.unit)}</td>
                        <td>{r.from} → {r.to}{r.more ? <span className="muted"> +{r.more}</span> : null}</td>
                        <td className="mono">{trip?.no ?? "—"}</td>
                        <td>{trip ? byId(data.trucks, trip.truckId)?.plate ?? "—" : "—"}</td>
                        <td>{c.loadedAt ? calendarDate(c.loadedAt) : "—"}</td>
                        <td>{c.deliveredAt ? calendarDate(c.deliveredAt) : "—"}</td>
                        <td><Status tone={pod.tone}>{pod.label}</Status></td>
                        {seesMoney && <td className="num">{!c.revenue ? "—" : c.revenue.status === "unpriced" ? <span className="cn-unpriced">No price</span> : moneyText(data, c.revenue.totalMinor, c.revenue.currencyId)}</td>}
                      </tr>
                    );
                  })}
                  {list.data && !rows.length && <tr><td colSpan={15} className="muted">Nothing here.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="pager">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="muted">Page {page} of {pages} · {meta?.total ?? ""} {wl(data, "consignment", true)}</span>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          )}
        </>
      )}
      {open?.tripId && <ConsignmentDrawer id={open.id} tripId={open.tripId} onClose={() => setOpen(null)} />}
    </div>
  );
}
