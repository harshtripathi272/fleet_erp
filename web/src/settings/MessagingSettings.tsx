import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, request } from "../api/client";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Empty, Field, Status } from "../ui/kit";
import { stamp } from "../ui/format";
import "./settings.css";

/**
 * How this company's messages go out (#19): each channel's connection (SMTP for e-mail, an SMS
 * provider, WhatsApp), a test send for each, and the outbox of everything sent or simulated.
 * Passwords and keys never appear here: a connection names the server setting that holds them.
 */

type Channel = "email" | "sms" | "whatsapp";
const CHANNEL_LABEL: Record<Channel, string> = { email: "E-mail", sms: "SMS", whatsapp: "WhatsApp" };

interface ChannelState {
  channel: Channel;
  label: string;
  via: "connection" | "server-settings" | "simulated";
  connectionName?: string;
  simulated?: string;
  providers: { key: string; label: string; simulated: boolean }[];
}

interface Connection {
  id: string;
  version: number;
  code: string;
  name: string;
  channel: Channel;
  provider: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  senderId?: string;
  secretEnv?: string;
  secretSet?: boolean;
  lastTest?: { at: string; ok: boolean; to?: string; error?: string };
  lastError?: { at: string; message: string };
  lastSentAt?: string;
}

interface Outbound {
  id: string;
  event: string;
  channel: Channel;
  channelLabel: string;
  to?: string;
  toName?: string;
  subject?: string;
  body: string;
  status: "queued" | "sending" | "sent" | "failed" | "simulated" | "skipped";
  note?: string;
  attempts: number;
  nextAttemptAt?: string;
  resendable: boolean;
  at: string;
}

const STATUS_TONE: Record<Outbound["status"], "ok" | "wait" | "bad" | "info" | "mute"> = {
  sent: "ok", queued: "wait", sending: "wait", failed: "bad", simulated: "info", skipped: "mute",
};
const STATUS_LABEL: Record<Outbound["status"], string> = {
  sent: "Sent", queued: "Waiting", sending: "Sending", failed: "Failed", simulated: "Simulated", skipped: "Not sent",
};

export default function MessagingSettings() {
  const { me } = useApp();
  const writable = can(me, "message-connections", "update");
  const creatable = can(me, "message-connections", "create");
  const [editing, setEditing] = useState<Connection | "new" | null>(null);

  const channels = useQuery({ queryKey: ["message-channels"], queryFn: () => api<ChannelState[]>("/message-channels") });
  const connections = useQuery({
    queryKey: ["message-connections"],
    queryFn: () => api<Connection[]>("/message-connections", { query: { limit: 100, sort: "name" } }),
  });

  return (
    <div className="desk messaging-settings">
      <header className="masters-head">
        <h2>Sending messages</h2>
        {creatable && <Button tone="primary" onClick={() => setEditing("new")}>New connection</Button>}
      </header>

      <section className="card">
        <div className="card-head"><h3>Channels</h3></div>
        <div className="card-body">
          {channels.isLoading ? <p className="muted">Loading…</p> : (
            <table className="table">
              <thead><tr><th>Channel</th><th>Sends through</th></tr></thead>
              <tbody>
                {(channels.data ?? []).map((c) => (
                  <tr key={c.channel}>
                    <td>{c.label}</td>
                    <td>
                      {c.via === "connection" && <Status tone="ok">{c.connectionName}</Status>}
                      {c.via === "server-settings" && <Status tone="ok">The server's e-mail settings</Status>}
                      {c.via === "simulated" && <><Status tone="info">Simulated</Status> <span className="channel-why">{c.simulated}</span></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Connections</h3></div>
        <div className="card-body">
          {connections.isLoading && <p className="muted">Loading…</p>}
          {connections.data && !connections.data.length && (
            <Empty title="No connections yet">
              <p className="muted">Until one is added, e-mail uses the server's e-mail settings, if it has them, and phone messages are simulated.</p>
            </Empty>
          )}
          <div className="connection-list">
            {(connections.data ?? []).map((c) => (
              <ConnectionCard key={c.id} connection={c} writable={writable} onEdit={() => setEditing(c)} />
            ))}
          </div>
        </div>
      </section>

      <Outbox writable={writable} />

      {editing && (
        <ConnectionForm
          connection={editing === "new" ? null : editing}
          providers={channels.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["message-connections"] });
    void client.invalidateQueries({ queryKey: ["message-channels"] });
    void client.invalidateQueries({ queryKey: ["message-outbox"] });
  };
}

function ConnectionCard({ connection: c, writable, onEdit }: { connection: Connection; writable: boolean; onEdit: () => void }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const [to, setTo] = useState("");

  const toggle = useMutation({
    mutationFn: () => api(`/message-connections/${c.id}`, { method: "PATCH", body: { version: c.version, enabled: !c.enabled } }),
    onSuccess: () => { toast(c.enabled ? `${c.name} switched off` : `${c.name} switched on`); refresh(); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; status: string; note?: string }>(`/message-connections/${c.id}/test`, { method: "POST", body: { to: to.trim() } }),
    onSuccess: (r) => {
      toast(r.ok ? (r.status === "simulated" ? `Simulated: ${r.note ?? "nothing was sent"}` : `Test message sent to ${to.trim()}`) : `Test failed: ${r.note ?? "unknown error"}`, r.ok ? "ok" : "error");
      refresh();
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <article className="connection">
      <div className="connection-head">
        <div>
          <strong>{c.name}</strong>
          <span className="muted"> · {CHANNEL_LABEL[c.channel]} · {c.provider}</span>
        </div>
        {c.enabled ? <Status tone="ok">On</Status> : <Status tone="mute">Off</Status>}
      </div>
      <dl className="connection-facts">
        {c.host && <><dt>Server</dt><dd>{c.host}{c.port ? `:${c.port}` : ""}{c.secure ? " (TLS)" : ""}</dd></>}
        {c.from && <><dt>From</dt><dd>{c.from}</dd></>}
        {c.user && <><dt>{c.channel === "email" ? "User" : "Account"}</dt><dd>{c.user}</dd></>}
        {c.senderId && <><dt>Sender</dt><dd>{c.senderId}</dd></>}
        {c.secretEnv && (
          <>
            <dt>Password setting</dt>
            <dd>{c.secretEnv} {c.secretSet ? <Status tone="ok">set on the server</Status> : <Status tone="bad">missing on the server</Status>}</dd>
          </>
        )}
        {c.lastTest && (
          <>
            <dt>Last test</dt>
            <dd>{stamp(c.lastTest.at)} to {c.lastTest.to}: {c.lastTest.ok ? "worked" : c.lastTest.error ?? "failed"}</dd>
          </>
        )}
        {c.lastError && <><dt>Last error</dt><dd className="connection-error">{stamp(c.lastError.at)}: {c.lastError.message}</dd></>}
      </dl>
      {writable && (
        <div className="connection-actions">
          <input
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={c.channel === "email" ? "you@company.com" : "+260…"}
            aria-label="Send a test message to"
          />
          <Button busy={test.isPending} disabled={!to.trim()} onClick={() => test.mutate()}>Send a test message</Button>
          <Button busy={toggle.isPending} onClick={() => toggle.mutate()}>{c.enabled ? "Switch off" : "Switch on"}</Button>
          <Button onClick={onEdit}>Edit</Button>
        </div>
      )}
    </article>
  );
}

type Form = { code: string; name: string; channel: Channel; provider: string; enabled: boolean; host: string; port: string; secure: boolean; user: string; from: string; senderId: string; secretEnv: string };

const formFrom = (c: Connection | null): Form => ({
  code: c?.code ?? "", name: c?.name ?? "", channel: c?.channel ?? "email", provider: c?.provider ?? "smtp", enabled: Boolean(c?.enabled),
  host: c?.host ?? "", port: c?.port ? String(c.port) : "", secure: Boolean(c?.secure), user: c?.user ?? "", from: c?.from ?? "",
  senderId: c?.senderId ?? "", secretEnv: c?.secretEnv ?? "",
});

/** Only the fields a channel uses; blank ones are left out (new) or cleared (edit). */
function bodyFrom(form: Form, existing: Connection | null) {
  const value = (v: string) => (v.trim() ? v.trim() : existing ? null : undefined);
  const base: Record<string, unknown> = { name: form.name.trim(), provider: form.provider, enabled: form.enabled };
  if (!existing) Object.assign(base, { code: form.code.trim(), channel: form.channel });
  else base.version = existing.version;
  if (form.channel === "email") {
    Object.assign(base, { host: value(form.host), port: form.port ? Number(form.port) : existing ? null : undefined, secure: form.secure, user: value(form.user), from: value(form.from), secretEnv: value(form.secretEnv) });
  } else if (form.channel === "sms") {
    Object.assign(base, { user: value(form.user), senderId: value(form.senderId), secretEnv: value(form.secretEnv) });
  }
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined));
}

function ConnectionForm({ connection, providers, onClose }: { connection: Connection | null; providers: ChannelState[]; onClose: () => void }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const [form, setForm] = useState<Form>(() => formFrom(connection));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const options = providers.find((p) => p.channel === form.channel)?.providers ?? [];

  const save = useMutation({
    mutationFn: () => request(connection ? `/message-connections/${connection.id}` : "/message-connections", { method: connection ? "PATCH" : "POST", body: bodyFrom(form, connection) }),
    onSuccess: () => { toast(connection ? "Connection saved" : "Connection added"); refresh(); onClose(); },
    onError: (e: Error & { details?: { fields?: Record<string, string[]> } | Record<string, string[]> }) => {
      const details = e.details as Record<string, unknown> | undefined;
      const fields = (details?.fields ?? (details?.body as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? details) as Record<string, string[]> | undefined;
      setErrors(fields && typeof fields === "object" ? fields : {});
      toast(e.message, "error");
    },
  });
  const hint = (key: string) => errors[key]?.join(" ");

  return (
    <Drawer
      open
      title={connection ? `Edit ${connection.name}` : "New connection"}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button tone="primary" busy={save.isPending} onClick={() => save.mutate()}>Save</Button></>}
    >
      <fieldset className="form-group">
        <div className="grid-2">
          <Field label="Channel">
            <select
              className="input"
              value={form.channel}
              disabled={Boolean(connection)}
              onChange={(e) => {
                const channel = e.target.value as Channel;
                setForm((f) => ({ ...f, channel, provider: providers.find((p) => p.channel === channel)?.providers[0]?.key ?? "" }));
              }}
            >
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </select>
          </Field>
          <Field label="Provider" hint={hint("provider")}>
            <select className="input" value={form.provider} onChange={(e) => set("provider", e.target.value)}>
              {options.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Name" hint={hint("name")}><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Code" hint={hint("code")}><input className="input" value={form.code} disabled={Boolean(connection)} onChange={(e) => set("code", e.target.value)} /></Field>
        </div>
        {form.channel === "email" && (
          <div className="grid-2">
            <Field label="SMTP server" hint={hint("host")}><input className="input" value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.gmail.com" /></Field>
            <Field label="Port" hint={hint("port")}><input className="input" type="number" value={form.port} onChange={(e) => set("port", e.target.value)} placeholder="587" /></Field>
            <Field label="User" hint={hint("user")}><input className="input" value={form.user} onChange={(e) => set("user", e.target.value)} /></Field>
            <Field label="From" hint={hint("from")}><input className="input" value={form.from} onChange={(e) => set("from", e.target.value)} placeholder="Marichi Fleet <fleet@company.com>" /></Field>
          </div>
        )}
        {form.channel === "sms" && (
          <div className="grid-2">
            <Field label="Account" hint={hint("user")}><input className="input" value={form.user} onChange={(e) => set("user", e.target.value)} /></Field>
            <Field label="Sender name or number" hint={hint("senderId")}><input className="input" value={form.senderId} onChange={(e) => set("senderId", e.target.value)} /></Field>
          </div>
        )}
        {form.channel !== "whatsapp" && (
          <Field
            label="Server setting that holds the password or key"
            hint={hint("secretEnv") ?? "SMTP_PASS, or a name starting with MESSAGING_. Set its value on the server or in Secret Manager; it is never shown here."}
            wide
          >
            <input className="input" value={form.secretEnv} onChange={(e) => set("secretEnv", e.target.value.toUpperCase())} placeholder="MESSAGING_SMTP_PASS" />
          </Field>
        )}
        {form.channel === "email" && (
          <label className="check-line"><input type="checkbox" checked={form.secure} onChange={(e) => set("secure", e.target.checked)} /> Connect with TLS from the start (usually port 465)</label>
        )}
        {form.channel === "whatsapp" && <p className="muted">WhatsApp is not connected yet: its messages are simulated, not sent.</p>}
        <label className="check-line"><input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Switched on (one per channel)</label>
      </fieldset>
    </Drawer>
  );
}

function Outbox({ writable }: { writable: boolean }) {
  const { toast } = useApp();
  const refresh = useRefresh();
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Outbound | null>(null);
  const list = useQuery({
    queryKey: ["message-outbox", channel, status, page],
    queryFn: () => request<Outbound[]>("/message-outbox", { query: { channel, status, page, limit: 25 } }),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api<Outbound>(`/message-outbox/${id}/resend`, { method: "POST" }),
    onSuccess: (m) => { toast(m.status === "sent" ? "Sent again" : `${STATUS_LABEL[m.status]}: ${m.note ?? ""}`, m.status === "failed" ? "error" : "ok"); refresh(); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const meta = list.data?.meta;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Outbox</h3>
        <div className="outbox-filters">
          <select className="input" value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }} aria-label="Channel">
            <option value="">Every channel</option>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </select>
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
            <option value="">Every status</option>
            {(Object.keys(STATUS_LABEL) as Outbound["status"][]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      <div className="card-body">
        {list.isLoading && <p className="muted">Loading…</p>}
        {list.data && !list.data.data.length && <Empty title="Nothing sent yet" />}
        {list.data && list.data.data.length > 0 && (
          <table className="table">
            <thead><tr><th>When</th><th>Channel</th><th>To</th><th>Message</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.data.map((m) => (
                <tr key={m.id}>
                  <td>{stamp(m.at)}</td>
                  <td>{m.channelLabel}</td>
                  <td>{m.toName}{m.to && <div className="muted">{m.to}</div>}</td>
                  <td><button type="button" className="link-btn" onClick={() => setOpen(m)}>{m.subject ?? m.body.slice(0, 60)}</button><div className="muted">{m.event}</div></td>
                  <td>
                    <Status tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Status>
                    {m.note && <div className="muted outbox-note">{m.note}</div>}
                    {m.status === "queued" && m.nextAttemptAt && <div className="muted">Next try {stamp(m.nextAttemptAt)}</div>}
                  </td>
                  <td>{writable && m.resendable && <Button size="sm" busy={resend.isPending && resend.variables === m.id} onClick={() => resend.mutate(m.id)}>Send again</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {meta && meta.totalPages > 1 && (
          <div className="outbox-pages">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</Button>
            <span className="muted">Page {meta.page} of {meta.totalPages}</span>
            <Button size="sm" disabled={!meta.hasNextPage} onClick={() => setPage((p) => p + 1)}>Older</Button>
          </div>
        )}
      </div>
      {open && (
        <Drawer open title={open.subject ?? `${open.channelLabel} message`} onClose={() => setOpen(null)}>
          <dl className="connection-facts">
            <dt>To</dt><dd>{open.toName} {open.to}</dd>
            <dt>Event</dt><dd>{open.event}</dd>
            <dt>Status</dt><dd>{STATUS_LABEL[open.status]}{open.note ? `: ${open.note}` : ""}</dd>
            <dt>Attempts</dt><dd>{open.attempts}</dd>
          </dl>
          <pre className="outbox-body">{open.body}</pre>
        </Drawer>
      )}
    </section>
  );
}
