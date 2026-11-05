import type { AppData } from "../domain/types";

export const clock = (data: AppData) => Date.now() + data.settings.clockOffsetMs;

/**
 * How the company writes dates, times and numbers (#72), from Company → Regional settings: what it chose, else
 * what its country implies, else neutral defaults. Set once the company loads; every figure on screen goes
 * through the formatters below. Nothing here assumes a country, a currency or a clock.
 */
export interface Regional {
  timeZone: string;
  dateFormat: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
  timeFormat: "24h" | "12h";
  decimalSeparator: string;
  thousandsSeparator: string;
  firstDayOfWeek: "monday" | "sunday" | "saturday";
  fiscalYearStartMonth: number;
  phoneCountryCode: string;
  unitSystem: "metric" | "imperial";
}
const NEUTRAL: Regional = {
  timeZone: "UTC", dateFormat: "DD/MM/YYYY", timeFormat: "24h", decimalSeparator: ".", thousandsSeparator: ",",
  firstDayOfWeek: "monday", fiscalYearStartMonth: 1, phoneCountryCode: "", unitSystem: "metric",
};
let regional: Regional = NEUTRAL;
export const setRegional = (next: Partial<Regional> | undefined) => { regional = { ...NEUTRAL, ...(next ?? {}) }; };
export const regionalSettings = () => regional;
/** "+255…" for a phone input, from the company's country; "+…" when it has none. */
export const phonePlaceholder = () => `${regional.phoneCountryCode || "+"}…`;

/** A number with the company's separators: 12,500.5 or 12.500,5 or 12 500,5. */
export function num(value: number | undefined | null, digits = 0, maxDigits = digits) {
  if (value == null || Number.isNaN(value)) return "—";
  const plain = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, maxDigits) }).format(value || 0);
  return plain.replace(/[,.]/g, (c) => (c === "," ? "\u0001" : "\u0002")).replace(/\u0001/g, regional.thousandsSeparator).replace(/\u0002/g, regional.decimalSeparator);
}

/** The company's base currency code, set when the company loads; every base-currency amount shows in it. */
let baseCode = "";
export const setBaseCurrencyCode = (code: string | undefined) => { baseCode = code ?? ""; };
export const baseCurrencyCode = () => baseCode;
/** The base currency's code, or what to do when the company has none yet. */
export const baseLabel = () => baseCode || "(set a base currency)";

/** Joins a figure and its unit, or a date's parts, so a line never breaks inside them ("12,500 TZS", "04/11 15:56"). */
const keep = (text: string) => text.replace(/ /g, "\u00a0");

/** An amount in the company's base currency. */
export const inBase = (value: number | undefined | null) => (value == null || Number.isNaN(value) ? "—" : keep(`${num(Math.round(value))} ${baseLabel()}`));
export const L = (value: number | undefined | null) => (value == null ? "—" : keep(`${num(Math.round(value))} L`));
export const km = (value: number | undefined | null) => (value == null ? "—" : keep(`${num(Math.round(value))} km`));
export const cash = (value: number, currency: string) => keep(`${num(value, 0, 2)} ${currency}`);

function parts(iso: string | number | Date) {
  let zone = regional.timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: p.year!, m: p.month!, d: p.day!, h: Number(p.hour) % 24, min: p.minute!, s: p.second! };
}
/** A full date in the company's format and time zone: 05/11/2026, 11/05/2026 or 2026-11-05. */
export function fullDate(iso: string | number | Date) {
  const { y, m, d } = parts(iso);
  return regional.dateFormat === "YYYY-MM-DD" ? `${y}-${m}-${d}` : regional.dateFormat === "MM/DD/YYYY" ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}
/** A calendar day stored as midnight UTC (an invoice's date, a due date), written as that day whatever the time zone. */
export function calendarDate(iso: string | number | Date) {
  const zone = regional.timeZone;
  regional = { ...regional, timeZone: "UTC" };
  try { return fullDate(iso); } finally { regional = { ...regional, timeZone: zone }; }
}
/** A date without its year, for short lines: 05/11, 11/05 or 11-05. */
export function shortDate(iso: string | number | Date) {
  const { m, d } = parts(iso);
  return regional.dateFormat === "YYYY-MM-DD" ? `${m}-${d}` : regional.dateFormat === "MM/DD/YYYY" ? `${m}/${d}` : `${d}/${m}`;
}
/** A time of day in the company's time zone: 15:56 or 3:56 pm. */
export function clockTime(iso: string | number | Date, seconds = false) {
  const { h, min, s } = parts(iso);
  const tail = seconds ? `:${s}` : "";
  return regional.timeFormat === "12h" ? `${h % 12 || 12}:${min}${tail} ${h < 12 ? "am" : "pm"}` : `${String(h).padStart(2, "0")}:${min}${tail}`;
}

export function day(iso?: string) {
  return iso ? keep(shortDate(iso)) : "—";
}
export function dayYear(iso?: string) {
  return iso ? keep(fullDate(iso)) : "—";
}
export function hm(iso?: string) {
  return iso ? keep(clockTime(iso)) : "—";
}
export function stamp(iso?: string) {
  return iso ? keep(`${shortDate(iso)} ${clockTime(iso)}`) : "—";
}
/** A date and time with the year. */
export function moment(iso?: string) {
  return iso ? keep(`${fullDate(iso)} ${clockTime(iso)}`) : "—";
}

/** "12 min", "3 h", "2 days" relative to the demo clock. */
export function ago(data: AppData, iso?: string) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((clock(data) - Date.parse(iso)) / 60000));
  if (minutes < 1) return keep("1 min");
  if (minutes < 60) return keep(`${minutes} min`);
  const hours = Math.round(minutes / 60);
  if (hours < 36) return keep(`${hours} h`);
  return keep(`${Math.round(hours / 24)} days`);
}

export function hoursText(hours: number) {
  if (hours < 1) return keep(`${Math.round(hours * 60)} min`);
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return keep(m ? `${h} h ${m} min` : `${h} h`);
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
