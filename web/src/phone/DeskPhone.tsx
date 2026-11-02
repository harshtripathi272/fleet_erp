import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "../store";
import type { Desk, Message } from "../domain/types";
import { Avatar } from "../ui/kit";
import { Device } from "./Device";
import { BotAvatar, unreadIn, WhatsApp } from "./WhatsApp";
import type { ThreadInfo } from "./WhatsApp";

export function deskThreads(data: ReturnType<typeof useApp>["data"], role: Desk): ThreadInfo[] {
  const threads: ThreadInfo[] = [{ key: role, name: "Marichi Fleet", status: "Business account", avatar: <BotAvatar /> }];
  if (role === "operations")
    for (const c of data.customers)
      if (data.messages.some((m) => m.thread === `customer:${c.id}`))
        threads.push({ key: `customer:${c.id}`, name: `${c.contact} · ${c.name}`, status: "online", avatar: <Avatar name={c.contact} size={38} /> });
  return threads;
}

/** The desk phone rises from the corner, tilts into place and stays out of the way. */
export function DeskPhone() {
  const { data, role, overlay, setOverlay } = useApp();
  const threads = useMemo(() => deskThreads(data, role as Desk), [data, role]);
  const close = () => setOverlay({ ...overlay, phone: false });
  useEffect(() => {
    if (!overlay.phone) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return createPortal(
    <AnimatePresence>
      {overlay.phone && (
        <div className="phone-layer">
          <motion.div className="phone-scrim" onClick={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.div
            className="phone-float"
            initial={{ y: "115%", rotateX: 28, rotateZ: -9, scale: 0.9 }}
            animate={{ y: 0, rotateX: 0, rotateZ: -1.5, scale: 1 }}
            exit={{ y: "115%", rotateX: 22, rotateZ: -6, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 210, damping: 24, mass: 0.9 }}
          >
            <Device onHome={close}>
              <WhatsApp threads={threads} initial={threads.length === 1 ? threads[0].key : undefined} />
            </Device>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** A notification banner for new messages while the phone is down. */
export function MessageBanner() {
  const { data, role, overlay, setOverlay } = useApp();
  const mine = (m: Message) => m.thread === role && m.from === "bot";
  const lastSeen = useRef<string | null>(null);
  const [shown, setShown] = useState<Message | null>(null);
  useEffect(() => {
    const latest = data.messages.filter(mine).at(-1);
    if (!latest) return;
    if (lastSeen.current === null) {
      lastSeen.current = latest.id;
      return;
    }
    if (latest.id !== lastSeen.current) {
      lastSeen.current = latest.id;
      if (!overlay.phone && latest.at > (data.reads[role] ?? "")) setShown(latest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.messages]);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(null), 5200);
    return () => window.clearTimeout(t);
  }, [shown]);
  const unread = unreadIn(data.messages, data.reads, role);
  return createPortal(
    <AnimatePresence>
      {shown && !overlay.phone && (
        <motion.button
          className="banner"
          initial={{ y: -24, opacity: 0, scale: 0.96 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: -16, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 30 }}
          onClick={() => {
            setShown(null);
            setOverlay({ ...overlay, phone: true });
          }}
        >
          <span className="banner-app" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="#fff" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Z" />
              <path fill="#1faa53" d="M9.2 7.3c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-1 .9-1 2.3s1 2.7 1.1 2.9 2 3.1 4.9 4.2c2.4.9 2.9.8 3.4.7.5 0 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3l-1.7-.8c-.3-.1-.5-.1-.7.1l-.8 1c-.1.2-.3.2-.6.1a7 7 0 0 1-3.5-3c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.5l-.8-2Z" />
            </svg>
          </span>
          <span className="banner-text">
            <span className="banner-top">
              <strong>Marichi Fleet</strong>
              <span>now</span>
            </span>
            <b>{shown.title ?? "New message"}</b>
            <span className="banner-body">{shown.text}</span>
          </span>
          {unread > 1 && <span className="banner-more">+{unread - 1}</span>}
        </motion.button>
      )}
    </AnimatePresence>,
    document.body,
  );
}
