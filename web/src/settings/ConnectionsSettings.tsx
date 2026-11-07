import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api, request } from "../api/client";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Field, FieldGroup, Segmented, Status, SwitchField } from "../ui/kit";
import { stamp, phonePlaceholder } from "../ui/format";
import "./settings.css";
import { COMING_SOON, ComingSoonTag } from "../ui/comingSoon";

/**
 * Masters → Connections (#59): every outside service the system uses, by kind. Each kind says what it
 * uses now (a connection, the server's own settings, or its Simulated stand-in), and each provider's form
 * is drawn from the fields the server describes. Secrets never appear: a connection names the server
 * setting that holds each one, and the screen only says whether the server has it.
 */

interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  type: "string" | "number" | "boolean" | "choice";
  required: boolean;
  choices?: { value: string; label: string }[];
  default?: unknown;
  min?: number;
  max?: number;
}
interface SecretSpec { key: string; label: string; required: boolean; hint?: string }
interface GuideStep { text: string; link?: string }
interface ProviderInfo {
  key: string; label: string; description?: string; simulated: boolean; fields: FieldSpec[]; secrets: SecretSpec[]; inbound: boolean;
  ownSignature?: boolean; guide?: GuideStep[]; comingSoon?: string;
}
interface SecretSetup { names: { name: string; set: boolean }[]; label: string; steps: { text: string; command?: string }[] }
interface DraftResult { ok: boolean; simulated: boolean; message: string; missing?: string[] }
/** Where the app may run, for the commands that set its secrets there (#98). */
const SECRET_TARGETS: { value: string; label: string }[] = [
  { value: "env", label: "This computer (.env)" }, { value: "compose", label: "Docker Compose" }, { value: "gcp", label: "Google Cloud" },
  { value: "aws", label: "AWS" }, { value: "azure", label: "Azure" }, { value: "fly", label: "Fly.io" }, { value: "render", label: "Render" }, { value: "railway", label: "Railway" },
];
interface KindState {
  kind: string;
  label: string;
  description: string;
  whenNone: string;
  via: "connection" | "server" | "simulated" | "none";
  provider?: { key: string; label: string; simulated: boolean };
  connectionName?: string;
  providers: ProviderInfo[];
}
interface Connection {
  id: string;
  version: number;
  code: string;
  name: string;
  kind: string;
  provider: string;
  enabled?: boolean;
  status: string;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  secretsSet?: Record<string, boolean>;
  webhookSecretEnv?: string;
  webhookSecretSet?: boolean;
  webhookUrl?: string;
  lastTest?: { at: string; ok: boolean; message?: string; to?: string };
  lastError?: { at: string; message: string };
  lastUsedAt?: string;
}

const MESSAGE_KINDS = ["email", "sms", "whatsapp"];
/**
 * A short list of choices shows every option as a button; when their names wouldn't fit on a phone's
 * line, a dropdown instead, so no option's name breaks over two lines.
 */
const fitsAsButtons = (labels: string[]) => labels.length <= 5 && labels.join("").length <= 32;
/** A provider's name, saying Simulated once when it is a stand-in. */
const providerName = (p: ProviderInfo) => (p.comingSoon ? `${p.label} (Coming soon)` : p.simulated && !/simulated/i.test(p.label) ? `${p.label} (Simulated)` : p.label);

/** What a kind uses now, in a few words. */
function nowUsing(k: KindState) {
  if (k.via === "connection") return <Status tone={k.provider?.simulated ? "info" : "ok"}>{k.connectionName}{k.provider?.simulated ? " (Simulated)" : ""}</Status>;
  if (k.via === "server") return <Status tone="ok">The server's own settings</Status>;
  if (k.via === "none") return <Status tone="mute">Not connected</Status>;
  return <Status tone="info">Simulated</Status>;
}

export default function ConnectionsSettings() {
  const { me } = useApp();
  const writable = can(me, "connections", "update");
  const creatable = can(me, "connections", "create");
  const [editing, setEditing] = useState<{ kind: KindState; connection: Connection | null } | null>(null);
  const kinds = useQuery({ queryKey: ["connection-kinds"], queryFn: () => api<KindState[]>("/connection-kinds") });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<Connection[]>("/connections", { query: { limit: 100, sort: "name", status: "all" } }) });

  return (
    <div className="desk connections-settings">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Connections</h2>
          <p>Every outside service the system uses. Each kind works on its Simulated stand-in until a real service is connected; one connection per kind is in use at a time. Passwords and keys stay in the server's settings, and a connection names the setting that holds each one.</p>
        </div>
      </header>
      {kinds.isLoading && <p className="muted">Loading…</p>}
      {(kinds.data ?? []).map((k) => {
        const mine = (connections.data ?? []).filter((c) => c.kind === k.kind);
        // A tracker or map service can be connected now; using it on trips comes after v1 (#60), and the card says so.
        const soon = COMING_SOON.find((f) => f.kind === k.kind);
        return (
          <section key={k.kind} className="card kind-card">
            <div className="card-head">
              <div className="kind-title">
                <h3>{k.label}{soon && <> <ComingSoonTag /></>}</h3>
                <p className="muted">{k.description}</p>
                {soon && <p className="muted">{soon.description}</p>}
              </div>
              {creatable && <Button onClick={() => setEditing({ kind: k, connection: null })}>Add a connection</Button>}
            </div>
            <div className="card-body">
              <dl className="connection-facts">
                <dt>In use now</dt>
                <dd>{nowUsing(k)}{k.via !== "connection" && <span className="channel-why">{k.whenNone}</span>}</dd>
              </dl>
              {mine.length > 0 && (
                <div className="connection-list">
                  {mine.map((c) => (
                    <ConnectionCard key={c.id} connection={c} kind={k} writable={writable} onEdit={() => setEditing({ kind: k, connection: c })} />
                  ))}
                </div>
              )}
            </div>
          </section>
        );
      })}
      {editing && <ConnectionForm kind={editing.kind} connection={editing.connection} onClose={() => setEditing(null)} />}
    </div>
  );
}

function useRefresh() {
  const client = useQueryClient();
  return () => {
    for (const key of ["connections", "connection-kinds", "message-channels", "message-outbox", "rate-feed"]) void client.invalidateQueries({ queryKey: [key] });
  };
}

/** A setting's value as the form would show it. */
function shown(field: FieldSpec, value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (field.type === "boolean") return value ? "Yes" : "No";
  if (field.type === "choice") return field.choices?.find((c) => c.value === value)?.label ?? String(value);
  return String(value);
}

function ConnectionCard({ connection: c, kind, writable, onEdit }: { connection: Connection; kind: KindState; writable: boolean; onEdit: () => void }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const [to, setTo] = useState("");
  const provider = kind.providers.find((p) => p.key === c.provider);
  const message = MESSAGE_KINDS.includes(c.kind);
  const archived = c.status !== "active";

  const toggle = useMutation({
    mutationFn: () => api(`/connections/${c.id}`, { method: "PATCH", body: { version: c.version, enabled: !c.enabled } }),
    onSuccess: () => { toast(c.enabled ? `${c.name} switched off` : `${c.name} switched on`); refresh(); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; status: string; note?: string }>(`/connections/${c.id}/test`, { method: "POST", body: message ? { to: to.trim() } : {} }),
    onSuccess: (r) => {
      const text = message
        ? (r.ok ? (r.status === "simulated" ? `Simulated: ${r.note ?? "nothing was sent"}` : `Test message sent to ${to.trim()}`) : `Test failed: ${r.note ?? "unknown error"}`)
        : (r.ok ? r.note ?? "It works" : `Test failed: ${r.note ?? "unknown error"}`);
      toast(text, r.ok ? "ok" : "error");
      refresh();
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <article className="connection">
      <div className="connection-head">
        <div className="connection-name">
          <strong>{c.name}</strong>
          <span className="muted">{provider?.label ?? c.provider}</span>
          {provider?.simulated && <Status tone="info">Simulated</Status>}
        </div>
        {archived ? <Status tone="mute">Archived</Status> : c.enabled ? <Status tone="ok">In use</Status> : <Status tone="mute">Off</Status>}
      </div>
      <dl className="connection-facts">
        {(provider?.fields ?? []).map((f) => {
          const value = shown(f, c.settings?.[f.key]);
          return value === undefined ? null : <FieldFact key={f.key} label={f.label} value={value} />;
        })}
        {(provider?.secrets ?? []).map((s) => c.secrets?.[s.key] && (
          <SecretFact key={s.key} label={s.label} name={c.secrets[s.key]!} set={Boolean(c.secretsSet?.[s.key])} />
        ))}
        {c.webhookUrl && <><dt>Web address for calls</dt><dd className="mono-wrap">{c.webhookUrl}</dd></>}
        {c.webhookSecretEnv && <SecretFact label="Signing secret" name={c.webhookSecretEnv} set={Boolean(c.webhookSecretSet)} />}
        {c.lastTest && (
          <>
            <dt>Last test</dt>
            <dd>{stamp(c.lastTest.at)}{c.lastTest.to ? ` to ${c.lastTest.to}` : ""}: {c.lastTest.ok ? "worked" : "failed"}{c.lastTest.message ? `. ${c.lastTest.message}` : ""}</dd>
          </>
        )}
        {c.lastUsedAt && <><dt>Last used</dt><dd>{stamp(c.lastUsedAt)}</dd></>}
        {c.lastError && <><dt>Last error</dt><dd className="connection-error">{stamp(c.lastError.at)}: {c.lastError.message}</dd></>}
      </dl>
      {writable && !archived && (
        <div className="connection-actions">
          {message && (
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder={c.kind === "email" ? "you@company.com" : phonePlaceholder()} aria-label="Send a test message to" />
          )}
          <Button busy={test.isPending} disabled={message && !to.trim()} onClick={() => test.mutate()}>{message ? "Send a test message" : "Test connection"}</Button>
          <Button busy={toggle.isPending} onClick={() => toggle.mutate()}>{c.enabled ? "Switch off" : "Use this one"}</Button>
          <Button onClick={onEdit}>Edit</Button>
        </div>
      )}
    </article>
  );
}

const FieldFact = ({ label, value }: { label: string; value: string }) => <><dt>{label}</dt><dd>{value}</dd></>;
const SecretFact = ({ label, name, set }: { label: string; name: string; set: boolean }) => (
  <><dt>{label}</dt><dd><code>{name}</code> {set ? <Status tone="ok">Set on the server</Status> : <Status tone="bad">Missing on the server</Status>}</dd></>
);

type Values = Record<string, string | boolean>;

/** The form's starting values: the connection's, else each field's default. */
function valuesFrom(provider: ProviderInfo | undefined, c: Connection | null): Values {
  const out: Values = {};
  for (const f of provider?.fields ?? []) {
    const v = c?.provider === provider?.key ? c?.settings?.[f.key] : undefined;
    const start = v ?? f.default;
    out[f.key] = f.type === "boolean" ? Boolean(start) : start === undefined || start === null ? "" : String(start);
  }
  return out;
}

/** Settings as the server expects them: numbers as numbers, empty optional fields left out. */
function settingsFrom(provider: ProviderInfo, values: Values) {
  const out: Record<string, unknown> = {};
  for (const f of provider.fields) {
    const v = values[f.key];
    if (f.type === "boolean") { out[f.key] = Boolean(v); continue; }
    const text = String(v ?? "").trim();
    if (!text) continue;
    out[f.key] = f.type === "number" ? Number(text) : text;
  }
  return out;
}

function ConnectionForm({ kind, connection, onClose }: { kind: KindState; connection: Connection | null; onClose: () => void }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const first = connection?.provider ?? kind.providers.find((p) => !p.simulated && !p.comingSoon)?.key ?? kind.providers[0]?.key ?? "";
  const [providerKey, setProviderKey] = useState(first);
  const provider = kind.providers.find((p) => p.key === providerKey);
  const [name, setName] = useState(connection?.name ?? kind.providers.find((p) => p.key === first)?.label ?? "");
  const [code, setCode] = useState(connection?.code ?? "");
  const [values, setValues] = useState<Values>(() => valuesFrom(provider, connection));
  const [enabled, setEnabled] = useState(Boolean(connection?.enabled));
  const [target, setTarget] = useState("env");
  const [to, setTo] = useState("");
  const [tried, setTried] = useState<DraftResult | null>(null);
  const message = kind.kind === "email" || kind.kind === "sms" || kind.kind === "whatsapp";
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const err = (key: string) => errors[key]?.join(" ");

  const pick = (key: string) => {
    const next = kind.providers.find((p) => p.key === key);
    setProviderKey(key);
    setValues(valuesFrom(next, connection));
    setTried(null);
    if (!name.trim() || kind.providers.some((p) => p.label === name)) setName(next?.label ?? "");
  };

  const save = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Choose a service");
      // The server names each secret's setting from the code; a changed service keeps only what it uses.
      const kept = connection && connection.provider === provider.key ? connection.secrets : undefined;
      const body: Record<string, unknown> = {
        name: name.trim(), provider: provider.key, enabled,
        settings: settingsFrom(provider, values),
        ...(connection && !kept ? { secrets: null, webhookSecretEnv: null } : {}),
      };
      if (connection) body.version = connection.version;
      else Object.assign(body, { code: code.trim(), kind: kind.kind });
      return request(connection ? `/connections/${connection.id}` : "/connections", {
        method: connection ? "PATCH" : "POST", body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
      });
    },
    onSuccess: () => { toast(connection ? "Connection saved" : "Connection added"); refresh(); onClose(); },
    onError: (e: Error & { details?: unknown }) => {
      const details = e.details as Record<string, unknown> | undefined;
      const fields = (details?.fields ?? (details?.body as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? details) as Record<string, string[]> | undefined;
      setErrors(fields && typeof fields === "object" ? fields : {});
      toast(e.message, "error");
    },
  });

  return (
    <Drawer
      open
      title={connection ? `Edit ${connection.name}` : `New connection: ${kind.label}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button tone="primary" busy={save.isPending} disabled={Boolean(provider?.comingSoon)} onClick={() => save.mutate()}>Save</Button></>}
    >
      <fieldset className="form-group">
        <FieldGroup label="Service" hint={err("provider") ?? provider?.comingSoon ?? provider?.description} wide>
          {fitsAsButtons(kind.providers.map(providerName)) ? (
            <Segmented choice label="Service" value={providerKey} onChange={pick}
              options={kind.providers.map((p) => ({ value: p.key, label: providerName(p) }))} />
          ) : (
            <select className="input" value={providerKey} onChange={(e) => pick(e.target.value)} aria-label="Service">
              {kind.providers.map((p) => <option key={p.key} value={p.key}>{providerName(p)}</option>)}
            </select>
          )}
        </FieldGroup>
        <div className="grid-2">
          <Field label="Name" hint={err("name")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Code" hint={err("code") ?? "A short reference, e.g. SMTP or TRACKERS"}><input className="input" value={code} disabled={Boolean(connection)} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>
        </div>
        {(provider?.fields ?? []).length > 0 && (
          <div className="grid-2">
            {provider!.fields.map((f) => <SettingField key={`${provider!.key}-${f.key}`} field={f} value={values[f.key]} error={err(`settings.${f.key}`)} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />)}
          </div>
        )}
        {provider && !provider.comingSoon && <Guide steps={provider.guide ?? []} webhookUrl={connection?.webhookUrl} />}
        {provider && !provider.comingSoon && (provider.secrets.length > 0 || (provider.inbound && !provider.ownSignature)) && (
          <Keys kind={kind.kind} provider={provider} code={connection?.code ?? code} connectionId={connection && connection.provider === provider.key ? connection.id : undefined} target={target} onTarget={setTarget} />
        )}
        {provider && !provider.comingSoon && (
          <DraftTest kind={kind.kind} provider={provider} code={connection?.code ?? code} settings={() => settingsFrom(provider, values)}
            secrets={connection && connection.provider === provider.key ? connection.secrets : undefined}
            message={message} to={to} onTo={setTo} result={tried} onResult={setTried} />
        )}
        <SwitchField label="Use this connection" hint="Only one connection of this kind is in use at a time. To change service, switch the one in use off first." checked={enabled} onChange={setEnabled} />
      </fieldset>
    </Drawer>
  );
}

/** The provider's numbered steps to get each value, with links (#98). The webhook address is filled in once saved. */
function Guide({ steps, webhookUrl }: { steps: GuideStep[]; webhookUrl?: string }) {
  if (!steps.length) return null;
  return (
    <section className="connection-guide" aria-label="How to set it up">
      <h4>How to set it up</h4>
      <ol>
        {steps.map((step, i) => {
          const [before, after] = step.text.split("{webhookUrl}");
          return (
            <li key={i}>
              {before}
              {after !== undefined && (webhookUrl ? <code className="mono-wrap">{webhookUrl}</code> : <em>the web address shown here once the connection is saved</em>)}
              {after}
              {step.link && <> <a href={step.link} target="_blank" rel="noreferrer">Open <ExternalLink size={12} aria-hidden /></a></>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The connection's keys, which the app never holds (#98): each one's server setting, named from the code, whether
 * the server has it, and the commands to set it where the app runs, with <value> where the key goes.
 */
function Keys({ kind, provider, code, connectionId, target, onTarget }: { kind: string; provider: ProviderInfo; code: string; connectionId?: string; target: string; onTarget: (t: string) => void }) {
  const query = connectionId ? { connectionId, target } : { kind, provider: provider.key, code: code.trim() || "NEW", target };
  const setup = useQuery({ queryKey: ["connection-secret-setup", query], queryFn: () => api<SecretSetup>("/connection-secret-setup", { query }) });
  return (
    <section className="connection-keys" aria-label="Keys">
      <div className="connection-keys-head">
        <h4>Keys</h4>
        <select className="input" value={target} onChange={(e) => onTarget(e.target.value)} aria-label="Where the app runs">
          {SECRET_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <p className="muted">Keys are never typed into the app. Each one is a server setting with the name below; set it where the app runs, then test.</p>
      {setup.data && (
        <>
          <ul className="connection-key-names">
            {setup.data.names.map((n) => <li key={n.name}><code>{n.name}</code> {n.set ? <Status tone="ok">set on the server</Status> : <Status tone="wait">not set yet</Status>}</li>)}
          </ul>
          <ol className="connection-key-steps">
            {setup.data.steps.map((step, i) => <li key={i}>{step.text}{step.command && <pre className="connection-command">{step.command}</pre>}</li>)}
          </ol>
        </>
      )}
      {!connectionId && !code.trim() && <p className="muted">The names follow the code above: type it first.</p>}
    </section>
  );
}

/** Test before saving (#98): the values on the form as they are, so nothing is stored until it works. */
function DraftTest({ kind, provider, code, settings, secrets, message, to, onTo, result, onResult }: {
  kind: string; provider: ProviderInfo; code: string; settings: () => Record<string, unknown>; secrets?: Record<string, string>;
  message: boolean; to: string; onTo: (v: string) => void; result: DraftResult | null; onResult: (r: DraftResult | null) => void;
}) {
  const { toast } = useApp();
  const run = useMutation({
    mutationFn: () => api<DraftResult>("/connections/test-draft", { method: "POST", body: { kind, provider: provider.key, ...(code.trim() ? { code: code.trim() } : {}), settings: settings(), ...(secrets ? { secrets } : {}), ...(message ? { to: to.trim() } : {}) } }),
    onSuccess: onResult,
    onError: (e: Error) => toast(e.message, "error"),
  });
  return (
    <section className="connection-draft-test" aria-label="Test">
      <div className="connection-actions">
        {message && <input className="input" value={to} onChange={(e) => onTo(e.target.value)} placeholder={kind === "email" ? "you@company.com" : phonePlaceholder()} aria-label="Send a test message to" />}
        <Button busy={run.isPending} disabled={message && !to.trim()} onClick={() => run.mutate()}>{message ? "Send a test message" : "Test"}</Button>
      </div>
      {result && (
        <p className={result.ok ? "connection-test-ok" : "connection-error"} role="status">
          <Status tone={result.ok ? (result.simulated ? "info" : "ok") : "bad"}>{result.ok ? (result.simulated ? "Simulated" : "Connected") : "Not yet"}</Status> {result.message}
        </p>
      )}
    </section>
  );
}

/** One of a provider's settings, drawn from what the server says about it. */
export function SettingField({ field: f, value, error, onChange }: { field: FieldSpec; value: string | boolean | undefined; error?: string; onChange: (v: string | boolean) => void }) {
  const label = f.required ? f.label : `${f.label} (optional)`;
  if (f.type === "boolean") return <SwitchField label={f.label} hint={error ?? f.hint} checked={Boolean(value)} onChange={onChange} />;
  if (f.type === "choice" && f.choices) {
    return fitsAsButtons(f.choices.map((c) => c.label)) ? (
      <FieldGroup label={label} hint={error ?? f.hint}>
        <Segmented choice label={f.label} value={String(value ?? "")} onChange={onChange} options={f.choices.map((c) => ({ value: c.value, label: c.label }))} />
      </FieldGroup>
    ) : (
      <Field label={label} hint={error ?? f.hint}>
        <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {!f.required && <option value="">—</option>}
          {f.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Field>
    );
  }
  return (
    <Field label={label} hint={error ?? f.hint}>
      <input className="input" type={f.type === "number" ? "number" : "text"} min={f.min} max={f.max} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
