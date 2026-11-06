import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Upload } from "lucide-react";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { Button, Status } from "../ui/kit";
import { ImportDialog } from "./ImportDialog";

/**
 * "Set up the company" (issue #45): what a new company still needs before its first trip, in the order to do
 * it, with each step's records counted and a way to add them, by hand or from a spreadsheet (#41).
 */

interface Check { key: string; label: string; why: string; master?: string; required: boolean; count: number; min: number; done: boolean }
interface Readiness { ready: boolean; missing: string[]; checks: Check[] }

// Fresh on every visit: records are added on other pages (masters, import), and the steps should show it.
export const useReadiness = () => useQuery({ queryKey: ["readiness"], queryFn: () => api<Readiness>("/meta/readiness"), staleTime: 0, refetchOnMount: "always" });

export function CompanySetup({ defs, onOpen }: { defs: Rec[]; onOpen: (key: string) => void }) {
  const readiness = useReadiness();
  const [importing, setImporting] = useState<Rec | null>(null);
  if (!readiness.data) return <p className="muted">Checking what's set up…</p>;
  const { ready, missing, checks } = readiness.data;
  const byKey = new Map(defs.map((d) => [String(d.key), d]));
  const step = (c: Check, i: number) => {
    const def = c.master ? byKey.get(c.master) : undefined;
    const importable = Boolean(def?.permissions?.create && !def?.managed?.create);
    return (
      <li key={c.key} className={c.done ? "setup-step done" : "setup-step"}>
        {c.done ? <CheckCircle2 className="setup-icon ok" size={20} aria-label="Done" /> : <Circle className="setup-icon" size={20} aria-label="To do" />}
        <div className="setup-text">
          <strong>{i + 1}. {c.label}{!c.required && <span className="muted"> · optional</span>}</strong>
          <span className="setup-why">{c.why}</span>
          {c.master && <span className="setup-count">{c.count === 0 ? "None yet" : `${c.count} ${c.count === 1 ? "record" : "records"}`}{c.min > 1 && !c.done ? ` (at least ${c.min})` : ""}</span>}
        </div>
        <div className="row-actions">
          <Button size="sm" onClick={() => onOpen(c.master ?? "company")}>Open</Button>
          {importable && <Button size="sm" onClick={() => setImporting(def!)}><Upload size={14} /> Import</Button>}
        </div>
      </li>
    );
  };
  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Ready for a first trip</h2>
          <p>Everything a first trip needs, in the order to add it. Any step can be done later. To set up the company itself, its brand, people and services, use Set up a company.</p>
        </div>
      </header>
      <p className={ready ? "setup-banner ok" : "setup-banner"}>
        {ready
          ? <><Status tone="ok">Ready</Status> Everything a first trip needs is in place.</>
          : <><Status tone="wait">Not ready</Status> Still needed for a first trip: {missing.join(", ")}.</>}
      </p>
      <ol className="setup-steps">{checks.map(step)}</ol>
      {importing && <ImportDialog master={String(importing.key)} label={String(importing.label)} onClose={() => { setImporting(null); void readiness.refetch(); }} />}
    </div>
  );
}
