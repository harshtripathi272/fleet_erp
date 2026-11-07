import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button } from "../ui/kit";

/**
 * The path to a company's first trip (#116): what's still missing, said where people are, with a way to add it
 * there. The Masters screen loads only when someone adds a record from a form.
 */

const QuickAdd = lazy(() => import("../masters/MastersScreen").then((m) => ({ default: m.QuickAdd })));

interface Check { key: string; label: string; why: string; master?: string; required: boolean; done: boolean }
interface Readiness { ready: boolean; missing: string[]; checks: Check[] }

/** The same check as Masters → Ready for a first trip; only for people who may read the company. */
export function useFirstTrip() {
  const { me } = useApp();
  return useQuery({
    queryKey: ["readiness"], enabled: can(me, "company", "read"), staleTime: 30_000, retry: false,
    queryFn: () => api<Readiness>("/meta/readiness"),
  });
}

/** What a first trip still needs, each one a link to where it's added. Nothing once the company is ready. */
export function FirstTripSteps({ intro }: { intro?: string }) {
  const { nav } = useApp();
  const readiness = useFirstTrip();
  if (!readiness.data || readiness.data.ready) return null;
  const missing = readiness.data.checks.filter((c) => c.required && !c.done);
  return (
    <div className="first-trip">
      <p><strong>Before the first trip</strong> {intro ?? "add what's still missing. Each one opens where it's added."}</p>
      <div className="first-trip-links">
        {missing.map((c) => (
          <Button key={c.key} size="sm" title={c.why} onClick={() => nav({ view: "masters", masterEntity: c.master ?? "company" })}>
            {c.label} <ArrowRight size={14} />
          </Button>
        ))}
        <button className="link-btn" onClick={() => nav({ view: "masters", masterEntity: "setup" })}>See every step</button>
      </div>
    </div>
  );
}

/**
 * "Add a new one" beside a picker (#116): the master's own form opens on top, and the new record is picked
 * here, so nobody leaves a half-filled form. Offered only to people who may create that master.
 */
export function AddNew({ master, what, initial, onCreated }: { master: string; what: string; initial?: Rec; onCreated?: (id: string) => void }) {
  const { me, refreshReference } = useApp();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!can(me, master, "create")) return null;
  return (
    <>
      <button type="button" className="link-btn add-new" onClick={() => setOpen(true)}><Plus size={13} /> Add a new {what}</button>
      {open && (
        <Suspense fallback={null}>
          <QuickAdd master={master} initial={initial} onClose={() => setOpen(false)} onCreated={(id) => { refreshReference(); void queries.invalidateQueries({ queryKey: ["readiness"] }); onCreated?.(id); }} />
        </Suspense>
      )}
    </>
  );
}
