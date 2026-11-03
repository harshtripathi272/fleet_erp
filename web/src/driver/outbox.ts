import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";
import { uploadFile } from "../api/files";

/**
 * What the driver sends, kept on the phone (IndexedDB) until the API has it, so a weak signal loses
 * nothing. Items go in the order they were made. Each carries its own id, sent as the Idempotency-Key,
 * so an item the API received but whose answer was lost is not recorded twice when it is sent again.
 */

export type DocKind = "loading" | "delivery" | "expense" | "fuel" | "other";

export interface OutboxItem {
  id: string;
  /** The signed-in driver's user id: items wait for their own driver if someone else signs in. */
  userId: string;
  at: string;
  /** What the driver sees in "Waiting to send". */
  label: string;
  type: "send" | "arrive";
  kind?: DocKind;
  note?: string;
  stopId?: string;
  file?: Blob;
  fileName?: string;
  /** Set once the photo is stored, so a retry sends only the small part that is left. */
  fileId?: string;
}

export interface OutboxState {
  items: OutboxItem[];
  /** Labels sent since the last look, for a short "Sent" line. */
  sent: string[];
  /** Items the API refused (not a connection problem): shown once and dropped, since sending again won't help. */
  refused: { label: string; message: string }[];
  sending: boolean;
  online: boolean;
}

const DB = "marichi-driver";
const STORE = "outbox";
const RETRY_MS = 20_000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = work(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let state: OutboxState = { items: [], sent: [], refused: [], sending: false, online: navigator.onLine };
const listeners = new Set<() => void>();
const set = (patch: Partial<OutboxState>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
};
let userId = "";
let onSent: (() => void) | undefined;

async function load() {
  const all = (await tx("readonly", (s) => s.getAll())) as OutboxItem[];
  set({ items: all.filter((i) => i.userId === userId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) });
}

/**
 * A failure worth trying again later: no connection, a server problem, the same item still being handled,
 * or a signed-out session (the items wait for the driver to sign in again).
 */
const retryable = (error: unknown) =>
  !(error instanceof ApiError) || error.status >= 500 || [401, 408, 429].includes(error.status) || error.code === "IDEMPOTENCY_IN_PROGRESS";

async function deliver(item: OutboxItem) {
  const headers = { "Idempotency-Key": item.id };
  if (item.type === "arrive") {
    await api(`/driver-app/stops/${item.stopId}/arrive`, { method: "POST", headers });
    return;
  }
  let fileId = item.fileId;
  if (item.file && !fileId) {
    const stored = await uploadFile(item.file, `${item.id}-file`, item.fileName ?? "photo.jpg");
    fileId = stored.id;
    await tx("readwrite", (s) => s.put({ ...item, fileId }));
  }
  await api("/driver-app/send", { method: "POST", headers, body: { kind: item.kind, fileId, note: item.note } });
}

/** Sends what is waiting, oldest first; stops at the first item that can't go yet, to keep the order. */
export async function flush() {
  if (state.sending || !userId) return;
  set({ sending: true });
  let delivered = false;
  try {
    for (const item of [...state.items]) {
      try {
        await deliver(item);
        await tx("readwrite", (s) => s.delete(item.id));
        set({ items: state.items.filter((i) => i.id !== item.id), sent: [...state.sent, item.label], online: true });
        delivered = true;
      } catch (error) {
        if (retryable(error)) {
          // No answer at all means no connection, even when the phone thinks it has one.
          if (!(error instanceof ApiError)) set({ online: false });
          break;
        }
        await tx("readwrite", (s) => s.delete(item.id));
        set({ items: state.items.filter((i) => i.id !== item.id), refused: [...state.refused, { label: item.label, message: (error as Error).message }] });
      }
    }
  } finally {
    set({ sending: false });
    if (delivered) onSent?.();
  }
}

/** Puts something in the outbox and tries to send it at once. */
export async function enqueue(item: Omit<OutboxItem, "id" | "userId" | "at">) {
  const full: OutboxItem = { ...item, id: crypto.randomUUID(), userId, at: new Date().toISOString() };
  await tx("readwrite", (s) => s.put(full));
  set({ items: [...state.items, full] });
  void flush();
}

export const clearNotices = () => set({ sent: [], refused: [] });

let started = "";
/** Starts the outbox for the signed-in driver: loads what was waiting and keeps trying while the page is open. */
export function startOutbox(forUser: string, afterSend: () => void) {
  onSent = afterSend;
  if (started === forUser) return;
  started = userId = forUser;
  void load().then(flush);
  window.addEventListener("online", () => {
    set({ online: true });
    void flush();
  });
  window.addEventListener("offline", () => set({ online: false }));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void flush());
  window.setInterval(() => state.items.length && void flush(), RETRY_MS);
}

/** Marks the connection as back (a fetch succeeded), and sends anything waiting. */
export function connectionWorks() {
  if (!state.online) set({ online: true });
  if (state.items.length) void flush();
}
export const connectionLost = () => state.online && set({ online: false });

export function useOutbox(): OutboxState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
