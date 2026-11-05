import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  BadgeCheck,
  Camera,
  CheckCheck,
  ChevronRight,
  CornerUpLeft,
  ExternalLink,
  Mic,
  Paperclip,
  Phone,
  Search,
  SendHorizontal,
  Smile,
  Video,
} from "lucide-react";
import { useApp } from "../store";
import { useMay } from "../api/session";
import type { Action, Attachment, DocKind, Message, MsgButton } from "../domain/types";
import { useDocImage } from "../docs/useDocImage";
import { FileText } from "lucide-react";
import { clock, hm, regionalSettings, fullDate } from "../ui/format";
import { AttachSheet } from "./Attach";

export interface ThreadInfo {
  key: string;
  name: string;
  status: string;
  avatar: ReactNode;
}

export const unreadIn = (messages: Message[], reads: Record<string, string>, thread: string) =>
  messages.filter((m) => m.thread === thread && m.from !== "me" && m.at > (reads[thread] ?? "")).length;

export function BotAvatar({ size = 38 }: { size?: number }) {
  return (
    <span className="wa-avatar bot" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size * 0.62} height={size * 0.62} aria-hidden>
        <path d="M7 23c3-6 6-8 9-8s5-2 7-7" fill="none" stroke="#f3e1b8" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="23" cy="8" r="2.4" fill="#fff" />
      </svg>
    </span>
  );
}

export function WhatsApp({
  threads,
  driverId,
  tripId,
  initial,
}: {
  threads: ThreadInfo[];
  driverId?: string;
  tripId?: string;
  initial?: string;
}) {
  const { data } = useApp();
  const [open, setOpen] = useState<string | null>(initial ?? (threads.length === 1 ? threads[0].key : null));
  const thread = threads.find((t) => t.key === open);
  return (
    <div className="wa">
      <AnimatePresence initial={false} mode="popLayout">
        {thread ? (
          <motion.div
            key="chat"
            className="wa-screen"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
          >
            <Chat thread={thread} onBack={threads.length > 1 ? () => setOpen(null) : undefined} driverId={driverId} tripId={tripId} />
          </motion.div>
        ) : (
          <motion.div key="list" className="wa-screen" initial={{ x: "-25%", opacity: 0.6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "-25%", opacity: 0.6 }} transition={{ type: "spring", stiffness: 420, damping: 40 }}>
            <div className="wa-list-head">
              <span className="wa-list-title">Chats</span>
              <span className="wa-list-icons">
                <Camera size={20} />
              </span>
            </div>
            <div className="wa-search">
              <Search size={15} /> Ask Meta AI or Search
            </div>
            <div className="wa-list">
              {threads.map((t) => {
                const last = data.messages.filter((m) => m.thread === t.key).at(-1);
                const unread = unreadIn(data.messages, data.reads, t.key);
                return (
                  <button key={t.key} className="wa-row" onClick={() => setOpen(t.key)}>
                    {t.avatar}
                    <span className="wa-row-main">
                      <span className="wa-row-top">
                        <strong>{t.name}</strong>
                        <span className={unread ? "unread" : ""}>{last ? hm(last.at) : ""}</span>
                      </span>
                      <span className="wa-row-bottom">
                        <span className="wa-preview">
                          {last?.from === "me" && <CheckCheck size={15} className="tick read" />}
                          {last ? last.title ?? (last.text || (last.attachment ? "Photo" : "")) : t.status}
                        </span>
                        {unread > 0 && <b>{unread}</b>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function dayLabel(iso: string, now: number) {
  const d = new Date(iso);
  const today = new Date(now);
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString("en", { weekday: "long", timeZone: regionalSettings().timeZone });
  return fullDate(d);
}

type Prompt = { action: Action; label: string; chips: string[] };

function needsReason(action?: Action): Prompt | undefined {
  if (!action) return undefined;
  if (action.type === "request.decide" && !action.approve && !action.note)
    return { action, label: "Why reject it?", chips: ["Above the budget", "Wrong amount", "Not needed yet"] };
  if (action.type === "doc.return" && !action.reason)
    return { action, label: "What should the driver fix?", chips: ["Photo is blurred", "Wrong document", "Figures don't match"] };
  if (action.type === "expense.decide" && !action.approve && !action.reason)
    return { action, label: "Why reject it?", chips: ["No valid receipt", "Personal expense"] };
  return undefined;
}

function withReason(action: Action, reason: string): Action {
  if (action.type === "request.decide") return { ...action, note: reason };
  if (action.type === "doc.return") return { ...action, reason };
  if (action.type === "expense.decide") return { ...action, reason };
  return action;
}

function Chat({ thread, onBack, driverId, tripId }: { thread: ThreadInfo; onBack?: () => void; driverId?: string; tripId?: string }) {
  const { data, run, nav } = useApp();
  const may = useMay();
  const messages = useMemo(() => data.messages.filter((m) => m.thread === thread.key), [data.messages, thread.key]);
  const [draft, setDraft] = useState("");
  const [typingUntil, setTypingUntil] = useState(0);
  const [hideAfter, setHideAfter] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [attach, setAttach] = useState<DocKind | "any" | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const now = clock(data);
  const typing = Date.now() < typingUntil;
  const shown = typing && hideAfter ? messages.filter((m) => !(m.from === "bot" && m.at > hideAfter)) : messages;

  useEffect(() => {
    if (unreadIn(data.messages, data.reads, thread.key) > 0) run({ type: "thread.read", thread: thread.key });
  }, [data.messages, data.reads, thread.key, run]);
  useEffect(() => {
    if (!typingUntil) return;
    const t = window.setTimeout(() => setTypingUntil(0), Math.max(0, typingUntil - Date.now()));
    return () => window.clearTimeout(t);
  }, [typingUntil]);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (first.current) {
      first.current = false;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown.length, typing, prompt]);

  const expectReply = () => {
    setHideAfter(new Date(clock(data) - 1000).toISOString());
    setTypingUntil(Date.now() + 1100);
  };
  const press = (button: MsgButton) => {
    if (button.attach) return setAttach(button.attach);
    if (button.nav) return nav(button.nav);
    if (!button.action) return;
    const need = needsReason(button.action);
    if (need) return setPrompt(need);
    run(button.action, button.action.type === "request.decide" && button.action.approve ? "Approved from WhatsApp." : undefined);
  };
  const send = async () => {
    if (!draft.trim()) return;
    if (await run({ type: "chat.send", thread: thread.key, text: draft })) {
      setDraft("");
      if (!thread.key.startsWith("customer:")) expectReply();
    }
  };

  let lastDay = "";
  return (
    <div className="wa-chat">
      <header className="wa-chat-head">
        {onBack && (
          <button className="wa-back" onClick={onBack} aria-label="Back">
            <ArrowLeft size={22} />
          </button>
        )}
        {thread.avatar}
        <span className="wa-chat-name">
          <strong>
            {thread.name} {thread.key.startsWith("customer:") ? null : <BadgeCheck size={14} className="verified" />}
          </strong>
          <span>{typing ? "typing…" : thread.status}</span>
        </span>
        <span className="wa-chat-icons">
          <Video size={20} />
          <Phone size={18} />
        </span>
      </header>
      <div className="wa-body" ref={scroller}>
        <div className="wa-encrypt">Messages are end-to-end encrypted. Tap to learn more.</div>
        {shown.map((m) => {
          const label = dayLabel(m.at, now);
          const sep = label !== lastDay ? (lastDay = label) : null;
          return (
            <div key={m.id} className="wa-item">
              {sep && <div className="wa-day">{sep}</div>}
              <Bubble message={m} onPress={press} />
            </div>
          );
        })}
        <AnimatePresence>
          {typing && (
            <motion.div className="wa-typing" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <i />
              <i />
              <i />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {prompt && (
          <motion.div className="wa-sheet" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", stiffness: 420, damping: 38 }}>
            <strong>{prompt.label}</strong>
            <div className="wa-chips">
              {prompt.chips.map((c) => (
                <button
                  key={c}
                  onClick={async () => {
                    if (await run(withReason(prompt.action, c), "Sent from WhatsApp.")) setPrompt(null);
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            <button className="wa-sheet-cancel" onClick={() => setPrompt(null)}>
              Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {may("chat.send") && (
      <footer className="wa-compose">
        <div className="wa-input">
          <Smile size={21} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Message"
            aria-label="Message"
          />
          {driverId && (
            <button className="wa-icon" onClick={() => setAttach("any")} aria-label="Attach">
              <Paperclip size={20} />
            </button>
          )}
          {driverId && !draft && (
            <button className="wa-icon" onClick={() => setAttach("any")} aria-label="Camera">
              <Camera size={20} />
            </button>
          )}
        </div>
        <button className="wa-send" onClick={send} aria-label={draft ? "Send" : "Voice message"}>
          {draft ? <SendHorizontal size={19} /> : <Mic size={20} />}
        </button>
      </footer>
      )}
      {driverId && (
        <AttachSheet
          open={attach !== null}
          kind={attach === "any" ? undefined : attach ?? undefined}
          driverId={driverId}
          tripId={tripId}
          onClose={() => setAttach(null)}
          onSent={() => {
            setAttach(null);
            expectReply();
          }}
        />
      )}
    </div>
  );
}

function Bubble({ message, onPress }: { message: Message; onPress: (b: MsgButton) => void }) {
  const { data, setOverlay } = useApp();
  const may = useMay();
  const mine = message.from === "me";
  // A button that acts shows only to someone who may take the action; approvals follow the policy.
  const allowed = (b: MsgButton) => {
    const a = b.action;
    if (!a) return true;
    if (a.type === "request.decide") return Boolean(data.requests.find((r) => r.id === a.id)?.mayDecide);
    if (a.type === "expense.decide") return Boolean(data.expenses.find((e) => e.id === a.id)?.mayDecide);
    return may(a.type);
  };
  const buttons = (message.buttons ?? []).filter(allowed);
  const { src: image, pdf } = useDocImage(message.attachment ? { file: message.attachment, tripId: findTrip(data, message), read: findRead(data, message) } : undefined);
  return (
    <motion.div
      className={`wa-bubble-wrap ${mine ? "out" : "in"}`}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 34 }}
    >
      <div className={`wa-bubble ${mine ? "out" : "in"} ${buttons.length && !message.resolved ? "has-buttons" : ""}`}>
        {image && !pdf && (
          <button className="wa-image" onClick={() => setOverlay({ document: { kind: "photo", id: `msg:${message.id}` } })}>
            <img src={image} alt={message.attachment?.name ?? "Photo"} />
          </button>
        )}
        {image && pdf && (
          <a className="wa-file" href={image} target="_blank" rel="noreferrer">
            <FileText size={18} /> {message.attachment?.name ?? "Document.pdf"}
          </a>
        )}
        {message.title && <strong className="wa-title">{message.title}</strong>}
        {message.text && <p>{message.text}</p>}
        {message.rows && message.rows.length > 0 && (
          <dl className="wa-rows">
            {message.rows.map(([k, v], i) => (
              <div key={i}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {message.resolved && (
          <span className="wa-resolved">
            <CheckCheck size={13} /> {message.resolved}
          </span>
        )}
        <span className="wa-meta">
          {hm(message.at)}
          {mine && <CheckCheck size={15} className="tick read" />}
        </span>
      </div>
      {!message.resolved && buttons.length > 0 && (
        <div className="wa-buttons">
          {buttons.map((b, i) => (
            <button key={i} className={b.tone ?? ""} onClick={() => onPress(b)}>
              {b.nav ? <ExternalLink size={14} /> : b.attach ? <Paperclip size={14} /> : <CornerUpLeft size={14} />}
              {b.label}
              {b.nav && <ChevronRight size={14} className="wa-chev" />}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

const sameFile = (a: Attachment, b: Attachment) => (a.fileId ? a.fileId === b.fileId : a.sampleId === b.sampleId && a.name === b.name);
function findTrip(data: ReturnType<typeof useApp>["data"], m: Message) {
  const doc = data.docs.find((d) => d.file && m.attachment && sameFile(d.file, m.attachment));
  return doc?.tripId ?? m.attachment?.sampleId?.split(":")[1];
}
function findRead(data: ReturnType<typeof useApp>["data"], m: Message) {
  const doc = data.docs.find((d) => d.file && m.attachment && sameFile(d.file, m.attachment));
  return doc?.read;
}
