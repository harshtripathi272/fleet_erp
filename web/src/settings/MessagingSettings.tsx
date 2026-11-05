import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, request } from "../api/client";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Empty, Status } from "../ui/kit";
import { stamp } from "../ui/format";
import "./settings.css";

/**
 * How this company's messages go out (#19): where each channel sends now, and the outbox of everything
 * sent or simulated. The connections themselves (SMTP, an SMS provider, WhatsApp) are set up and tested
 * in Masters → Connections (#59), with every other outside service.
 */

type Channel = "email" | "sms" | "whatsapp";
const CHANNEL_LABEL: Record<Channel, string> = { email: "E-mail", sms: "SMS", whatsapp: "WhatsApp" };

interface ChannelState {
  channel: Channel;
  label: string;
  via: "connection" | "server-settings" | "simulated";
  connectionName?: string;
  simulated?: string;
  provider?: string;
  providers: { key: string; label: string; simulated: boolean }[];
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

export default function MessagingSettings({ onOpenConnections }: { onOpenConnections?: () => void }) {
  const { me } = useApp();
  const writable = can(me, "connections", "update");

  const channels = useQuery({ queryKey: ["message-channels"], queryFn: () => api<ChannelState[]>("/message-channels") });

  return (
    <div className="desk messaging-settings">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Sending messages</h2>
          <p>How e-mail, SMS and WhatsApp go out, and everything sent.</p>
        </div>
        {onOpenConnections && <Button onClick={onOpenConnections}>Set up connections</Button>}
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
                      {c.via === "connection" && c.provider && <span className="channel-why">{c.provider}</span>}
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

      <Outbox writable={writable} />
    </div>
  );
}

function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["connections"] });
    void client.invalidateQueries({ queryKey: ["message-channels"] });
    void client.invalidateQueries({ queryKey: ["message-outbox"] });
  };
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
                    {/* A failed or skipped message says why on its row; the reason a message was simulated is the same for every row, so it is in Channels above and in the message itself. */}
                    {m.note && (m.status === "failed" || m.status === "skipped") && <div className="outbox-note">{m.note}</div>}
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
