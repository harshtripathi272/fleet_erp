import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, authorizedFetch } from "../api/client";
import type { Rec } from "../api/adapter";
import { useAreaList } from "../api/areas";
import { useApp } from "../store";
import { Button, ChoiceChips, Empty, Field, FieldGroup, Segmented, SettingRow, SettingsSection, Status, UnitInput } from "../ui/kit";
import { stamp } from "../ui/format";
import "./setup.css";

/**
 * Masters → Company kit (#76). A developer sets up a customer's company once and downloads the package that
 * deploys it. The company, brand, areas, connections and roles come from this installation, where they were
 * set up on their own screens; the owner, staff, data and where it runs are added here. The result is one
 * company file (no secrets: it names the server settings that hold them) and a zip built from it.
 */

interface Attachment { path: string; data: string }
interface Target { key: string; label: string; tested: boolean }
interface Problem { path: string; message: string }
interface KitInfo {
  file: Rec;
  attachments: Attachment[];
  targets: Target[];
  masters: { key: string; label: string }[];
  lastApplied: { at: string; company: string; results: { step: string; outcome: string; detail?: string }[] } | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
/** What the installation decides; "Take again from this installation" replaces only these. */
const FROM_INSTALLATION = ["company", "regional", "brand", "watermark", "areas", "operations", "selfSignUp", "connections", "roles"];
const IMAGE_TYPES = "image/png,image/jpeg,image/webp";

const toBase64 = async (file: Blob) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const saveBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
/** "data/vehicles.csv" from a master and a chosen file, so two files never share a name. */
const dataPath = (master: string) => `data/${master}.csv`;

export function CompanyKit() {
  const { toast } = useApp();
  const info = useQuery({ queryKey: ["setup-kit"], queryFn: () => api<KitInfo>("/setup-kit"), staleTime: Infinity });
  const areas = useAreaList();
  const roles = useQuery({ queryKey: ["roles", "all"], queryFn: () => api<Rec[]>("/roles", { query: { limit: 100 } }) });
  const [file, setFile] = useState<Rec | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const opener = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (info.data && !file) { setFile(info.data.file); setAttachments(info.data.attachments); }
  }, [info.data, file]);

  const body = () => ({ file, attachments });
  const check = useMutation({
    mutationFn: () => api<{ ok: boolean; problems: Problem[] }>("/setup-kit/check", { method: "POST", body: body() }),
    onSuccess: (r) => { setProblems(r.problems); toast(r.ok ? "The company file is ready" : `${r.problems.length} to fix before the kit can be made`, r.ok ? "ok" : "error"); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const download = useMutation({
    mutationFn: async () => {
      const res = await authorizedFetch("/setup-kit/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "company-kit.zip";
      saveBlob(await res.blob(), name);
      return name;
    },
    onSuccess: (name) => { setProblems([]); toast(`${name} downloaded`); },
    onError: (e: Error & { details?: { problems?: string[] } }) => {
      const list = e.details?.problems;
      if (list) setProblems(list.map((p) => ({ path: p.slice(0, p.indexOf(": ")), message: p.slice(p.indexOf(": ") + 2) })));
      toast(e.message, "error");
    },
  });

  if (info.isLoading || !file) return <p className="muted">Loading the company kit…</p>;
  if (info.error) return <Empty title="Could not load the company kit">{(info.error as Error).message}</Empty>;
  const { targets, masters, lastApplied } = info.data!;

  const set = (path: string, value: unknown) => setFile((f) => {
    const next = structuredClone(f) as Rec;
    const keys = path.split(".");
    let at = next;
    for (const k of keys.slice(0, -1)) at = (at[k] ??= {});
    if (value === "" || value === undefined) delete at[keys.at(-1)!];
    else at[keys.at(-1)!] = value;
    return next;
  });
  const problemAt = (prefix: string) => problems?.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}.`)).map((p) => p.message).join(" ") || undefined;
  const putAttachment = (path: string, data: string) => setAttachments((list) => [...list.filter((a) => a.path !== path), { path, data }]);

  const openFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    try {
      setFile(JSON.parse(await chosen.text()));
      setProblems(null);
      toast(`${chosen.name} opened. Add its logo and data files again: a company file names them but doesn't hold them.`);
    } catch { toast(`${chosen.name} is not a company file`, "error"); }
  };
  const takeAgain = async () => {
    const fresh = (await info.refetch()).data;
    if (!fresh) return;
    setFile((f) => ({ ...f, ...Object.fromEntries(FROM_INSTALLATION.map((k) => [k, fresh.file[k]])) }));
    setAttachments((list) => [...list.filter((a) => a.path.startsWith("data/")), ...fresh.attachments]);
    toast("Taken again from this installation; the people, data and deployment are kept");
  };

  const company = (file.company ?? {}) as Rec;
  const brand = (file.brand ?? {}) as Rec;
  const regional = (file.regional ?? {}) as Rec;
  const deploy = (file.deploy ?? { target: "compose" }) as Rec;
  const target = targets.find((t) => t.key === deploy.target);
  const roleOptions = [
    ...(roles.data ?? []).filter((r) => r.key !== "owner" && r.status === "active").map((r) => ({ value: String(r.key), label: String(r.name) })),
    ...((file.roles ?? []) as Rec[]).filter((r) => !(roles.data ?? []).some((x) => x.key === r.key)).map((r) => ({ value: String(r.key), label: String(r.name) })),
  ];
  const staff = (file.staff ?? []) as Rec[];
  const dataFiles = ((file.data ?? {}).files ?? []) as Rec[];
  const logo = attachments.find((a) => a.path === brand.files?.logo);

  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Company kit</h2>
          <p>Set up a customer's company once and download the package that deploys it, with instructions for where it will run. The company, brand, areas, connections and roles come from this installation; add the people, the data and where it runs.</p>
        </div>
        <div className="kit-head-actions">
          <input ref={opener} type="file" accept="application/json,.json" hidden onChange={(e) => { void openFile(e.target.files?.[0]); e.target.value = ""; }} />
          <Button onClick={() => opener.current?.click()}>Open a company file</Button>
          <Button onClick={() => void takeAgain()}>Take again from this installation</Button>
        </div>
      </header>

      <div className="settings-page kit">
        {lastApplied && (
          <p className="kit-applied">
            This installation was set up from <code>{lastApplied.company}</code>'s company file, last applied {stamp(lastApplied.at)}.{" "}
            {lastApplied.results.filter((r) => r.outcome === "failed").length > 0
              ? <Status tone="bad">{lastApplied.results.filter((r) => r.outcome === "failed").length} steps failed: see the server log</Status>
              : <Status tone="ok">Every step worked</Status>}
          </p>
        )}

        <SettingsSection title="1. Company" description="The name on every document, and the short name used for the company's servers, buckets and the kit's file name.">
          <div className="grid-2">
            <Field label="Legal name" hint={problemAt("company.legalName")}><input className="input" value={String(company.legalName ?? "")} onChange={(e) => set("company.legalName", e.target.value)} /></Field>
            <Field label="Trading name"><input className="input" value={String(company.tradingName ?? "")} onChange={(e) => set("company.tradingName", e.target.value || undefined)} /></Field>
            <Field label="Short name" hint={problemAt("company.key") ?? "3–30 lowercase letters, digits or hyphens, e.g. acme-haulage."}>
              <input className="input" value={String(company.key ?? "")} onChange={(e) => set("company.key", e.target.value.toLowerCase())} />
            </Field>
            <Field label="E-mail" hint={problemAt("company.email")}><input className="input" type="email" value={String(company.email ?? "")} onChange={(e) => set("company.email", e.target.value)} /></Field>
          </div>
        </SettingsSection>

        <SettingsSection title="2. Brand" description="How the app and its e-mails look for this company. The logo goes in the kit as a file.">
          <div className="grid-2">
            <Field label="Product name" hint="Shown in the app, on sign-in and in e-mail subjects. Empty: the trading name."><input className="input" value={String(brand.productName ?? "")} onChange={(e) => set("brand.productName", e.target.value)} /></Field>
            <FieldGroup label="Colour" hint={problemAt("brand.accent") ?? "A colour such as #1d4d3f."}>
              <span className="kit-colour">
                <input type="color" aria-label="Pick the colour" value={/^#[0-9a-f]{6}$/i.test(String(brand.accent ?? "")) ? String(brand.accent) : "#1d4d3f"} onChange={(e) => set("brand.accent", e.target.value)} />
                <input className="input" aria-label="Colour" value={String(brand.accent ?? "")} onChange={(e) => set("brand.accent", e.target.value)} placeholder="#1d4d3f" />
              </span>
            </FieldGroup>
          </div>
          <SettingRow title="Logo" description={logo ? `${brand.files.logo}, ${Math.round((logo.data.length * 3) / 4 / 1024)} KB` : "None: the product name is shown instead. PNG, JPEG or WebP."}>
            <span className="kit-file">
              {logo && <img src={`data:image/${brand.files.logo.split(".").pop() === "jpg" ? "jpeg" : brand.files.logo.split(".").pop()};base64,${logo.data}`} alt="" />}
              <label className="btn btn-secondary">
                {logo ? "Replace" : "Choose a logo"}
                <input type="file" accept={IMAGE_TYPES} hidden onChange={async (e) => {
                  const chosen = e.target.files?.[0];
                  if (!chosen) return;
                  const path = `files/logo.${chosen.type === "image/jpeg" ? "jpg" : chosen.type.split("/")[1]}`;
                  putAttachment(path, await toBase64(chosen));
                  set("brand.files", { ...(brand.files ?? {}), logo: path });
                }} />
              </label>
            </span>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="3. Regional settings" description="Codes, not records: they are looked up once the data files are in, so the currency and country must be in them (or in the sample data).">
          <div className="grid-2">
            <Field label="Country" hint={problemAt("regional.country") ?? "Its two-letter code, e.g. ZM."}><input className="input" value={String(regional.country ?? "")} onChange={(e) => set("regional.country", e.target.value.toUpperCase())} maxLength={2} /></Field>
            <Field label="Base currency" hint={problemAt("regional.baseCurrency") ?? "Its three-letter code, such as USD."}><input className="input" value={String(regional.baseCurrency ?? "")} onChange={(e) => set("regional.baseCurrency", e.target.value.toUpperCase())} maxLength={3} /></Field>
            <Field label="Time zone">
              <select className="input" value={String(regional.timezone ?? "")} onChange={(e) => set("regional.timezone", e.target.value)}>
                <option value="">Not set</option>
                {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </Field>
            <Field label="Financial year starts in">
              <select className="input" value={String(regional.fiscalYearStartMonth ?? "")} onChange={(e) => set("regional.fiscalYearStartMonth", e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">Not set</option>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </Field>
            {/* A select, not buttons: the three formats don't fit side by side on a phone. */}
            <Field label="Dates are written">
              <select className="input" value={String(regional.dateFormat ?? "DD/MM/YYYY")} onChange={(e) => set("regional.dateFormat", e.target.value)}>
                {["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection title="4. Areas" description="Whole parts of the app the company uses. Masters is always on.">
          <FieldGroup label="Switched on" wide>
            <ChoiceChips
              label="Areas"
              value={((file.areas as string[] | undefined) ?? (areas.data ?? []).filter((a) => a.on).map((a) => a.key))}
              onChange={(next) => set("areas", next.includes("masters") ? next : ["masters", ...next])}
              options={(areas.data ?? []).filter((a) => a.state !== "not-built").map((a) => ({ value: a.key, label: a.name }))}
            />
          </FieldGroup>
        </SettingsSection>

        <SettingsSection title="5. Connections" description="The outside services the company uses, as set up under Masters → Connections. Their keys are named here, never written: the kit's .env asks for each one.">
          {((file.connections ?? []) as Rec[]).length === 0 && <p className="muted">None: every service runs on its Simulated stand-in, and e-mail goes over the server's SMTP settings.</p>}
          {((file.connections ?? []) as Rec[]).map((c, i) => (
            <SettingRow key={String(c.code)} title={<>{String(c.name)} {c.enabled ? <Status tone="ok">In use</Status> : <Status tone="mute">Off</Status>}</>}
              description={<>{String(c.kind)} · {String(c.provider)}{Object.values(c.secrets ?? {}).length ? <> · keys: {Object.values(c.secrets ?? {}).map((s) => <code key={String(s)}>{String(s)}</code>)}</> : null}{problemAt(`connections.${i}`) && <span className="kit-problem"> {problemAt(`connections.${i}`)}</span>}</>}>
              <Button tone="quiet" onClick={() => set("connections", (file.connections as Rec[]).filter((_, j) => j !== i))}>Leave out</Button>
            </SettingRow>
          ))}
        </SettingsSection>

        <SettingsSection title="6. Roles" description="The company's own roles, from this installation. Owner, Operations, Finance and the other built-in roles come with every installation.">
          {((file.roles ?? []) as Rec[]).length === 0 && <p className="muted">Only the built-in roles.</p>}
          {((file.roles ?? []) as Rec[]).map((r, i) => (
            <SettingRow key={String(r.key)} title={String(r.name)} description={`${(r.permissions ?? []).length} permissions${r.description ? ` · ${r.description}` : ""}`}>
              <Button tone="quiet" onClick={() => set("roles", (file.roles as Rec[]).filter((_, j) => j !== i))}>Leave out</Button>
            </SettingRow>
          ))}
        </SettingsSection>

        <SettingsSection title="7. Owner and staff" description="Each gets an e-mail to choose a password on the first start, once e-mail is set up. Nobody is invited twice.">
          <div className="grid-2">
            <Field label="Owner's name"><input className="input" value={String(file.owner?.name ?? "")} onChange={(e) => set("owner.name", e.target.value)} /></Field>
            <Field label="Owner's e-mail" hint={problemAt("owner.email")}><input className="input" type="email" value={String(file.owner?.email ?? "")} onChange={(e) => set("owner.email", e.target.value.trim().toLowerCase())} /></Field>
          </div>
          {staff.map((p, i) => (
            <article className="kit-card" key={i}>
              <header><strong>Staff {i + 1}</strong><Button tone="quiet" size="sm" onClick={() => set("staff", staff.filter((_, j) => j !== i))}>Remove</Button></header>
              <div className="grid-2">
                <Field label="Name"><input className="input" value={String(p.name ?? "")} onChange={(e) => set("staff", staff.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></Field>
                <Field label="E-mail" hint={problemAt(`staff.${i}`)}><input className="input" type="email" value={String(p.email ?? "")} onChange={(e) => set("staff", staff.map((x, j) => (j === i ? { ...x, email: e.target.value.trim().toLowerCase() } : x)))} /></Field>
              </div>
              <FieldGroup label="Roles" wide>
                <ChoiceChips label="Roles" value={(p.roles ?? []) as string[]} onChange={(next) => set("staff", staff.map((x, j) => (j === i ? { ...x, roles: next } : x)))} options={roleOptions} />
              </FieldGroup>
            </article>
          ))}
          <Button onClick={() => set("staff", [...staff, { name: "", email: "", roles: [] }])}>Add someone</Button>
        </SettingsSection>

        <SettingsSection title="8. Data" description="Spreadsheets imported on the first start, in this order, as Import does: a row already there is left alone. Put currencies and countries first, then what refers to them.">
          <SettingRow title="Sample data" description="The sample operation, for a demonstration copy. Never for a company's real one.">
            <Segmented choice label="Sample data" value={String(file.data?.sample ?? "none")} onChange={(v) => set("data.sample", v)} options={[{ value: "none", label: "None" }, { value: "small", label: "Small" }, { value: "full", label: "Full" }]} />
          </SettingRow>
          {dataFiles.map((d, i) => {
            const attached = attachments.find((a) => a.path === d.file);
            return (
              <article className="kit-card" key={i}>
                <header><strong>File {i + 1}</strong><Button tone="quiet" size="sm" onClick={() => { set("data.files", dataFiles.filter((_, j) => j !== i)); setAttachments((l) => l.filter((a) => a.path !== d.file)); }}>Remove</Button></header>
                <div className="grid-2">
                  <Field label="Master" hint={problemAt(`data.files.${i}`)}>
                    <select className="input" value={String(d.master)} onChange={(e) => {
                      const path = dataPath(e.target.value);
                      setAttachments((l) => l.map((a) => (a.path === d.file ? { ...a, path } : a)));
                      set("data.files", dataFiles.map((x, j) => (j === i ? { master: e.target.value, file: path } : x)));
                    }}>
                      {masters.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  </Field>
                  <FieldGroup label="Spreadsheet (CSV)" hint={attached ? `${d.file}, ${Math.max(0, atob(attached.data).split(/\r?\n/).filter(Boolean).length - 1)} rows` : "Not chosen yet"}>
                    <span className="kit-file">
                      <label className="btn btn-secondary">
                        {attached ? "Replace" : "Choose a file"}
                        <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const chosen = e.target.files?.[0]; if (chosen) putAttachment(String(d.file), await toBase64(chosen)); }} />
                      </label>
                      <Button tone="quiet" onClick={async () => saveBlob(await (await authorizedFetch(`/meta/import/${d.master}/template`)).blob(), `${d.master}-template.csv`)}>Template</Button>
                    </span>
                  </FieldGroup>
                </div>
              </article>
            );
          })}
          <Button onClick={() => {
            const next = masters.find((m) => !dataFiles.some((d) => d.master === m.key)) ?? masters[0]!;
            set("data.files", [...dataFiles, { master: next.key, file: dataPath(next.key) }]);
          }}>Add a data file</Button>
        </SettingsSection>

        <SettingsSection title="9. Where it runs" description="The kit carries the deploy script and the guide for this platform. Each one's secrets are asked for when deploying, never kept here.">
          <div className="grid-2">
            <Field label="Platform" hint={target && (target.tested ? "Tested end to end in CI." : "A script and a guide; not yet tested in CI.")}>
              <select className="input" value={String(deploy.target)} onChange={(e) => set("deploy", { target: e.target.value, domain: deploy.domain, smtp: deploy.smtp, image: deploy.image })}>
                {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Address" hint={problemAt("deploy.domain") ?? "The company's own, e.g. fleet.acme.example. Point it at the platform once deployed."}>
              <input className="input" value={String(deploy.domain ?? "")} onChange={(e) => set("deploy.domain", e.target.value.trim().toLowerCase())} placeholder="fleet.acme.example" />
            </Field>
            <Field label="Image" hint={problemAt("deploy.image") ?? (deploy.target === "gcp" ? "Empty: the project's own registry." : "The shared image, without its version, e.g. ghcr.io/acme/fleet-erp.")}>
              <input className="input" value={String(deploy.image ?? "")} onChange={(e) => set("deploy.image", e.target.value.trim())} />
            </Field>
            {deploy.target === "gcp" && <>
              <Field label="Google Cloud project" hint={problemAt("deploy.projectId")}><input className="input" value={String(deploy.projectId ?? "")} onChange={(e) => set("deploy.projectId", e.target.value)} /></Field>
              <Field label="Region"><input className="input" value={String(deploy.region ?? "")} onChange={(e) => set("deploy.region", e.target.value)} placeholder="africa-south1" /></Field>
            </>}
            {(deploy.target === "aws" || deploy.target === "render" || deploy.target === "fly") && (
              <Field label="Region"><input className="input" value={String(deploy.region ?? "")} onChange={(e) => set("deploy.region", e.target.value)} placeholder={{ aws: "af-south-1", render: "frankfurt", fly: "jnb" }[deploy.target as string]} /></Field>
            )}
            {deploy.target === "azure" && (
              <Field label="Location"><input className="input" value={String(deploy.location ?? "")} onChange={(e) => set("deploy.location", e.target.value)} placeholder="southafricanorth" /></Field>
            )}
            {deploy.target === "compose" && (
              <Field label="Backups kept"><UnitInput label="Backups kept" unit="days" value={deploy.backupDays as number | undefined ?? 14} onChange={(v) => set("deploy.backupDays", v ? Number(v) : undefined)} /></Field>
            )}
          </div>
          <div className="grid-2">
            <Field label="E-mail server" hint={problemAt("deploy.smtp") ?? "For invitations and password resets. Its password is asked for when deploying."}>
              <input className="input" value={String(deploy.smtp?.host ?? "")} onChange={(e) => set("deploy.smtp", e.target.value ? { port: 587, ...(deploy.smtp ?? {}), host: e.target.value } : undefined)} placeholder="smtp.example.com" />
            </Field>
            <Field label="E-mails come from"><input className="input" value={String(deploy.smtp?.from ?? "")} onChange={(e) => set("deploy.smtp.from", e.target.value)} placeholder="Acme Fleet <fleet@acme.example>" disabled={!deploy.smtp?.host} /></Field>
            <Field label="E-mail account"><input className="input" value={String(deploy.smtp?.user ?? "")} onChange={(e) => set("deploy.smtp.user", e.target.value)} disabled={!deploy.smtp?.host} /></Field>
          </div>
        </SettingsSection>

        {problems && problems.length > 0 && (
          <section className="kit-problems" aria-live="polite">
            <h3>To fix before the kit can be made</h3>
            <ul>{problems.map((p, i) => <li key={i}><code>{p.path || "file"}</code> {p.message}</li>)}</ul>
          </section>
        )}
        <footer className="kit-actions">
          <Button onClick={() => saveBlob(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" }), `${company.key || "company"}.json`)}>Download company file</Button>
          <Button busy={check.isPending} onClick={() => check.mutate()}>Check</Button>
          <Button tone="primary" busy={download.isPending} onClick={() => download.mutate()}>Download kit</Button>
        </footer>
      </div>
    </div>
  );
}

export default CompanyKit;
