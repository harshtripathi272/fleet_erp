import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { authorizedFetch, request } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { Button, Empty } from "../ui/kit";
import { AUDIT_VIEW, fieldName, label, short, shown } from "./history";

/**
 * Masters → Organisation → Audit log (#36): every change in the company, newest first, with who made it.
 * The filters live in the address bar, so a filtered view can be shared as a link.
 */

const ACTIONS = ["create", "update", "archive", "restore", "delete", "custom"] as const;
const ACTION_LABEL: Record<string, string> = { create: "Created", update: "Changed", archive: "Archived", restore: "Restored", delete: "Deleted", custom: "Operations" };
const PARAMS = { entity: "audit-master", actorId: "audit-person", action: "audit-action", from: "audit-from", to: "audit-to", page: "audit-page" } as const;
type Filters = { [K in keyof typeof PARAMS]?: string };
const PAGE = 50;

const readFilters = (): Filters => {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(Object.entries(PARAMS).map(([key, param]) => [key, params.get(param) ?? undefined]).filter(([, v]) => v));
};
function writeFilters(filters: Filters) {
  const params = new URLSearchParams(location.search);
  params.set("view", AUDIT_VIEW);
  for (const [key, param] of Object.entries(PARAMS)) {
    const value = filters[key as keyof Filters];
    if (value) params.set(param, value);
    else params.delete(param);
  }
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

const query = (f: Filters) => ({ entity: f.entity, actorId: f.actorId, action: f.action, from: f.from, to: f.to });
const when = (at: string) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function AuditLog({ onOpen }: { onOpen: (entity: string, id: string) => void }) {
  const { toast } = useApp();
  const [filters, setFiltersState] = useState<Filters>(readFilters);
  const [downloading, setDownloading] = useState(false);
  const page = Number(filters.page ?? 1) || 1;
  const setFilters = (patch: Filters) => {
    const next = { ...filters, ...patch, page: patch.page ?? undefined };
    setFiltersState(next);
    writeFilters(next);
  };
  // The masters' field labels, already loaded by the masters screen this log sits in.
  const defs = useQueryClient().getQueryData<Rec[]>(["meta-masters"]) ?? [];
  const people = useQuery({ queryKey: ["audit-people"], queryFn: async () => (await request<Rec[]>("/audit-logs/people")).data });
  const entities = useQuery({ queryKey: ["audit-entities"], queryFn: async () => (await request<Rec[]>("/audit-logs/entities")).data });
  const rows = useQuery({
    queryKey: ["audit-logs", filters],
    queryFn: () => request<Rec[]>("/audit-logs", { query: { ...query(filters), page, limit: PAGE } }),
  });
  const download = async () => {
    setDownloading(true);
    try {
      const params = new URLSearchParams(Object.entries(query(filters)).filter((e): e is [string, string] => Boolean(e[1])));
      const res = await authorizedFetch(`/audit-logs/export${params.size ? `?${params}` : ""}`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `audit-log-${new Date().toISOString().slice(0, 10)}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "The download failed.", "error");
    } finally {
      setDownloading(false);
    }
  };
  const total = rows.data?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="desk">
      <header className="masters-head">
        <h2>Audit log</h2>
        <Button onClick={() => void download()} busy={downloading}><Download size={16} /> Download as CSV</Button>
      </header>
      <div className="desk-tools audit-filters">
        <select className="input" aria-label="Master" value={filters.entity ?? ""} onChange={(e) => setFilters({ entity: e.target.value || undefined })}>
          <option value="">Every master</option>
          {(entities.data ?? []).map((e) => <option key={String(e.key)} value={String(e.key)}>{String(e.label)}</option>)}
        </select>
        <select className="input" aria-label="Person" value={filters.actorId ?? ""} onChange={(e) => setFilters({ actorId: e.target.value || undefined })}>
          <option value="">Everyone</option>
          {(people.data ?? []).map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>)}
        </select>
        <select className="input" aria-label="Action" value={filters.action ?? ""} onChange={(e) => setFilters({ action: e.target.value || undefined })}>
          <option value="">Every action</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
        </select>
        <span className="audit-date">
          <label>From <input className="input" type="date" value={filters.from ?? ""} max={filters.to} onChange={(e) => setFilters({ from: e.target.value || undefined })} /></label>
          <label>to <input className="input" type="date" value={filters.to ?? ""} min={filters.from} onChange={(e) => setFilters({ to: e.target.value || undefined })} /></label>
        </span>
      </div>
      {rows.isLoading && <p className="muted">Loading the log…</p>}
      {rows.error && <Empty title="Could not load the audit log">{(rows.error as Error).message}</Empty>}
      {rows.data && !rows.data.data.length && <Empty title="No changes match these filters" />}
      {rows.data && rows.data.data.length > 0 && (
        <ol className="audit-list">
          {rows.data.data.map((e) => {
            const changes = ((e.changes as Rec[]) ?? []).filter(shown);
            const name = e.title ? String(e.title) : undefined;
            return (
              <li key={String(e.id)} className="audit-entry">
                <div className="audit-when">
                  <time dateTime={String(e.at)}>{when(String(e.at))}</time>
                  <span>{e.actorName ? String(e.actorName) : "System"}</span>
                </div>
                <div className="audit-what">
                  <div>
                    {/* An operation (a trip dispatched, fuel issued) is named by its summary below, so it needs no verb of its own. */}
                    {e.action !== "custom" && <><span className={`audit-action audit-${e.action}`}>{ACTION_LABEL[String(e.action)] ?? label(String(e.action))}</span>{" "}</>}
                    <span className="muted">{String(e.entityLabel)}</span>{" "}
                    {name && (e.openable
                      ? <button className="link-btn" onClick={() => onOpen(String(e.entity), String(e.entityId))}>{name}</button>
                      : <strong>{name}</strong>)}
                  </div>
                  {e.summary && <p className="audit-summary">{String(e.summary)}</p>}
                  {changes.length > 0 && (() => {
                    const list = (
                      <ul className="audit-changes">
                        {changes.map((c) => <li key={String(c.path)}><span>{fieldName(String(c.path), defs.find((d) => d.key === e.entity))}:</span> {e.action === "create" ? short(c.to) : e.action === "delete" ? short(c.from) : <>{short(c.from)} → {short(c.to)}</>}</li>)}
                      </ul>
                    );
                    // A new or deleted record lists every field: folded away, so the changes stand out.
                    return e.action === "create" || e.action === "delete"
                      ? <details className="audit-fields"><summary>Show the {changes.length} field{changes.length === 1 ? "" : "s"}</summary>{list}</details>
                      : list;
                  })()}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {total > PAGE && (
        <div className="pager">
          <span className="muted">{total.toLocaleString("en-GB")} changes · page {page} of {pages}</span>
          <Button size="sm" disabled={page <= 1} onClick={() => setFilters({ page: String(page - 1) })}>Newer</Button>
          <Button size="sm" disabled={page >= pages} onClick={() => setFilters({ page: String(page + 1) })}>Older</Button>
        </div>
      )}
    </div>
  );
}
