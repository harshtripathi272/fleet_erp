import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, LogOut, MapPin, Send } from "lucide-react";
import { api, ApiError } from "../api/client";
import { ACCEPT, uploadFile } from "../api/files";
import { signOut, type Me } from "../api/session";
import { DocThumb } from "../docs/DocThumb";
import { Wordmark } from "../ui/brand";
import { Button } from "../ui/kit";
import { stamp } from "../ui/format";

/**
 * The driver web app (issue #5): a driver signed in on their own phone sees only their own trip,
 * documents, messages and account, through /driver-app/*. Photos go to file storage first.
 */

type Kind = "loading" | "delivery" | "expense" | "fuel" | "other";
const KINDS: [Kind, string][] = [["loading", "Loading invoice"], ["delivery", "Delivery note"], ["expense", "Receipt"], ["fuel", "Fuel slip"], ["other", "Other document"]];
const KIND_LABEL = Object.fromEntries(KINDS) as Record<Kind, string>;
const STOP_LABEL: Record<string, string> = { start: "Start", load: "Loading", via: "Stop", border: "Border", offload: "Offloading", end: "End" };

interface Stop { id: string; kind: string; place: string; legKm?: number; arrivedAt?: string; arrivedVia?: string }
interface Doc { id: string; kind: Kind; status: string; at: string; note?: string; returnReason?: string; simulated?: boolean; file?: { fileId?: string; name?: string; mime?: string; sampleId?: string } }
interface Home {
  driver: { id: string; name: string; code?: string };
  trip: null | {
    id: string; number: string; truck: string; trailer?: string; customer: string; product: string; dispatchedAt?: string;
    stops: Stop[]; next?: Kind | null; issued: { id: string; number: string; kind: string; text: string; at?: string }[]; documents: Doc[];
  };
  account: { balance: string; direction: "holds" | "owed" | "even"; settlements: { id: string; number: string; at: string }[] };
}
interface Msg { id: string; at: string; from: string; title?: string; text?: string; rows?: [string, string][]; upload?: Kind }

const useHome = () => useQuery({ queryKey: ["driver-home"], queryFn: () => api<Home>("/driver-app/home"), refetchInterval: 10_000 });
const useMessages = () => useQuery({ queryKey: ["driver-messages"], queryFn: () => api<Msg[]>("/driver-app/messages"), refetchInterval: 10_000 });

export function DriverPortal({ me }: { me: Me }) {
  const home = useHome();
  const messages = useMessages();
  const client = useQueryClient();
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Kind>("other");

  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["driver-home"] }), client.invalidateQueries({ queryKey: ["driver-messages"] })]);
  const attempt = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await work();
      setNotice({ text: done });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof ApiError ? error.message : "That didn't go through. Check your connection and try again.", bad: true });
    } finally {
      setBusy(null);
    }
  };
  const pick = (kind: Kind) => { setPending(kind); file.current?.click(); };
  const upload = (chosen: File | undefined) => {
    if (!chosen) return;
    void attempt("upload", async () => {
      const stored = await uploadFile(chosen);
      await api("/driver-app/send", { method: "POST", body: { kind: pending, fileId: stored.id } });
    }, `${KIND_LABEL[pending]} sent to the office.`);
    if (file.current) file.current.value = "";
  };

  if (home.isLoading) return <Shell me={me}><p className="muted">Loading your trip…</p></Shell>;
  if (home.error) return <Shell me={me}><p className="drv-error" role="alert">{(home.error as Error).message}</p></Shell>;
  const h = home.data!;
  const trip = h.trip;
  const nextStop = trip?.stops.find((s) => !s.arrivedAt);

  return (
    <Shell me={me}>
      <input ref={file} type="file" accept={ACCEPT} capture="environment" hidden onChange={(e) => upload(e.target.files?.[0])} />
      {notice && <p className={notice.bad ? "drv-error" : "drv-ok"} role="status">{notice.text}</p>}

      {!trip && (
        <section className="drv-card">
          <h2>No trip right now</h2>
          <p className="muted">When the office plans your next trip it shows here.</p>
        </section>
      )}

      {trip && (
        <section className="drv-card">
          <div className="drv-trip-head">
            <span className="mono">{trip.number}</span>
            <span className="muted">{trip.dispatchedAt ? "On the road" : "Planned"}</span>
          </div>
          <h2>{(trip.stops.find((s) => s.kind === "load") ?? trip.stops[0])?.place} to {([...trip.stops].reverse().find((s) => s.kind === "offload") ?? trip.stops.at(-1))?.place}</h2>
          <dl className="drv-facts">
            <div><dt>Truck</dt><dd>{trip.truck}{trip.trailer ? ` · ${trip.trailer}` : ""}</dd></div>
            <div><dt>Customer</dt><dd>{trip.customer}</dd></div>
            {trip.product && <div><dt>Cargo</dt><dd>{trip.product}</dd></div>}
          </dl>
          {trip.next && (
            <Button tone="primary" size="lg" busy={busy === "upload"} onClick={() => pick(trip.next!)}>
              <Camera /> Send the {KIND_LABEL[trip.next].toLowerCase()}
            </Button>
          )}
        </section>
      )}

      {trip && (
        <section className="drv-card">
          <h3>Stops</h3>
          <ol className="drv-stops">
            {trip.stops.map((s) => (
              <li key={s.id} className={s.arrivedAt ? "drv-done" : s === nextStop ? "drv-next" : ""}>
                <span className="drv-stop-dot" aria-hidden />
                <span>
                  <strong>{s.place}</strong>
                  <small>
                    {STOP_LABEL[s.kind] ?? s.kind}
                    {s.legKm ? ` · ${Math.round(s.legKm).toLocaleString("en-GB")} km` : ""}
                    {s.arrivedAt ? ` · arrived ${stamp(s.arrivedAt)}${s.arrivedVia === "simulator" ? " (simulated)" : ""}` : ""}
                  </small>
                </span>
                {s === nextStop && trip.dispatchedAt && s.kind !== "start" && (
                  <Button size="sm" busy={busy === s.id} onClick={() => void attempt(s.id, () => api(`/driver-app/stops/${s.id}/arrive`, { method: "POST" }), `Arrival at ${s.place} recorded.`)}>
                    <MapPin /> I've arrived
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="drv-card">
        <h3>Send a document</h3>
        <div className="drv-kinds">
          {KINDS.map(([kind, label]) => (
            <Button key={kind} disabled={busy === "upload"} onClick={() => pick(kind)}><Camera /> {label}</Button>
          ))}
        </div>
        {trip && trip.documents.some((d) => d.file) && (
          <ul className="drv-docs">
            {/* Messages without a file are in the conversation below. */}
            {trip.documents.filter((d) => d.file).map((d) => (
              <li key={d.id}>
                <DocThumb doc={{ file: d.file ? { name: d.file.name ?? "", mime: d.file.mime ?? "", fileId: d.file.fileId, sampleId: d.file.sampleId } : undefined }} className="drv-thumb" />
                <span>
                  <strong>{KIND_LABEL[d.kind] ?? d.kind}{d.simulated ? " (simulated)" : ""}</strong>
                  <small>{d.status === "returned" ? `Sent back: ${d.returnReason ?? "please send it again"}` : d.status === "recorded" ? "Accepted" : `Sent ${stamp(d.at)}, waiting for the office`}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Conversation messages={messages.data ?? []} onPick={pick} onSend={(text) => attempt("message", () => api("/driver-app/send", { method: "POST", body: { kind: "other", note: text } }), "Message sent.")} busy={busy === "message"} />

      <section className="drv-card">
        <h3>Money</h3>
        <p className="drv-balance">
          {h.account.direction === "holds" ? <>You hold <strong>{h.account.balance}</strong> of company money.</>
            : h.account.direction === "owed" ? <>The company owes you <strong>{h.account.balance}</strong>.</>
            : <>Your account is clear.</>}
        </p>
        {trip && trip.issued.length > 0 && (
          <ul className="drv-list">
            {trip.issued.map((r) => <li key={r.id}><span>{r.kind === "fuel" ? "Fuel" : "Cash"} · {r.number}</span><strong>{r.text}</strong></li>)}
          </ul>
        )}
        {h.account.settlements.length > 0 && (
          <>
            <h4>Settlements</h4>
            <ul className="drv-list">
              {h.account.settlements.map((s) => <li key={s.id}><span>{s.number}</span><span className="muted">{stamp(s.at)}</span></li>)}
            </ul>
          </>
        )}
      </section>
    </Shell>
  );
}

function Conversation({ messages, onPick, onSend, busy }: { messages: Msg[]; onPick: (k: Kind) => void; onSend: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const last = messages.at(-1)?.id;
  // Open at the newest message, and follow new ones as they arrive.
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight }); }, [last]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <section className="drv-card">
      <h3>Messages</h3>
      <div className="drv-thread" ref={thread}>
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
        {messages.slice(-20).map((m) => (
          <div key={m.id} className={`drv-msg ${m.from === "me" ? "mine" : ""}`}>
            {m.title && <strong>{m.title}</strong>}
            {m.text && <p>{m.text}</p>}
            {m.rows && m.rows.length > 0 && <dl>{m.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
            {m.upload && <Button size="sm" onClick={() => onPick(m.upload!)}><Camera /> Send the {KIND_LABEL[m.upload]?.toLowerCase() ?? "document"}</Button>}
            <small>{stamp(m.at)}</small>
          </div>
        ))}
      </div>
      <form className="drv-compose" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write to the office" aria-label="Message to the office" maxLength={1000} />
        <Button tone="primary" type="submit" busy={busy} aria-label="Send"><Send /></Button>
      </form>
    </section>
  );
}

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  return (
    <div className="drv">
      <header className="drv-top">
        <Wordmark />
        <button className="drv-out" onClick={() => void signOut()}><LogOut size={16} /> Sign out</button>
      </header>
      <main className="drv-main">
        <p className="drv-hello">{me.name}</p>
        {children}
      </main>
    </div>
  );
}
