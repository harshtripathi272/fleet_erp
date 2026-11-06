import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Download, Plus } from "lucide-react";
import { api, authorizedFetch } from "../api/client";
import type { Rec } from "../api/adapter";
import { SettingField } from "../settings/ConnectionsSettings";
import { COMING_SOON } from "../ui/comingSoon";
import { Button, Field, FieldGroup, SettingRow, SettingsSection, Status, Switch } from "../ui/kit";
import { FileDrop, saveBlob, useSetUp, type MasterOption } from "./context";

/* ---------- Connections ---------- */

interface FieldSpec { key: string; label: string; hint?: string; type: "string" | "number" | "boolean" | "choice"; required: boolean; choices?: { value: string; label: string }[]; default?: unknown; min?: number; max?: number }
interface SecretSpec { key: string; label: string; required: boolean; hint?: string }
interface ProviderInfo { key: string; label: string; description?: string; simulated: boolean; fields: FieldSpec[]; secrets: SecretSpec[]; inbound?: boolean }
interface KindState { kind: string; label: string; description: string; whenNone: string; providers: ProviderInfo[] }

const envName = (kind: string, key: string) => `CONNECTION_${kind}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
/** E-mail, then WhatsApp and SMS, and the rest in the server's order. */
const FIRST = ["email", "whatsapp", "sms", "storage"];

export function ConnectionsStep() {
  const kinds = useQuery({ queryKey: ["connection-kinds"], queryFn: () => api<KindState[]>("/connection-kinds") });
  const [open, setOpen] = useState<string | null>("email");
  if (kinds.isLoading) return <p className="muted">Loading the services…</p>;
  const sorted = [...(kinds.data ?? [])].sort((a, b) => (FIRST.indexOf(a.kind) + 1 || 99) - (FIRST.indexOf(b.kind) + 1 || 99));
  return (
    <div className="su-stack">
      <p className="su-lead">Each service works on a simulated stand-in until a real one is connected, so nothing here has to be done today. Real messages need a real service.</p>
      <section className="su-kinds">
        {sorted.map((k) => <KindRow key={k.kind} kind={k} open={open === k.kind} onToggle={() => setOpen(open === k.kind ? null : k.kind)} />)}
      </section>
    </div>
  );
}

function KindRow({ kind: k, open, onToggle }: { kind: KindState; open: boolean; onToggle: () => void }) {
  const { file, set, err, finish } = useSetUp();
  const list = (file.connections ?? []) as Rec[];
  const at = list.findIndex((c) => c.kind === k.kind);
  const chosen = at >= 0 ? list[at] : undefined;
  const provider = k.providers.find((p) => p.key === chosen?.provider);
  const soon = COMING_SOON.find((f) => f.kind === k.kind);
  // The server folder is what "this server's own" already means, so it isn't offered twice.
  const real = k.providers.filter((p) => !p.simulated && !(k.kind === "storage" && p.key === "local"));
  const simulated = k.providers.find((p) => p.simulated);

  const pick = (key: string) => {
    if (key === "none") return set("connections", list.filter((_, i) => i !== at));
    const p = k.providers.find((x) => x.key === key)!;
    const settings = Object.fromEntries(p.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
    const next: Rec = {
      code: k.kind.toUpperCase(), name: p.label, kind: k.kind, provider: p.key, enabled: true, settings,
      secrets: Object.fromEntries(p.secrets.map((s) => [s.key, envName(k.kind, s.key)])),
      ...(p.inbound ? { webhookSecretEnv: envName(k.kind, "SIGNING_SECRET") } : {}),
    };
    set("connections", at >= 0 ? list.map((c, i) => (i === at ? next : c)) : [...list, next]);
  };
  const setting = (key: string, value: unknown) => {
    const field = provider?.fields.find((f) => f.key === key);
    const typed = field?.type === "number" && value !== "" ? Number(value) : value;
    const settings = { ...(chosen!.settings ?? {}), [key]: typed };
    if (typed === "" || typed === undefined) delete settings[key];
    set("connections", list.map((c, i) => (i === at ? { ...c, settings } : c)));
  };
  const problem = at >= 0 ? err(`connections.${at}`) : undefined;
  const secretNames = chosen ? [...Object.entries((chosen.secrets ?? {}) as Record<string, string>).map(([key, name]) => ({ name, label: provider?.secrets.find((s) => s.key === key)?.label ?? key })), ...(chosen.webhookSecretEnv ? [{ name: String(chosen.webhookSecretEnv), label: "Signing secret" }] : [])] : [];

  return (
    <article className={`su-kind ${open ? "open" : ""}`}>
      <button type="button" className="su-kind-head" aria-expanded={open} onClick={onToggle}>
        <span className="su-kind-text">
          <strong>{k.label}{soon && <span className="status status-mute area-early">Using it on trips: coming soon</span>}</strong>
          <small>{k.description}</small>
        </span>
        <span className="su-kind-state">
          {chosen && provider && !provider.simulated ? <Status tone={problem ? "bad" : "ok"}>{provider.label}</Status>
            : simulated ? <Status tone="info">Simulated</Status> : <Status tone="mute">{k.kind === "storage" ? "On this server" : "Not connected"}</Status>}
          {open ? <ChevronUp size={17} aria-hidden /> : <ChevronDown size={17} aria-hidden />}
        </span>
      </button>
      {open && (
        <div className="su-kind-body">
          <FieldGroup label="How" wide hint={provider?.description ?? (simulated ? simulated.description ?? k.whenNone : k.whenNone)}>
            <div className="su-methods" role="radiogroup" aria-label={`${k.label} method`}>
              <button type="button" role="radio" aria-checked={!chosen || Boolean(provider?.simulated)} className={!chosen || provider?.simulated ? "on" : ""} onClick={() => pick("none")}>{simulated ? "Simulated" : k.kind === "storage" ? "This server's own" : "Not connected"}</button>
              {real.map((p) => <button key={p.key} type="button" role="radio" aria-checked={chosen?.provider === p.key} className={chosen?.provider === p.key ? "on" : ""} onClick={() => pick(p.key)}>{p.label}</button>)}
            </div>
          </FieldGroup>
          {real.length === 0 && <p className="su-note">No real service for this yet: it stays simulated, and says so wherever it shows.</p>}
          {chosen && provider && !provider.simulated && (
            <>
              {provider.fields.length > 0 && (
                <div className="grid-2">
                  {provider.fields.map((f) => <SettingField key={f.key} field={f as never} value={(chosen.settings?.[f.key] ?? "") as string} error={err(`connections.${at}.settings.${f.key}`)} onChange={(v) => setting(f.key, v)} />)}
                </div>
              )}
              {secretNames.length > 0 && (
                <div className="su-secrets">
                  <strong>Keys</strong>
                  <p>{finish === "package"
                    ? "Keys never go in the company file. The package's settings file asks for each of these, to fill in when you deploy."
                    : "Keys never go in the company file. Add these to this server's settings file, then restart it."}</p>
                  <ul>{secretNames.map((s) => <li key={s.name}><code>{s.name}=</code><span>{s.label}</span></li>)}</ul>
                </div>
              )}
              <SettingRow title="Use it from the start" description="Off: it's set up, but the simulated stand-in keeps working until someone switches it on.">
                <Switch label="Use it from the start" checked={Boolean(chosen.enabled)} onChange={(v) => set("connections", list.map((c, i) => (i === at ? { ...c, enabled: v } : c)))} />
              </SettingRow>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------- Data ---------- */

/** Spreadsheets in the order they can be read: what a record points to comes before it. */
function inOrder(files: Rec[], masters: MasterOption[]) {
  const byKey = new Map(masters.map((m) => [m.key, m]));
  const chosen = new Set(files.map((f) => String(f.master)));
  const out: Rec[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const need of byKey.get(key)?.needs ?? []) if (chosen.has(need)) visit(need);
    const file = files.find((f) => f.master === key);
    if (file) out.push(file);
  };
  files.forEach((f) => visit(String(f.master)));
  return out;
}
/** The likeliest order to add them in, for a company starting from spreadsheets. */
const COMMON = ["currencies", "countries", "provinces", "cities", "places", "vehicles", "trailers", "drivers", "customers", "suppliers", "products", "routes"];
const rowsIn = (base64: string | undefined) => (base64 ? Math.max(0, atob(base64).split(/\r?\n/).filter(Boolean).length - 1) : 0);

export function DataStep() {
  const { file, set, info, attachments, putFile, removeFile, err } = useSetUp();
  const masters = info.masters;
  const data = (file.data ?? {}) as Rec;
  const files = (data.files ?? []) as Rec[];
  const sample = String(data.sample ?? "none");
  const real = file.purpose !== "demo";
  const save = (next: Rec[]) => set("data.files", inOrder(next, masters));
  const add = (key?: string) => {
    const next = key ?? COMMON.find((m) => masters.some((x) => x.key === m) && !files.some((f) => f.master === m)) ?? masters.find((m) => !files.some((f) => f.master === m))?.key;
    if (next) save([...files, { master: next, file: `data/${next}.csv` }]);
  };
  const change = (i: number, master: string) => {
    const old = String(files[i]!.file);
    const path = `data/${master}.csv`;
    const body = attachments.find((a) => a.path === old);
    if (body) { removeFile(old); void putFile(path, new Blob([Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0))])); }
    save(files.map((f, j) => (j === i ? { master, file: path } : f)));
  };
  const remove = (i: number) => { removeFile(String(files[i]!.file)); save(files.filter((_, j) => j !== i)); };
  const template = async (master: string) => saveBlob(await (await authorizedFetch(`/meta/import/${master}/template`)).blob(), `${master}-template.csv`);
  const nameOf = (key: string) => masters.find((m) => m.key === key)?.label ?? key;

  return (
    <div className="su-stack">
      <SettingsSection title="Sample data" description="A made-up operation to look around in: trucks, drivers, customers, routes and trips at every stage.">
        <div className="su-pad su-choose three" role="radiogroup" aria-label="Sample data">
          {[
            { value: "none", title: "None", text: "Starts empty, ready for the company's own records." },
            { value: "small", title: "Small", text: "Only the masters: a few trucks, drivers, customers and routes, to run your own trips on." },
            { value: "full", title: "Full", text: "The masters and a working operation: trips under way, requests waiting and settlements done." },
          ].map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={sample === o.value} className={`su-choice ${sample === o.value ? "on" : ""}`} onClick={() => set("data.sample", o.value)}>
              <span className="su-choice-head"><strong>{o.title}</strong></span>
              <span className="su-choice-text">{o.text}</span>
            </button>
          ))}
        </div>
        {real && sample !== "none" && <p className="su-note bad">This is set up as a real company. Sample data mixes made-up records with its real ones, and they're awkward to remove. Choose None, unless this is only a try-out.</p>}
      </SettingsSection>

      <SettingsSection title="The company's own records" description={err("data.files") ?? "Spreadsheets to bring in: one for each master, as CSV. Download a template for the exact columns. A row that's already there is left alone. The order is worked out for you."}>
        {files.length > 0 && (
          <div className="cust-table-wrap su-table">
            <table className="cust-table su-files">
              <thead><tr><th>Goes into</th><th>Spreadsheet</th><th>Rows</th><th>Needs first</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {files.map((f, i) => {
                  const body = attachments.find((a) => a.path === f.file);
                  const needs = (masters.find((m) => m.key === f.master)?.needs ?? []).filter((n) => !files.some((x) => x.master === n));
                  return (
                    <tr key={String(f.file)}>
                      <td>
                        <select className="input" aria-label={`Master of spreadsheet ${i + 1}`} value={String(f.master)} onChange={(e) => change(i, e.target.value)}>
                          {masters.map((m) => <option key={m.key} value={m.key} disabled={m.key !== f.master && files.some((x) => x.master === m.key)}>{m.label}</option>)}
                        </select>
                        {err(`data.files.${i}`) && <span className="su-bad-text">{err(`data.files.${i}`)}</span>}
                      </td>
                      <td>
                        <FileDrop accept=".csv,text/csv" label="Drop a CSV or choose one" onFile={(chosen) => void putFile(String(f.file), chosen)} chosen={body ? <span className="su-file-name">{String(f.file).split("/").pop()}</span> : undefined} />
                      </td>
                      <td className="num">{body ? rowsIn(body.data).toLocaleString() : "—"}</td>
                      <td>{needs.length ? <span className="muted">{needs.slice(0, 3).map(nameOf).join(", ")}{needs.length > 3 ? "…" : ""}</span> : <span className="muted">Nothing else</span>}</td>
                      <td className="su-row-actions">
                        <Button size="sm" tone="quiet" onClick={() => void template(String(f.master))}><Download size={14} /> Template</Button>
                        <Button size="sm" tone="quiet" onClick={() => remove(i)}>Remove</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="su-pad"><Button onClick={() => add()}><Plus size={15} /> Add a spreadsheet</Button></div>
      </SettingsSection>
    </div>
  );
}

/* ---------- Where it runs ---------- */

const NEEDS: Record<string, string[]> = {
  gcp: ["A Google Cloud project with billing switched on", "The gcloud tool, signed in", "A database: MongoDB Atlas"],
  compose: ["A server with Docker, reachable from the internet", "A domain pointing at it"],
  aws: ["An AWS account and the aws tool, signed in", "A database: MongoDB Atlas", "An S3 bucket for files"],
  azure: ["An Azure subscription and the az tool, signed in", "A database: MongoDB Atlas"],
  render: ["A Render account", "A database: MongoDB Atlas"],
  fly: ["A Fly.io account and the fly tool, signed in", "A database: MongoDB Atlas"],
  railway: ["A Railway account and the railway tool, signed in", "A database: MongoDB Atlas"],
};

export function WhereStep() {
  const { file, set, info, finish, setFinish, err } = useSetUp();
  const deploy = (file.deploy ?? { target: "compose" }) as Rec;
  const target = info.targets.find((t) => t.key === deploy.target);
  const pick = (key: string) => {
    setFinish("package");
    set("deploy", { target: key, domain: deploy.domain, smtp: deploy.smtp, image: deploy.image });
  };
  const smtp = (deploy.smtp ?? {}) as Rec;
  const demo = file.purpose === "demo";
  const emailConnected = ((file.connections ?? []) as Rec[]).some((c) => c.kind === "email" && c.enabled && c.provider === "smtp");
  return (
    <div className="su-stack">
      <section className="su-where" role="radiogroup" aria-label="Where it runs">
        <button type="button" role="radio" aria-checked={finish === "here"} className={`su-where-row ${finish === "here" ? "on" : ""}`} onClick={() => setFinish("here")}>
          <span><strong>This copy, right here</strong><small>What you're signed in to now becomes this company, straight away. Nothing to install.</small></span>
          <Status tone="ok">Ready now</Status>
        </button>
        {info.packages ? info.targets.map((t) => (
          <button key={t.key} type="button" role="radio" aria-checked={finish === "package" && deploy.target === t.key} className={`su-where-row ${finish === "package" && deploy.target === t.key ? "on" : ""}`} onClick={() => pick(t.key)}>
            <span><strong>{t.label}</strong><small>{(t.needs ?? NEEDS[t.key] ?? []).join(" · ")}</small></span>
            <Status tone={t.state === "tested" ? "ok" : t.state === "dry-run" ? "wait" : "mute"}>{t.state === "tested" ? "Tested" : t.state === "dry-run" ? "Dry run only" : "Script only"}</Status>
          </button>
        )) : <p className="su-note">This copy doesn't make packages for other companies. Its server setting SETUP_PACKAGES turns them off.</p>}
      </section>

      {finish === "package" && target && (
        <>
          <p className="su-lead">You'll download one package with everything for {target.label}: the company file, its logos and spreadsheets, a settings file with only the secrets left to fill in, the deploy script and a guide written for this company.</p>
          <SettingsSection title="Its address and image">
            <div className="su-pad grid-2">
              <Field label="Address" hint={err("deploy.domain") ?? "The company's own, e.g. fleet.acme.example. Point it at the platform once deployed."}>
                <input className="input" value={String(deploy.domain ?? "")} onChange={(e) => set("deploy.domain", e.target.value.trim().toLowerCase())} placeholder="fleet.acme.example" />
              </Field>
              <Field label="Image" hint={err("deploy.image") ?? (deploy.target === "gcp" ? "Leave empty for the project's own registry." : "The shared image, without its version, e.g. ghcr.io/acme/fleet-erp.")}>
                <input className="input su-mono" value={String(deploy.image ?? "")} onChange={(e) => set("deploy.image", e.target.value.trim())} />
              </Field>
              {deploy.target === "gcp" && (
                <>
                  <Field label="Google Cloud project *" hint={err("deploy.projectId")}><input className="input su-mono" value={String(deploy.projectId ?? "")} onChange={(e) => set("deploy.projectId", e.target.value.trim())} placeholder="acme-fleet-prod" /></Field>
                  <Field label="Region" hint={err("deploy.region") ?? "Closest to the company. Johannesburg is africa-south1."}><input className="input su-mono" value={String(deploy.region ?? "")} onChange={(e) => set("deploy.region", e.target.value.trim())} placeholder="africa-south1" /></Field>
                </>
              )}
              {(deploy.target === "aws" || deploy.target === "render" || deploy.target === "fly") && (
                <Field label="Region" hint={err("deploy.region")}><input className="input su-mono" value={String(deploy.region ?? "")} onChange={(e) => set("deploy.region", e.target.value.trim())} placeholder={{ aws: "af-south-1", render: "frankfurt", fly: "jnb" }[String(deploy.target)]} /></Field>
              )}
              {deploy.target === "azure" && <Field label="Location" hint={err("deploy.location")}><input className="input su-mono" value={String(deploy.location ?? "")} onChange={(e) => set("deploy.location", e.target.value.trim())} placeholder="southafricanorth" /></Field>}
              {deploy.target === "compose" && <Field label="E-mail for the certificate" hint={err("deploy.certificateEmail") ?? "Let's Encrypt writes here if the address's certificate has a problem."}><input className="input" type="email" value={String(deploy.certificateEmail ?? "")} onChange={(e) => set("deploy.certificateEmail", e.target.value.trim())} /></Field>}
            </div>
          </SettingsSection>
          {!emailConnected && (
            <SettingsSection title="E-mail server" description={err("deploy.smtp") ?? (demo ? "Optional for a demonstration: e-mails are simulated without one." : "Needed so people get their invitations and password resets. Or connect e-mail under Connections instead.")}>
              <div className="su-pad grid-2">
                <Field label="Server"><input className="input su-mono" value={String(smtp.host ?? "")} onChange={(e) => set("deploy.smtp", e.target.value ? { port: 587, ...smtp, host: e.target.value.trim() } : undefined)} placeholder="smtp.example.com" /></Field>
                <Field label="E-mails come from"><input className="input" disabled={!smtp.host} value={String(smtp.from ?? "")} onChange={(e) => set("deploy.smtp.from", e.target.value)} placeholder="Acme Fleet <fleet@acme.example>" /></Field>
                <Field label="Account" hint="Its password is asked for when deploying."><input className="input" disabled={!smtp.host} value={String(smtp.user ?? "")} onChange={(e) => set("deploy.smtp.user", e.target.value.trim())} /></Field>
              </div>
            </SettingsSection>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Review ---------- */

export const STEP_WORDS: Record<string, string> = { company: "Company details", settings: "Settings", owner: "The owner", clear: "Clearing this copy" };
const OUTCOME: Record<string, { tone: "ok" | "wait" | "bad" | "info" | "mute"; word: string }> = {
  created: { tone: "ok", word: "Added" }, updated: { tone: "ok", word: "Updated" }, unchanged: { tone: "mute", word: "No change" }, skipped: { tone: "wait", word: "Skipped" }, failed: { tone: "bad", word: "Failed" },
};
export const stepName = (step: string) => STEP_WORDS[step]
  ?? step.replace(/^data data\//, "Spreadsheet ").replace(/^brand files\//, "Logo ").replace(/^sample data$/, "Sample data").replace(/^role /, "Role ").replace(/^connection /, "Connection ").replace(/^staff /, "").replace(/^currency /, "Currency ").replace(/^country /, "Country ").replace(/^regional /, "Region: ");

export interface Result { step: string; outcome: string; detail?: string }
/** The server lists what it changed by field; this says it in words. */
const SETTING_WORDS: Record<string, string> = {
  timezone: "time zone", dateFormat: "date format", fiscalYearStartMonth: "financial year", regional: "clock and number style", countryId: "country",
  baseCurrencyId: "base currency", vocabulary: "words", stages: "trip stages", desks: "desks", modules: "areas", allowSelfRegistration: "signing up",
  operations: "trip rules", maintenance: "maintenance rules", watermark: "watermark", brand: "brand",
};
const detailWords = (r: Result) => (r.step === "settings" && r.detail
  ? r.detail.replace(/\s*\([^)]*\)/g, "").split(", ").map((k) => SETTING_WORDS[k] ?? k).join(", ").replace(/^./, (c) => c.toUpperCase())
  : r.detail);
export function ResultList({ results }: { results: Result[] }) {
  return (
    <ul className="su-results" aria-live="polite">
      {results.map((r, i) => (
        <li key={i} className={r.outcome === "failed" ? "bad" : ""}>
          <span className="su-result-step">{stepName(r.step)}</span>
          <span className="su-result-detail">{detailWords(r)}</span>
          <Status tone={OUTCOME[r.outcome]?.tone ?? "mute"}>{OUTCOME[r.outcome]?.word ?? r.outcome}</Status>
        </li>
      ))}
    </ul>
  );
}

/** Each step in a line, as the person answered it. */
export function useSummaries(): Record<string, string> {
  const { file, finish, info } = useSetUp();
  return useMemo(() => {
    const c = (file.company ?? {}) as Rec;
    const r = (file.regional ?? {}) as Rec;
    const b = (file.brand ?? {}) as Rec;
    const areas = file.areas as string[] | undefined;
    const staff = ((file.staff ?? []) as Rec[]).length;
    const connected = ((file.connections ?? []) as Rec[]).filter((x) => x.enabled).map((x) => String(x.name));
    const spreadsheets = ((file.data?.files ?? []) as Rec[]).length;
    const words = Object.keys(file.workspace?.vocabulary ?? {}).length;
    const target = info.targets.find((t) => t.key === file.deploy?.target)?.label;
    return {
      start: file.purpose === "demo" ? "A demonstration" : "A real company",
      company: String(c.tradingName || c.legalName || ""),
      region: [r.country, r.baseCurrency].filter(Boolean).join(" · "),
      brand: [b.files?.logo ? "Logo" : "", b.accent ? String(b.accent) : ""].filter(Boolean).join(" · "),
      areas: areas ? `${areas.length} switched on` : "The usual",
      work: words ? `${words} ${words === 1 ? "word" : "words"} changed` : "The usual",
      people: `Owner${staff ? ` and ${staff} ${staff === 1 ? "person" : "people"}` : ""}`,
      connections: connected.length ? connected.join(", ") : "All simulated",
      data: [file.data?.sample && file.data.sample !== "none" ? `${String(file.data.sample) === "full" ? "Full" : "Small"} sample` : "", spreadsheets ? `${spreadsheets} spreadsheet${spreadsheets === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "Empty",
      where: finish === "here" ? "This copy" : target ?? "",
    };
  }, [file, finish, info.targets]);
}
