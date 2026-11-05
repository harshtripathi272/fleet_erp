import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, request } from "../api/client";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Field, FieldGroup, Segmented, Status, SwitchField } from "../ui/kit";
import { stamp } from "../ui/format";
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
interface ProviderInfo { key: string; label: string; description?: string; simulated: boolean; fields: FieldSpec[]; secrets: SecretSpec[]; inbound: boolean }
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
const providerName = (p: ProviderInfo) => (p.simulated && !/simulated/i.test(p.label) ? `${p.label} (Simulated)` : p.label);

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
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder={c.kind === "email" ? "you@company.com" : "+260…"} aria-label="Send a test message to" />
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
  const first = connection?.provider ?? kind.providers.find((p) => !p.simulated)?.key ?? kind.providers[0]?.key ?? "";
  const [providerKey, setProviderKey] = useState(first);
  const provider = kind.providers.find((p) => p.key === providerKey);
  const [name, setName] = useState(connection?.name ?? kind.providers.find((p) => p.key === first)?.label ?? "");
  const [code, setCode] = useState(connection?.code ?? "");
  const [values, setValues] = useState<Values>(() => valuesFrom(provider, connection));
  const [secrets, setSecrets] = useState<Record<string, string>>(() => ({ ...(connection?.secrets ?? {}) }));
  const [hookSecret, setHookSecret] = useState(connection?.webhookSecretEnv ?? "");
  const [enabled, setEnabled] = useState(Boolean(connection?.enabled));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const err = (key: string) => errors[key]?.join(" ");

  const pick = (key: string) => {
    const next = kind.providers.find((p) => p.key === key);
    setProviderKey(key);
    setValues(valuesFrom(next, connection));
    setSecrets(Object.fromEntries(Object.entries(connection?.secrets ?? {}).filter(([k]) => next?.secrets.some((s) => s.key === k))));
    if (!next?.inbound) setHookSecret("");
    if (!name.trim() || kind.providers.some((p) => p.label === name)) setName(next?.label ?? "");
  };

  const save = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Choose a service");
      const named = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, v.trim().toUpperCase()]).filter(([k, v]) => v && provider.secrets.some((s) => s.key === k)));
      const body: Record<string, unknown> = {
        name: name.trim(), provider: provider.key, enabled,
        settings: settingsFrom(provider, values),
        secrets: Object.keys(named).length ? named : connection ? null : undefined,
        webhookSecretEnv: hookSecret.trim() ? hookSecret.trim().toUpperCase() : connection ? null : undefined,
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
      footer={<><Button onClick={onClose}>Cancel</Button><Button tone="primary" busy={save.isPending} onClick={() => save.mutate()}>Save</Button></>}
    >
      <fieldset className="form-group">
        <FieldGroup label="Service" hint={err("provider") ?? provider?.description} wide>
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
        {(provider?.secrets ?? []).map((s) => (
          <Field key={s.key} label={`Server setting that holds the ${s.label.toLowerCase()}${s.required ? "" : " (if needed)"}`} wide
            hint={err(`secrets.${s.key}`) ?? <>{s.hint ? `${s.hint}. ` : ""}SMTP_PASS, RATE_FEED_API_KEY, or a name starting with CONNECTION_. Its value is set on the server or in Secret Manager, and never shown here.</>}>
            <input className="input" value={secrets[s.key] ?? ""} onChange={(e) => setSecrets((x) => ({ ...x, [s.key]: e.target.value.toUpperCase() }))} placeholder={`CONNECTION_${(provider?.key ?? "").toUpperCase().replace(/-/g, "_")}_${s.key.replace(/([A-Z])/g, "_$1").toUpperCase()}`} />
          </Field>
        ))}
        {provider?.inbound && (
          <Field label="Server setting that holds the signing secret" wide
            hint={err("webhookSecretEnv") ?? "The service signs each call with this secret, and unsigned calls are refused. The web address to give the service appears once the connection is saved."}>
            <input className="input" value={hookSecret} onChange={(e) => setHookSecret(e.target.value.toUpperCase())} placeholder="CONNECTION_TRACKER_SIGNING_SECRET" />
          </Field>
        )}
        <SwitchField label="Use this connection" hint="Only one connection of this kind is in use at a time. To change service, switch the one in use off first." checked={enabled} onChange={setEnabled} />
      </fieldset>
    </Drawer>
  );
}

/** One of a provider's settings, drawn from what the server says about it. */
function SettingField({ field: f, value, error, onChange }: { field: FieldSpec; value: string | boolean | undefined; error?: string; onChange: (v: string | boolean) => void }) {
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
