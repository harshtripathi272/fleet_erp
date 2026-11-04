import type { Rec } from "../api/adapter";

/** The address the audit log opens at. Here, not in AuditLog.tsx, so the desks can check it without loading Masters. */
export const AUDIT_VIEW = "audit-log";
export const wantsAuditLog = () => new URLSearchParams(location.search).get("view") === AUDIT_VIEW;

/** How a change reads, the same on a record's History tab and in the audit log. */

/** Bookkeeping the server fills in itself, and changes from nothing to nothing, are left out of history. */
const BOOKKEEPING = new Set(["createdBy", "updatedBy", "archivedBy", "archivedAt", "version"]);
const empty = (v: unknown) => v === undefined || v === null || v === "" || (typeof v === "object" && Object.keys(v as object).length === 0);
export const shown = (c: Rec) => !BOOKKEEPING.has(String(c.path)) && !(empty(c.from) && empty(c.to));
/** A key or a stored value in sentence case: "mobile_money" → "Mobile money", "homeBranchId" → "Home branch". Field names come from the server (`label` in /meta/masters); this is for values and anything without one. */
/** Words with their own spelling, wherever they appear in a value or key. */
const SPELLED: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "E-mail", "e-mail": "E-mail", gps: "GPS", id: "ID", vin: "VIN", url: "URL", pdf: "PDF", api: "API", smtp: "SMTP", pod: "POD" };
const spell = (text: string) => text.split(" ").map((w, i) => {
  const known = SPELLED[w.toLowerCase()];
  if (!known) return w;
  return i === 0 || known !== "E-mail" ? known : "e-mail";
}).join(" ");
export const label = (key: string) => spell(key.replace(/Id(s)?$/, "$1").replace(/Minor$/, "").replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).trim().replace(/^./, (c) => c.toUpperCase()));
/** "Levels" → "Level", "Entries" → "Entry": one of a list of repeating items. */
export const singular = (w: string) => (/ies$/.test(w) ? `${w.slice(0, -3)}y` : /(ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
/** A stored choice as the master names it ("trip.loaded" → "A truck is loaded"), or as words made from the value. */
export const choiceName = (def: Rec | undefined, path: string, value: string) =>
  String(((def?.fields as Rec[] | undefined)?.find((f) => f.path === path)?.choiceLabels as Rec | undefined)?.[value] ?? label(value));
/** A field's name as the server gives it, falling back to its key. */
export const fieldTitle = (def: Rec, path: string, key = path.split(".").pop() ?? path) =>
  String((def.fields as Rec[] | undefined)?.find((f) => f.path === path)?.label ?? label(key));
/** A changed field's name: the master's own label when the master is known. */
export const fieldName = (path: string, def?: Rec) => (def ? fieldTitle(def, path) : label(path.split(".").pop() ?? path));
/** A value as a person reads it: dates as dates, a link to another record as such, long values cut. */
export const short = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "string" && /^[0-9a-f]{24}$/.test(v)) return "a linked record";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    return midnight ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string" && /^[0-9a-f]{24}$/.test(x))) return v.length === 1 ? "1 linked record" : `${v.length} linked records`;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  // An object reads as its parts, never as raw JSON with ids in it.
  const s = v && typeof v === "object" && !Array.isArray(v)
    ? Object.entries(v as Rec).filter(([, x]) => !empty(x)).map(([k, x]) => `${label(k)}: ${short(x)}`).join(", ")
    : typeof v === "string" ? v : Array.isArray(v) ? v.map(short).join(", ") : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s || "—";
};
