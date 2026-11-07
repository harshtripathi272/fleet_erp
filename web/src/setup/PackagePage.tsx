import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, FileJson } from "lucide-react";
import { api, authorizedFetch } from "../api/client";
import type { Rec } from "../api/adapter";
import type { Me } from "../api/session";
import { Button, Empty, Segmented, SettingRow, SettingsSection, Switch } from "../ui/kit";
import { SetUpProvider, saveBlob, withValue, type Attachment, type Finish, type KitInfo, type Problem, type SetUpContext } from "./context";
import { DeployGuide } from "./StepGuide";
import { WhereStep } from "./StepsLive";
import "./setup.css";

/**
 * "Package this company": set a company up here, try it, change it until it's right, then one button turns the
 * whole thing into a package: its settings, masters and fields, people, and if wanted its records and files. It
 * always reads this copy fresh, so what you've just changed is what you get.
 */

const SAVED = "fleet.package.deploy";
const remembered = () => { try { return JSON.parse(localStorage.getItem(SAVED) ?? "null") as Rec | null; } catch { return null; } };
const bytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function PackagePage({ me, onLeave }: { me: Me; onLeave: () => void }) {
  const info = useQuery({ queryKey: ["setup-kit", "fresh"], queryFn: () => api<KitInfo & { capture: { masters: number; everything: number; files: number; fileBytes: number } }>("/setup-kit"), staleTime: 0, gcTime: 0 });
  const [file, setFile] = useState<Rec | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [records, setRecords] = useState<"none" | "masters" | "everything">("masters");
  const [withFiles, setWithFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    if (!info.data || file) return;
    const deploy = remembered();
    setFile({ ...info.data.file, ...(deploy ? { deploy } : { deploy: { target: "gcp", region: "africa-south1", domainMode: "none", projectId: "" } }) });
  }, [info.data, file]);
  useEffect(() => {
    if (!file) return;
    try { localStorage.setItem(SAVED, JSON.stringify(file.deploy)); } catch { /* only a convenience */ }
    const t = setTimeout(() => { api<{ problems: Problem[] }>("/setup-kit/check", { method: "POST", body: { file, attachments: info.data?.attachments ?? [], finish: "package" } }).then((r) => setProblems(r.problems)).catch(() => undefined); }, 400);
    return () => clearTimeout(t);
  }, [file, info.data]);

  const ctx: SetUpContext | null = useMemo(() => (file && info.data ? {
    file, info: info.data, me, attachments: info.data.attachments as Attachment[], putFile: async () => undefined, removeFile: () => undefined,
    err: (path) => problems.filter((p) => p.path === path || p.path.startsWith(`${path}.`)).map((p) => p.message).join(" ") || undefined,
    problems, finish: "package" as Finish, setFinish: () => undefined, go: () => undefined,
    set: (path, value) => setFile((f) => withValue(f!, path, value)), replace: setFile as (r: Rec) => void,
  } : null), [file, info.data, me, problems]);

  if (info.error) return <div className="su-wait"><Empty title="Could not read this copy">{(info.error as Error).message}</Empty><Button onClick={onLeave}>Back to the app</Button></div>;
  if (!ctx || !file || !info.data) return <div className="su-wait"><span className="spinner" aria-hidden /> Reading this company…</div>;
  if (!info.data.packages) return <div className="su-wait"><Empty title="This copy doesn't make packages">It's a real company's own copy. Its server setting SETUP_PACKAGES turns packages off.</Empty><Button onClick={onLeave}>Back to the app</Button></div>;

  const capture = info.data.capture;
  const m = (file.masters ?? {}) as { layouts?: Rec[]; fields?: Rec[]; customMasters?: Rec[]; lists?: Rec[] };
  const download = async () => {
    setBusy(true); setError(""); setDone("");
    try {
      const res = await authorizedFetch("/setup-kit/package", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, include: { records, files: records !== "none" && withFiles } }) });
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "company-kit.zip";
      saveBlob(await res.blob(), name);
      setDone(name);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const company = String(file.company?.tradingName || file.company?.legalName || "This company");
  const facts = [
    `${(m.layouts ?? []).length} ${(m.layouts ?? []).length === 1 ? "master" : "masters"} reshaped`,
    `${(m.fields ?? []).length} of its own ${(m.fields ?? []).length === 1 ? "field" : "fields"}`,
    `${(m.customMasters ?? []).length} of its own ${(m.customMasters ?? []).length === 1 ? "master" : "masters"}`,
    `${((file.roles ?? []) as Rec[]).length} custom ${((file.roles ?? []) as Rec[]).length === 1 ? "role" : "roles"}`,
    `${((file.staff ?? []) as Rec[]).length + 1} ${((file.staff ?? []) as Rec[]).length ? "people" : "person"}`,
    `${((file.connections ?? []) as Rec[]).filter((c) => c.enabled).length} connected ${((file.connections ?? []) as Rec[]).filter((c) => c.enabled).length === 1 ? "service" : "services"}`,
  ];
  const blockers = problems;

  return (
    <SetUpProvider value={ctx}>
      <div className="su-package">
        <header className="su-package-bar">
          <button type="button" className="su-leave" onClick={onLeave}><ArrowLeft size={14} aria-hidden /> Back to the app</button>
          <strong>Package this company</strong>
        </header>
        <main className="su-package-main">
          <div className="su-head su-head-flat">
            <h1>Package {company}</h1>
            <p>Everything on this copy, as it stands now, in one package that deploys it somewhere else. Change anything in the app first, then come back: this page always reads it fresh.</p>
          </div>
          <div className="su-stack">
            <SettingsSection title="What goes in" description={facts.join(" · ")}>
              <SettingRow title="Settings, brand, words and masters" description="Always: its details, region, brand, areas, trip rules, masters and fields, roles and people.">
                <span className="setting-fixed">Always in</span>
              </SettingRow>
              <SettingRow title="Records" description={records === "everything" ? "Masters, and every trip and all money too. For cloning a demonstration, rarely for a real company." : records === "masters" ? `${capture.masters.toLocaleString()} records: trucks, drivers, customers, routes and the rest. Links between them stay intact.` : "The new copy starts empty."}>
                <Segmented choice label="Records" value={records} onChange={(v) => setRecords(v as typeof records)} options={[{ value: "none", label: "None" }, { value: "masters", label: "Masters" }, { value: "everything", label: "Everything" }]} />
              </SettingRow>
              {records !== "none" && capture.files > 0 && (
                <SettingRow title="Uploaded files" description={`${capture.files.toLocaleString()} documents and photos, ${bytes(capture.fileBytes)}.`}>
                  <Switch label="Include uploaded files" checked={withFiles} onChange={setWithFiles} />
                </SettingRow>
              )}
              <SettingRow title="It's for" description={file.purpose === "demo" ? "A demonstration: it can be cleared and started again, and can make packages of its own." : "A real company: it needs an e-mail server, and can't make packages for others."}>
                <Segmented choice label="It's for" value={String(file.purpose ?? "real")} onChange={(v) => setFile(withValue(file, "purpose", v))} options={[{ value: "real", label: "A real company" }, { value: "demo", label: "A demonstration" }]} />
              </SettingRow>
            </SettingsSection>

            <div className="su-part-head"><h2>Where it runs</h2></div>
            <WhereStep packageOnly />

            <div className="su-part-head"><h2>How to deploy it</h2></div>
            <DeployGuide />

            {error && <p className="su-note bad" role="alert">{error}</p>}
            {blockers.length > 0 && (
              <div className="su-note bad">
                To fix first:
                <ul>{blockers.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
              </div>
            )}
          </div>
        </main>
        <footer className="su-foot">
          <div className="su-foot-in su-foot-package">
            <span className="su-saved">{done ? `${done} downloaded` : blockers.length ? `${blockers.length} to fix first` : "Ready"}</span>
            <span className="su-actions">
              <Button onClick={() => saveBlob(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" }), `${String(file.company?.key || "company")}.json`)}><FileJson size={15} /> Company file</Button>
              <Button tone="primary" busy={busy} disabled={blockers.length > 0 || busy} onClick={() => void download()}><Download size={16} /> Download the package</Button>
            </span>
          </div>
        </footer>
      </div>
    </SetUpProvider>
  );
}
