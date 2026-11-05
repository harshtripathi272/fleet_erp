import { FieldInput } from "../desks/usePlacement";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CloudOff, Download, LogOut, MapPin, Send } from "lucide-react";
import { api, ApiError } from "../api/client";
import { ACCEPT, downloadPdf } from "../api/files";
import { clearNotices, connectionLost, connectionWorks, enqueue, startOutbox, useOutbox } from "./outbox";
import { shrinkPhoto } from "./shrink";
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
  questions?: { key: string; label: string; type: string; required: boolean; options?: string[]; min?: number; max?: number; helpText?: string }[];
  driver: { id: string; name: string; code?: string };
  trip: null | {
    id: string; number: string; truck: string; trailer?: string; customer: string; product: string; dispatchedAt?: string;
    stops: Stop[]; next?: Kind | null; issued: { id: string; number: string; kind: string; text: string; at?: string }[]; documents: Doc[];
  };
  account: { balance: string; direction: "holds" | "owed" | "even"; settlements: { id: string; number: string; at: string }[] };
}
interface Msg { id: string; at: string; from: string; title?: string; text?: string; rows?: [string, string][]; upload?: Kind }

/**
 * The trip and messages, kept on the phone as well: with no signal the driver still sees the last ones,
 * never a blank page. A failed fetch with no answer at all means the connection is down.
 */
function useKept<T>(userId: string, name: string, path: string) {
  const key = `fleet.driver.${userId}.${name}`;
  return useQuery({
    queryKey: [`driver-${name}`],
    queryFn: async () => {
      try {
        const data = await api<T>(path);
        connectionWorks();
        try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* storage full: keep going */ }
        return data;
      } catch (error) {
        if (!(error instanceof ApiError)) connectionLost();
        throw error;
      }
    },
    initialData: () => {
      try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : undefined; } catch { return undefined; }
    },
    initialDataUpdatedAt: 0,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function DriverPortal({ me }: { me: Me }) {
  const home = useKept<Home>(me.id, "home", "/driver-app/home");
  const messages = useKept<Msg[]>(me.id, "messages", "/driver-app/messages");
  const client = useQueryClient();
  const outbox = useOutbox();
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Kind>("other");
  const [preparing, setPreparing] = useState(false);

  // Everything the driver sends goes through the outbox, which keeps it on the phone until the API has it.
  useEffect(() => {
    startOutbox(me.id, () => void Promise.all([client.invalidateQueries({ queryKey: ["driver-home"] }), client.invalidateQueries({ queryKey: ["driver-messages"] })]));
  }, [me.id, client]);
  // "Sent" and refusals show for a moment, then make way.
  useEffect(() => {
    if (!outbox.sent.length && !outbox.refused.length) return;
    const t = window.setTimeout(clearNotices, outbox.refused.length ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [outbox.sent.length, outbox.refused.length]);

  const pick = (kind: Kind) => { setPending(kind); file.current?.click(); };
  const upload = async (chosen: File | undefined) => {
    if (file.current) file.current.value = "";
    if (!chosen) return;
    setPreparing(true);
    try {
      const photo = await shrinkPhoto(chosen);
      await enqueue({ type: "send", kind: pending, file: photo.blob, fileName: photo.name, label: KIND_LABEL[pending] });
    } finally {
      setPreparing(false);
    }
  };
  const arrivalWaiting = (stopId: string) => outbox.items.some((i) => i.type === "arrive" && i.stopId === stopId);

  if (!home.data) {
    if (home.error) return <Shell me={me}><p className="drv-error" role="alert">{home.error instanceof ApiError ? home.error.message : "No connection, and nothing kept on this phone yet. Your trip shows as soon as the signal is back."}</p></Shell>;
    return <Shell me={me}><p className="muted">Loading your trip…</p></Shell>;
  }
  const h = home.data;
  const trip = h.trip;
  const nextStop = trip?.stops.find((s) => !s.arrivedAt);

  return (
    <Shell me={me}>
      <input ref={file} type="file" accept={ACCEPT} capture="environment" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      {!outbox.online && (
        <p className="drv-offline" role="status">
          <CloudOff size={18} /> No connection. What you send waits on this phone and goes when the signal is back.
        </p>
      )}
      {outbox.items.length > 0 && (
        <div className="drv-outbox" role="status">
          <strong>Waiting to send ({outbox.items.length})</strong>
          <ul>{outbox.items.map((i) => <li key={i.id}>{i.label}</li>)}</ul>
        </div>
      )}
      {outbox.sent.length > 0 && <p className="drv-ok" role="status">Sent: {outbox.sent.join(", ")}.</p>}
      {outbox.refused.map((r, i) => <p key={i} className="drv-error" role="alert">{r.label} wasn't accepted: {r.message}</p>)}

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
            <Button tone="primary" size="lg" busy={preparing} onClick={() => pick(trip.next!)}>
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
                {s === nextStop && trip.dispatchedAt && s.kind !== "start" && (arrivalWaiting(s.id)
                  ? <small className="drv-waiting">Arrival waiting to send</small>
                  : (
                    <Button size="sm" onClick={() => void enqueue({ type: "arrive", stopId: s.id, label: `Arrived at ${s.place}` })}>
                      <MapPin /> I've arrived
                    </Button>
                  ))}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="drv-card">
        <h3>Send a document</h3>
        <div className="drv-kinds">
          {KINDS.map(([kind, label]) => (
            <Button key={kind} disabled={preparing} onClick={() => pick(kind)}><Camera /> {label}</Button>
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

      {(h.questions?.length ?? 0) > 0 && <Questions questions={h.questions!} />}

      <Conversation
        messages={messages.data ?? []}
        waiting={outbox.items.filter((i) => i.type === "send" && i.note && !i.file).map((i) => ({ id: i.id, text: i.note!, at: i.at }))}
        onPick={pick}
        onSend={(text) => void enqueue({ type: "send", kind: "other", note: text, label: "Message" })}
      />

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
              {h.account.settlements.map((s) => <li key={s.id}><span>{s.number}</span><span className="muted">{stamp(s.at)}</span><StatementLink id={s.id} number={s.number} /></li>)}
            </ul>
          </>
        )}
      </section>
    </Shell>
  );
}

function Conversation({ messages, waiting, onPick, onSend }: { messages: Msg[]; waiting: { id: string; text: string; at: string }[]; onPick: (k: Kind) => void; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const last = `${messages.at(-1)?.id}-${waiting.length}`;
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
        {waiting.map((m) => (
          <div key={m.id} className="drv-msg mine drv-msg-waiting">
            <p>{m.text}</p>
            <small>Waiting to send</small>
          </div>
        ))}
      </div>
      <form className="drv-compose" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write to the office" aria-label="Message to the office" maxLength={1000} />
        <Button tone="primary" type="submit" aria-label="Send"><Send /></Button>
      </form>
    </section>
  );
}

/** What the company asks the driver about this trip and load. Answers wait on the phone like everything else it sends. */
function Questions({ questions }: { questions: NonNullable<Home["questions"]> }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const outbox = useOutbox();
  const sent = new Set(outbox.items.filter((i) => i.type === "fields").flatMap((i) => Object.keys(i.values ?? {})));
  const open = questions.filter((q) => !sent.has(q.key));
  if (!open.length) return null;
  const answered = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && v !== "" && open.some((q) => q.key === k)));
  return (
    <section className="drv-card">
      <h3>Questions from the office</h3>
      <div className="drv-defect">
        {open.map((q) => <FieldInput key={q.key} field={q} value={values[q.key]} onChange={(v) => setValues((old) => ({ ...old, [q.key]: v }))} />)}
        <Button disabled={!Object.keys(answered).length} onClick={() => void enqueue({ type: "fields", values: answered, label: "Answers for the office" })}>Send to the office</Button>
      </div>
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

/** A settlement's statement as a PDF the phone saves or opens: the same file the office prints. */
function StatementLink({ id, number }: { id: string; number: string }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const open = async () => {
    setState("busy");
    try {
      await downloadPdf(`/driver-app/settlements/${id}/statement.pdf`, `Statement ${number}.pdf`);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <button className="drv-link" onClick={() => void open()} disabled={state === "busy"}>
      <Download size={15} /> {state === "busy" ? "Getting it…" : state === "failed" ? "No signal. Try again" : "PDF"}
    </button>
  );
}
