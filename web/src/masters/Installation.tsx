import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, authorizedFetch } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { Button, Empty, SettingRow, SettingsSection } from "../ui/kit";

/**
 * This installation (#95): what kind of copy this is, its configuration as a file, applying a configuration
 * file after seeing what it would change, and resetting a demonstration. Setting up another company is not
 * done from a company's copy; a demonstration copy keeps the set-up and the packager until Fleet Studio.
 */

type Purpose = "demo" | "trial" | "production";
interface Status { hasCompany: boolean; applied: boolean; appliedAt: string | null; purpose: Purpose; trialEnds: string | null; trialDaysLeft: number | null; version: string | null }
interface Preview { ok: boolean; problems: { path: string; message: string }[]; sections: { key: string; label: string; change: "new" | "changed" | "unchanged" }[]; company?: string }

const PURPOSE: Record<Purpose, string> = { demo: "Demonstration: made-up data, can be reset", trial: "Trial", production: "Production" };
const CHANGE: Record<Preview["sections"][number]["change"], string> = { new: "Set up", changed: "Changes", unchanged: "Stays as it is" };

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function InstallationPanel() {
  const { me, toast, data } = useApp();
  const owner = me.roles.includes("owner");
  const status = useQuery({ queryKey: ["installation-status"], queryFn: () => api<Status>("/installation/status") });
  const [file, setFile] = useState<{ name: string; json: unknown } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"" | "export" | "preview" | "apply" | "reset">("");
  const [confirm, setConfirm] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  if (status.isLoading) return <p className="muted">Loading…</p>;
  if (status.error || !status.data) return <Empty title="Could not load this installation">{(status.error as Error | undefined)?.message}</Empty>;
  const s = status.data;
  const name = data.settings.company;

  const exportFile = async () => {
    setBusy("export");
    try {
      const out = await api<{ file: Rec }>("/installation/export");
      download(`${String(out.file.company?.key ?? "company")}-configuration.json`, JSON.stringify(out.file, null, 2));
    } catch (error) { toast((error as Error).message, "error"); } finally { setBusy(""); }
  };
  const choose = async (f: File | undefined) => {
    if (!f) return;
    setPreview(null);
    setSteps([]);
    try {
      const json = JSON.parse(await f.text());
      setFile({ name: f.name, json });
      setBusy("preview");
      setPreview(await api<Preview>("/installation/apply/preview", { method: "POST", body: { file: json } }));
    } catch (error) { toast(error instanceof SyntaxError ? "That file isn't a configuration file (it isn't JSON)." : (error as Error).message, "error"); } finally { setBusy(""); }
  };
  const apply = async () => {
    if (!file) return;
    setBusy("apply");
    setSteps([]);
    try {
      // The answer streams one line per finished step (the set-up's own apply).
      const res = await authorizedFetch("/setup-kit/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: file.json }) });
      const text = await res.text();
      const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; step?: string; outcome?: string; message?: string });
      const failed = lines.find((l) => l.type === "error");
      if (!res.ok || failed) throw new Error(failed?.message ?? `The file wasn't applied (${res.status}).`);
      setSteps(lines.filter((l) => l.type === "step" && l.outcome !== "unchanged").map((l) => `${l.step}: ${l.outcome}`));
      toast("Configuration applied.");
      void status.refetch();
      setPreview(null);
    } catch (error) { toast((error as Error).message, "error"); } finally { setBusy(""); }
  };
  const reset = async () => {
    setBusy("reset");
    try {
      await api("/installation/reset", { method: "POST", body: { confirm } });
      toast("The demonstration was loaded again. Signing you back in…");
      setTimeout(() => location.reload(), 1200);
    } catch (error) { toast((error as Error).message, "error"); } finally { setBusy(""); }
  };

  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>This installation</h2>
          <p>What kind of copy this is, and this company's configuration as a file: to keep, to give to your provider, or to apply a new one.</p>
        </div>
      </header>
      <div className="settings-page">
        <SettingsSection title="About this copy">
          <SettingRow title="Kind of copy" description="Set by whoever deployed this copy, not from a screen. Only a demonstration copy can be reset.">
            <span className="setting-fixed">{s.purpose === "trial" && s.trialEnds ? `Trial until ${s.trialEnds}${s.trialDaysLeft !== null && s.trialDaysLeft <= 3 ? ` (${Math.max(0, s.trialDaysLeft)} days left)` : ""}` : PURPOSE[s.purpose]}</span>
          </SettingRow>
          <SettingRow title="Version"><span className="setting-fixed mono">{s.version ?? "Not recorded"}</span></SettingRow>
          <SettingRow title="Configuration file" description="A file applied when the copy starts, or from below. Settings changed in the app keep their values unless a file changes that same setting.">
            <span className="setting-fixed">{s.appliedAt ? `Applied ${new Date(s.appliedAt).toLocaleString()}` : "None applied yet"}</span>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Configuration as a file" description="The company's settings, masters, roles and connections, without passwords or keys: those are never stored in the app.">
          <SettingRow title="Export the configuration" description={owner ? "Downloads it as one JSON file." : "Only an Owner can export it."}>
            <Button disabled={!owner} busy={busy === "export"} onClick={() => void exportFile()}>Export</Button>
          </SettingRow>
          <SettingRow title="Apply a configuration file" description="First you see what it would change, section by section. Only what the file changes is applied, and nothing is ever deleted.">
            <input ref={picker} type="file" accept="application/json,.json" hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
            <Button disabled={!owner} busy={busy === "preview"} onClick={() => picker.current?.click()}>Choose a file</Button>
          </SettingRow>
          {preview && file && (
            <div className="install-preview">
              <h4>{file.name}{preview.company ? ` · ${preview.company}` : ""}</h4>
              {preview.problems.length > 0 && (
                <ul className="install-problems" role="alert">
                  {preview.problems.map((p) => <li key={p.path + p.message}><b>{p.path}</b>: {p.message}</li>)}
                </ul>
              )}
              {preview.sections.length > 0 && (
                <div className="cust-table-wrap">
                  <table className="cust-table">
                    <thead><tr><th>Section</th><th>What applying does</th></tr></thead>
                    <tbody>{preview.sections.map((x) => <tr key={x.key}><td>{x.label}</td><td>{CHANGE[x.change]}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              <div className="row-actions">
                <Button tone="quiet" onClick={() => { setPreview(null); setFile(null); }}>Cancel</Button>
                <Button tone="primary" disabled={!preview.ok || preview.sections.every((x) => x.change === "unchanged")} busy={busy === "apply"} onClick={() => void apply()}>Apply</Button>
              </div>
            </div>
          )}
          {steps.length > 0 && (
            <div className="install-preview">
              <h4>Applied</h4>
              <ul>{steps.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
        </SettingsSection>

        {s.purpose === "demo" && (
          <SettingsSection title="Demonstration" description="This copy holds made-up data for showing and trying the app.">
            <SettingRow title="Reset this demonstration" description={`Removes everything except your account and loads the demonstration again, with new sign-ins for each desk. Type ${name || "the company's name"} to confirm.`} htmlFor="reset-confirm">
              <span className="install-reset">
                <input id="reset-confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={name} disabled={!owner} />
                <Button tone="danger" disabled={!owner || (Boolean(name) && confirm.trim().toLowerCase() !== name.toLowerCase())} busy={busy === "reset"} onClick={() => void reset()}>Reset</Button>
              </span>
            </SettingRow>
            <SettingRow title="Set up a company or make a package" description="On a demonstration copy, the set-up and the packager stay available for showing them. A company's own copy has neither.">
              <span className="install-reset">
                <Button onClick={() => { location.hash = "#set-up"; }}>Set up</Button>
                <Button onClick={() => { location.hash = "#package"; }}>Make a package</Button>
              </span>
            </SettingRow>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}

