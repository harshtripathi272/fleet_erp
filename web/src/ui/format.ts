import type { AppData } from "../domain/types";

export const clock = (data: AppData) => Date.now() + data.settings.clockOffsetMs;

export const num = (value: number | undefined | null, digits = 0) =>
  value == null || Number.isNaN(value)
    ? "—"
    : value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** The company's base currency code, set when the company loads; every base-currency amount shows in it. */
let baseCode = "ZMW";
export const setBaseCurrencyCode = (code: string | undefined) => { if (code) baseCode = code; };
export const baseCurrencyCode = () => baseCode;

/** An amount in the company's base currency (named after the first client's kwacha). */
export const zmw = (value: number | undefined | null) => (value == null ? "—" : `${num(Math.round(value))} ${baseCode}`);
export const L = (value: number | undefined | null) => (value == null ? "—" : `${num(Math.round(value))} L`);
export const km = (value: number | undefined | null) => (value == null ? "—" : `${num(Math.round(value))} km`);
export const cash = (value: number, currency: string) =>
  `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${currency}`;

export function day(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
export function dayYear(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
export function hm(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
export function stamp(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "12 min", "3 h", "2 days" relative to the demo clock. */
export function ago(data: AppData, iso?: string) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((clock(data) - Date.parse(iso)) / 60000));
  if (minutes < 1) return "1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function hoursText(hours: number) {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Local date-time value for <input type="datetime-local">. */
export function localInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localDate(iso: string) {
  return localInput(iso).slice(0, 10);
}
export const fromLocalInput = (value: string) => new Date(value).toISOString();

export const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
