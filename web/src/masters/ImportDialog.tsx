import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { api, ApiError, authorizedFetch } from "../api/client";
import { useApp } from "../store";
import { Button, Modal, Status } from "../ui/kit";

/**
 * Loading a master from a spreadsheet (issue #41): download the template, fill it in Excel and save as CSV,
 * choose the file, see every problem by row before anything is saved, then load the rows that are ready.
 */

interface Problem { column: string; message: string }
interface RowResult { row: number; status: "ready" | "exists" | "invalid" | "created" | "failed"; problems: Problem[] }
interface Summary { ready: number; exists: number; invalid: number; created: number; failed: number }
const BATCH = 500;

/** Parses CSV as Excel writes it: comma or semicolon (whichever the header uses), quoted cells, a BOM. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

export function ImportDialog({ master, label, onClose }: { master: string; label: string; onClose: () => void }) {
  const { toast, refreshReference } = useApp();
  const client = useQueryClient();
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState<"check" | "load" | "template" | null>(null);
  const [loaded, setLoaded] = useState(false);

  /** Sends the rows in batches the API accepts and adds up the answers. */
  const send = async (all: Record<string, string>[], dryRun: boolean) => {
    const out: RowResult[] = [];
    const total: Summary = { ready: 0, exists: 0, invalid: 0, created: 0, failed: 0 };
    for (let i = 0; i < all.length; i += BATCH) {
      const part = await api<{ results: RowResult[]; summary: Summary }>(`/meta/import/${master}`, { method: "POST", body: { rows: all.slice(i, i + BATCH), dryRun, firstRow: i + 2 } });
      out.push(...part.results);
      for (const k of Object.keys(total) as (keyof Summary)[]) total[k] += part.summary[k];
    }
    return { out, total };
  };
  const check = async (parsed: Record<string, string>[]) => {
    setBusy("check");
    try {
      const { out, total } = await send(parsed, true);
      setResults(out);
      setSummary(total);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't check the file.", "error");
    } finally {
      setBusy(null);
    }
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setResults(null);
    setLoaded(false);
    const parsed = parseCsv(await file.text());
    setRows(parsed);
    if (!parsed.length) { toast("The file has no rows under its header.", "error"); return; }
    await check(parsed);
  };
  const load = async () => {
    if (!rows) return;
    setBusy("load");
    try {
      const { out, total } = await send(rows, false);
      setResults(out);
      setSummary(total);
      setLoaded(true);
      toast(`${total.created} ${label.toLowerCase()} added${total.failed ? `, ${total.failed} failed` : ""}.`, total.failed ? "error" : "ok");
      await client.invalidateQueries({ queryKey: ["records", master] });
      refreshReference();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "The load stopped part-way; check the list before trying again.", "error");
    } finally {
      setBusy(null);
    }
  };
  const template = async () => {
    setBusy("template");
    try {
      const res = await authorizedFetch(`/meta/import/${master}/template`);
      if (!res.ok) throw new Error(`The template could not be made (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `${master}-template.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const problems = (results ?? []).filter((r) => r.problems.length);
  return (
    <Modal open title={`Import ${label.toLowerCase()}`} onClose={onClose} width={720}
      footer={
        <>
          <span className="spacer" />
          <Button tone="quiet" onClick={onClose}>{loaded ? "Done" : "Cancel"}</Button>
          {!loaded && summary && summary.ready > 0 && (
            <Button tone="primary" busy={busy === "load"} onClick={() => void load()}><Upload size={15} /> Load {summary.ready} row{summary.ready === 1 ? "" : "s"}</Button>
          )}
        </>
      }>
      <div className="import">
        <ol className="import-steps">
          <li>
            <span>Download the template, fill in one row per record in Excel or Sheets, and save it as <b>CSV</b>. References take a code or name, e.g. <i>SCANIA</i>; dates <i>2026-11-04</i> or <i>04/11/2026</i>; several values separated by <i>;</i>.</span>
            <Button size="sm" busy={busy === "template"} onClick={() => void template()}><Download size={15} /> Template</Button>
          </li>
          <li>
            <span>Choose the CSV. Every row is checked first; nothing is saved until you load.</span>
            <label className="btn btn-sm import-file">
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
              Choose file
            </label>
          </li>
        </ol>
        {busy === "check" && <p className="muted">Checking {rows?.length ?? 0} rows…</p>}
        {summary && (
          <p className="import-summary">
            <b>{fileName}</b>: {loaded
              ? <>{summary.created} added{summary.exists ? `, ${summary.exists} already there` : ""}{summary.failed + summary.invalid ? `, ${summary.failed + summary.invalid} not loaded` : ""}.</>
              : <>{summary.ready} ready{summary.exists ? `, ${summary.exists} already there (skipped)` : ""}{summary.invalid ? `, ${summary.invalid} with problems` : ""}.</>}
          </p>
        )}
        {problems.length > 0 && (
          <div className="table-frame import-problems">
            <table className="table">
              <thead><tr><th>Row</th><th>Column</th><th>Problem</th><th /></tr></thead>
              <tbody>
                {problems.flatMap((r) => r.problems.map((p, i) => (
                  <tr key={`${r.row}-${i}`}>
                    <td className="num">{i === 0 ? r.row : ""}</td>
                    <td>{p.column}</td>
                    <td>{p.message}</td>
                    <td>{i === 0 && <Status tone={r.status === "failed" ? "bad" : "wait"}>{r.status === "failed" ? "Failed" : "Fix and re-import"}</Status>}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
        {summary && !problems.length && !loaded && summary.ready > 0 && <p className="muted">No problems found.</p>}
      </div>
    </Modal>
  );
}
