import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { useAreaList } from "../api/areas";
import { Button, Field, Segmented, SettingRow, SettingsSection, Status, Switch } from "../ui/kit";
import { COUNTRIES, CURRENCIES, countryOf } from "./countries";
import { FileDrop, useSetUp, withValue } from "./context";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
const NUMBER_STYLES = [
  { value: ".,", label: "12,500.50" },
  { value: ",.", label: "12.500,50" },
  { value: ", ", label: "12 500,50" },
  { value: ". ", label: "12 500.50" },
  { value: ".'", label: "12'500.50" },
];
const IMAGE_TYPES = "image/png,image/jpeg,image/webp";
/** Colours that read well behind white text, as a quick start. The picker takes any other. */
const SWATCHES = ["#1d4d3f", "#14406b", "#3f2f6e", "#6d2436", "#8a3a14", "#27323a"];

/** A short name for servers and the package's file name, from the company's name. */
export const shortNameOf = (name: string) => {
  // 24 at most, so it fits every platform's limits: Google allows 30 for a service account named fleet-<this>.
  const key = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return /^[a-z]/.test(key) ? key : key ? `co-${key}`.slice(0, 24) : "";
};

/** A new company's file, before anything is entered. */
export function blankFile(owner: { name?: string; email: string }, purpose = "real"): Rec {
  return {
    format: 1, purpose,
    company: {}, regional: {}, brand: { files: {} }, roles: [], staff: [],
    owner: { email: owner.email, ...(owner.name ? { name: owner.name } : {}) },
    selfSignUp: false,
    // Live rates from the start: they need no account, and can be changed or switched off on the Region step.
    connections: [{ code: "RATES", name: "ExchangeRate-API (free, no key)", kind: "rates", provider: "open-er-api", enabled: true, settings: {}, secrets: {} }],
    data: { sample: purpose === "demo" ? "full" : "none", files: [] },
    deploy: { target: "compose" },
  };
}

/* ---------- Start ---------- */

export function StartStep({ hasCompany }: { hasCompany: boolean }) {
  const { file, replace, info, me, go } = useSetUp();
  const opener = useRef<HTMLInputElement>(null);
  const [openError, setOpenError] = useState("");
  const purpose = String(file.purpose ?? "real");
  const pickPurpose = (next: string) => {
    let out = withValue(file, "purpose", next);
    // Only moves the default on: a choice already made for the data stays.
    if (!file.data?.files?.length) out = withValue(out, "data.sample", next === "demo" ? "full" : "none");
    if (next === "demo") {
      out = withValue(out, "areas", ["masters", "trips", "finance", "tracking", "driver-app", "maintenance", "parts", "tyres", "billing"]);
      // The sample operation is set in Zambia, so a demonstration starts there unless a country is already chosen.
      if (!file.regional?.country) {
        const zm = countryOf("ZM")!;
        out = { ...out, regional: { country: zm.code, baseCurrency: zm.currency, timezone: zm.timezone, dateFormat: zm.dateFormat, fiscalYearStartMonth: zm.fiscalYearStartMonth, style: zm.style } };
      }
    }
    replace(out);
  };
  const start = (from: "blank" | "here") => replace(from === "here"
    ? { ...info.file, purpose, data: { sample: file.data?.sample ?? "none", files: [] }, owner: { email: me.email, name: me.name } }
    : blankFile(me, purpose));
  const openFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    try {
      replace(JSON.parse(await chosen.text()));
      setOpenError("");
      go("company");
    } catch {
      setOpenError(`${chosen.name} isn't a company file.`);
    }
  };
  return (
    <div className="su-stack">
      <section className="su-choose" role="radiogroup" aria-label="What are you setting up?">
        <Choice on={purpose === "demo"} onPick={() => pickPurpose("demo")} title="A demonstration" text="To show someone how it works, or to try it yourself. Comes with made-up trucks, drivers and trips, every area switched on, and messages simulated. It can be cleared and started again." />
        <Choice on={purpose === "real"} onPick={() => pickPurpose("real")} title="A real company" text="A company's own copy for its real work, on its own address. Starts empty, ready for its spreadsheets. People are invited by e-mail if it has an e-mail server, or given passwords if it doesn't." />
      </section>
      <SettingsSection title="Start from">
        {(hasCompany || file.company?.legalName) && (
          <SettingRow title="A clean page" description="Clears what's filled in here. Each step shows what most companies choose.">
            <Button onClick={() => start("blank")}>Start clean</Button>
          </SettingRow>
        )}
        {hasCompany && (
          <SettingRow title="This copy's settings" description={`Fill every step with what ${String(info.file.company?.tradingName ?? info.file.company?.legalName ?? "this copy")} uses now, and change what's different.`}>
            <Button onClick={() => start("here")}>Use this copy's</Button>
          </SettingRow>
        )}
        <SettingRow title="A company file" description={openError || "A company set up before, saved as a file. Its logos and spreadsheets are added again."}>
          <input ref={opener} type="file" accept="application/json,.json" hidden aria-label="Company file" onChange={(e) => { void openFile(e.target.files?.[0]); e.target.value = ""; }} />
          <Button onClick={() => opener.current?.click()}>Open a file</Button>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

function Choice({ on, onPick, title, text }: { on: boolean; onPick: () => void; title: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`su-choice ${on ? "on" : ""}`} onClick={onPick}>
      <span className="su-choice-head"><strong>{title}</strong>{on && <Check size={17} aria-hidden />}</span>
      <span className="su-choice-text">{text}</span>
    </button>
  );
}

/* ---------- Company ---------- */

export function CompanyStep() {
  const { file, set, replace, err } = useSetUp();
  const c = (file.company ?? {}) as Rec;
  const a = (c.address ?? {}) as Rec;
  // The short name follows the company's name until someone changes it.
  const followsName = !c.key || c.key === shortNameOf(String(c.tradingName || c.legalName || ""));
  const setName = (path: "legalName" | "tradingName", value: string) => {
    let next = withValue(file, `company.${path}`, value);
    if (followsName) next = withValue(next, "company.key", shortNameOf(String(next.company.tradingName || next.company.legalName || "")));
    replace(next);
  };
  const setAddress = (key: string, value: string) => {
    const next = { ...a, [key]: value || undefined };
    set("company.address", Object.values(next).some(Boolean) ? next : undefined);
  };
  return (
    <div className="su-stack">
      <SettingsSection title="Names" description="The legal name goes on trip sheets, statements and invoices. The trading name is what people call the company.">
        <div className="su-pad grid-2">
          <Field label="Legal name *" hint={err("company.legalName")}><input className="input" autoFocus value={String(c.legalName ?? "")} onChange={(e) => setName("legalName", e.target.value)} placeholder="Acme Haulage Limited" /></Field>
          <Field label="Trading name" hint={err("company.tradingName") ?? "Leave empty if it's the same."}><input className="input" value={String(c.tradingName ?? "")} onChange={(e) => setName("tradingName", e.target.value)} placeholder="Acme Haulage" /></Field>
          <Field label="Short name *" hint={err("company.key") ?? "Used for its servers, storage and the package's file name. Made from the name; change it if you like."}>
            <input className="input su-mono" value={String(c.key ?? "")} onChange={(e) => set("company.key", e.target.value.toLowerCase())} placeholder="acme-haulage" />
          </Field>
        </div>
      </SettingsSection>
      <SettingsSection title="Registration" description="Printed on invoices and statements where the law asks for them. Both can wait.">
        <div className="su-pad grid-2">
          <Field label="Registration number" hint={err("company.registrationNumber")}><input className="input" value={String(c.registrationNumber ?? "")} onChange={(e) => set("company.registrationNumber", e.target.value)} /></Field>
          <Field label="Tax ID" hint={err("company.taxId")}><input className="input" value={String(c.taxId ?? "")} onChange={(e) => set("company.taxId", e.target.value)} /></Field>
        </div>
      </SettingsSection>
      <SettingsSection title="How to reach the company" description="Shown on documents, and on e-mails as who to reply to.">
        <div className="su-pad grid-2">
          <Field label="E-mail" hint={err("company.email")}><input className="input" type="email" value={String(c.email ?? "")} onChange={(e) => set("company.email", e.target.value.trim())} placeholder="office@acme.example" /></Field>
          <Field label="Phone" hint={err("company.phone") ?? "With the country code, e.g. +260 97 123 4567."}><input className="input" value={String(c.phone ?? "")} onChange={(e) => set("company.phone", e.target.value.replace(/[\s()-]/g, ""))} placeholder="+260971234567" /></Field>
          <Field label="Website" hint={err("company.website")} wide><input className="input" value={String(c.website ?? "")} onChange={(e) => set("company.website", e.target.value.trim())} placeholder="https://acme.example" /></Field>
          <Field label="Address" hint={err("company.address")} wide><input className="input" value={String(a.line1 ?? "")} onChange={(e) => setAddress("line1", e.target.value)} placeholder="Plot 12, Great East Road" /></Field>
          <Field label="Address, second line"><input className="input" value={String(a.line2 ?? "")} onChange={(e) => setAddress("line2", e.target.value)} /></Field>
          <Field label="City"><input className="input" value={String(a.city ?? "")} onChange={(e) => setAddress("city", e.target.value)} /></Field>
          <Field label="Postal code"><input className="input" value={String(a.postalCode ?? "")} onChange={(e) => setAddress("postalCode", e.target.value)} /></Field>
        </div>
      </SettingsSection>
    </div>
  );
}

/* ---------- Region ---------- */

/** "7 Nov" as this company would write it, to show the settings doing their job. */
function sample(regional: Rec) {
  const s = (regional.style ?? {}) as Rec;
  const now = new Date();
  const timeZone = regional.timezone ? String(regional.timezone) : undefined;
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone, ...o }).format(now);
  const dd = part({ day: "2-digit" }); const mm = part({ month: "2-digit" }); const yyyy = part({ year: "numeric" });
  const date = regional.dateFormat === "MM/DD/YYYY" ? `${mm}/${dd}/${yyyy}` : regional.dateFormat === "YYYY-MM-DD" ? `${yyyy}-${mm}-${dd}` : `${dd}/${mm}/${yyyy}`;
  const time = new Intl.DateTimeFormat(s.timeFormat === "12h" ? "en-US" : "en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: s.timeFormat === "12h" }).format(now);
  const thousands = String(s.thousandsSeparator ?? ",");
  const decimal = String(s.decimalSeparator ?? ".");
  const amount = `1${thousands}250${thousands}000${decimal}50`;
  const distance = s.unitSystem === "imperial" ? "745 mi" : "1,200 km".replace(",", thousands);
  return { date, time, amount, distance, phone: `${s.phoneCountryCode ?? "+"} 97 123 4567` };
}

export function RegionStep() {
  const { file, set, replace, err } = useSetUp();
  const r = (file.regional ?? {}) as Rec;
  const s = (r.style ?? {}) as Rec;
  const country = countryOf(r.country);
  const pickCountry = (code: string) => {
    const c = countryOf(code);
    if (!c) return replace(withValue(file, "regional.country", ""));
    replace({ ...file, regional: { ...r, country: c.code, baseCurrency: c.currency, timezone: c.timezone, dateFormat: c.dateFormat, fiscalYearStartMonth: c.fiscalYearStartMonth, style: c.style } });
  };
  const setStyle = (key: string, value: unknown) => set(`regional.style.${key}`, value);
  const shown = useMemo(() => sample(r), [r]);
  const numbers = `${s.decimalSeparator ?? "."}${s.thousandsSeparator ?? ","}`;
  const sampleData = file.data?.sample && file.data.sample !== "none";
  return (
    <div className="su-stack">
      <SettingsSection title="Where the company is" description="Choosing the country fills in everything below with what's usual there. Change anything that's different for this company.">
        <div className="su-pad grid-2">
          <Field label="Country *" hint={err("regional.country")}>
            <select className="input" value={String(r.country ?? "")} onChange={(e) => pickCountry(e.target.value)}>
              <option value="">Choose a country</option>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Base currency *" hint={err("regional.baseCurrency") ?? "Budgets, balances and settlements are kept in it. Others convert to it."}>
            <select className="input" value={String(r.baseCurrency ?? "")} onChange={(e) => set("regional.baseCurrency", e.target.value)}>
              <option value="">Choose a currency</option>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
            </select>
          </Field>
        </div>
        {sampleData && r.baseCurrency && r.baseCurrency !== "ZMW" && (
          <p className="su-note">The sample data is set in Zambia, and its amounts are in kwacha. With {String(r.baseCurrency)} as the base currency, add an exchange rate after set-up so its figures convert.</p>
        )}
      </SettingsSection>

      <CurrenciesAndRates />

      <div className="su-sample" aria-label="How this company's figures will read">
        <span>This company will read</span>
        <dl>
          <div><dt>Date</dt><dd>{shown.date}</dd></div>
          <div><dt>Time</dt><dd>{shown.time}</dd></div>
          <div><dt>Amount</dt><dd>{shown.amount} {String(r.baseCurrency ?? "")}</dd></div>
          <div><dt>Distance</dt><dd>{shown.distance}</dd></div>
          <div><dt>Phone</dt><dd>{shown.phone}</dd></div>
        </dl>
      </div>

      <SettingsSection title="Time and dates">
        <SettingRow title="Time zone" description="The company's clock: which day a trip or a rate belongs to, and the times on messages and documents." htmlFor="su-tz">
          <select id="su-tz" className="input" value={String(r.timezone ?? "")} onChange={(e) => set("regional.timezone", e.target.value)}>
            <option value="">Follow the country</option>
            {/* The country's zone may go by a newer name than the browser's list (Asia/Kolkata, Asia/Calcutta). */}
            {r.timezone && !TIME_ZONES.includes(String(r.timezone)) && <option value={String(r.timezone)}>{String(r.timezone).replace(/_/g, " ")}</option>}
            {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>)}
          </select>
        </SettingRow>
        <SettingRow title="Dates are written" description="On every screen, document and message." htmlFor="su-date">
          {/* A list, not buttons: the three formats don't fit side by side in this column. */}
          <select id="su-date" className="input" value={String(r.dateFormat ?? "DD/MM/YYYY")} onChange={(e) => set("regional.dateFormat", e.target.value)}>
            {["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </SettingRow>
        <SettingRow title="Clock" description="A 24-hour clock (15:30), or a 12-hour one (3:30 pm).">
          <Segmented choice label="Clock" value={String(s.timeFormat ?? "24h")} onChange={(v) => setStyle("timeFormat", v)} options={[{ value: "24h", label: "24-hour" }, { value: "12h", label: "12-hour" }]} />
        </SettingRow>
        <SettingRow title="Weeks start on" description="In calendars and weekly figures.">
          <Segmented choice label="Weeks start on" value={String(s.firstDayOfWeek ?? "monday")} onChange={(v) => setStyle("firstDayOfWeek", v)} options={[{ value: "monday", label: "Monday" }, { value: "sunday", label: "Sunday" }, { value: "saturday", label: "Saturday" }]} />
        </SettingRow>
        <SettingRow title="Financial year starts in" description="Yearly figures run from the first of this month." htmlFor="su-fy">
          <select id="su-fy" className="input" value={String(r.fiscalYearStartMonth ?? 1)} onChange={(e) => set("regional.fiscalYearStartMonth", Number(e.target.value))}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Numbers and units">
        <SettingRow title="Numbers are written" description="The separators in every figure and amount." htmlFor="su-num">
          <select id="su-num" className="input" value={numbers} onChange={(e) => { replace(withValue(withValue(file, "regional.style.decimalSeparator", e.target.value[0]), "regional.style.thousandsSeparator", e.target.value[1])); }}>
            {NUMBER_STYLES.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>
        </SettingRow>
        <SettingRow title="Phone country code" description="Assumed for numbers typed without one." htmlFor="su-dial">
          <input id="su-dial" className="input su-short" value={String(s.phoneCountryCode ?? "")} onChange={(e) => setStyle("phoneCountryCode", e.target.value.trim())} placeholder={country?.style.phoneCountryCode ?? "+260"} />
        </SettingRow>
        <SettingRow title="Units" description="Metric: litres, kilograms and kilometres.">
          <Segmented choice label="Units" value={String(s.unitSystem ?? "metric")} onChange={(v) => setStyle("unitSystem", v)} options={[{ value: "metric", label: "Metric" }, { value: "imperial", label: "Imperial" }]} />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

/* ---------- Other currencies, and where their rates come from ---------- */

interface RateProvider { key: string; label: string; description?: string; simulated: boolean; secrets: { key: string; label: string; required: boolean; hint?: string }[] }

function CurrenciesAndRates() {
  const { file, set } = useSetUp();
  const kinds = useQuery({ queryKey: ["connection-kinds"], queryFn: () => api<{ kind: string; providers: RateProvider[] }[]>("/connection-kinds"), staleTime: 60_000 });
  const providers = kinds.data?.find((k) => k.kind === "rates")?.providers ?? [];
  const r = (file.regional ?? {}) as Rec;
  const base = String(r.baseCurrency ?? "");
  const chosen = ((r.currencies ?? []) as string[]).filter((c) => c !== base);
  const connections = (file.connections ?? []) as Rec[];
  const at = connections.findIndex((c) => c.kind === "rates");
  const providerKey = at >= 0 ? String(connections[at]!.provider) : "";
  const provider = providers.find((p) => p.key === providerKey);
  const setProvider = (key: string) => {
    const rest = connections.filter((c) => c.kind !== "rates");
    const p = providers.find((x) => x.key === key);
    set("connections", p ? [...rest, { code: "RATES", name: p.label, kind: "rates", provider: p.key, enabled: true, settings: {}, secrets: Object.fromEntries(p.secrets.map((s) => [s.key, `CONNECTION_RATES_${s.key.toUpperCase()}`])) }] : rest);
  };
  const [live, setLive] = useState<{ rates: Record<string, number>; asOf?: string; missing?: string[]; needsKey?: boolean; failed?: string } | null>(null);
  const codes = chosen.join(",");
  useEffect(() => {
    if (!providerKey || !base || !chosen.length) { setLive(null); return; }
    let stale = false;
    api<{ rates: Record<string, number>; asOf?: string; missing?: string[]; needsKey?: boolean }>("/setup-kit/rates-preview", { method: "POST", body: { provider: providerKey, base, codes: chosen } })
      .then((x) => { if (!stale) setLive(x); })
      .catch((e: Error) => { if (!stale) setLive({ rates: {}, failed: e.message }); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `codes` is `chosen` as a value
  }, [providerKey, base, codes]);
  const name = (code: string) => CURRENCIES.find((c) => c.code === code)?.name ?? code;
  /** How the company reads a rate: one of the other currency in its own. */
  const rate = (code: string) => { const perBase = live?.rates[code]; return perBase ? 1 / perBase : undefined; };
  return (
    <SettingsSection title="Other currencies, and today's rates" description="The currencies it pays or invoices in besides its own. Each is added for you, and its rate is fetched live every day.">
      <SettingRow title="Rates come from" description={provider?.description ?? "Without a service, rates are typed in by hand."} htmlFor="su-rates">
        <select id="su-rates" className="input" value={providerKey} onChange={(e) => setProvider(e.target.value)}>
          <option value="">Typed in by hand</option>
          {providers.filter((p) => !p.simulated).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          {providers.filter((p) => p.simulated).map((p) => <option key={p.key} value={p.key}>{p.label}: not real rates</option>)}
        </select>
      </SettingRow>
      <div className="su-pad su-currencies">
        <select className="input" aria-label="Add a currency" value="" onChange={(e) => { if (e.target.value) set("regional.currencies", [...chosen, e.target.value]); }}>
          <option value="">Add a currency…</option>
          {CURRENCIES.filter((c) => c.code !== base && !chosen.includes(c.code)).map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
        </select>
        {chosen.length > 0 && (
          <div className="cust-table-wrap">
            <table className="cust-table">
              <thead><tr><th>Currency</th><th>Today's rate</th><th aria-label="Remove" /></tr></thead>
              <tbody>
                {chosen.map((code) => (
                  <tr key={code}>
                    <td><strong>{code}</strong> <span className="muted">{name(code)}</span></td>
                    <td className="num">{!providerKey ? <span className="muted">Typed in by hand</span> : live?.needsKey ? <span className="muted">Once its key is set</span> : live?.failed ? <span className="su-bad-text">Couldn't reach it</span> : !live ? <span className="muted">Checking…</span> : rate(code) ? `1 ${code} = ${rate(code)!.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${base}` : <span className="su-bad-text">Not offered by this service</span>}</td>
                    <td><Button size="sm" tone="quiet" onClick={() => set("regional.currencies", chosen.filter((c) => c !== code))}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {live?.failed && <p className="su-note bad">{live.failed}</p>}
        {live?.asOf && !live.failed && <p className="muted su-asof">Live, from the service, as of {new Date(live.asOf).toLocaleDateString()}. Rates are stored daily once set up.</p>}
        {provider?.key === "open-er-api" && <p className="muted su-asof">Rates by <a className="su-link" href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">Exchange Rate API</a>.</p>}
      </div>
    </SettingsSection>
  );
}

/* ---------- Brand ---------- */

/** How dark a colour is against white text; 4.5 is the least that reads easily. */
function contrastWithWhite(hex: string) {
  const channel = (i: number) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (lum + 0.05);
}

export function BrandStep() {
  const { file, set, replace, attachments, putFile, removeFile, err } = useSetUp();
  const b = (file.brand ?? {}) as Rec;
  const c = (file.company ?? {}) as Rec;
  const w = (file.watermark ?? {}) as Rec;
  const name = String(b.productName || c.tradingName || c.legalName || "Your company");
  const accent = /^#[0-9a-f]{6}$/i.test(String(b.accent ?? "")) ? String(b.accent) : "#1d4d3f";
  const ratio = contrastWithWhite(accent);
  const imageOf = (slot: string) => {
    const path = b.files?.[slot] as string | undefined;
    const data = attachments.find((a) => a.path === path)?.data;
    if (!path || !data) return undefined;
    const ext = path.split(".").pop();
    return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${data}`;
  };
  const putLogo = async (slot: string, chosen: File) => {
    if (!IMAGE_TYPES.split(",").includes(chosen.type)) return;
    const path = `files/${slot}.${chosen.type === "image/jpeg" ? "jpg" : chosen.type.split("/")[1]}`;
    await putFile(path, chosen);
    replace(withValue(file, `brand.files.${slot}`, path));
  };
  const dropLogo = (slot: string) => {
    const path = b.files?.[slot] as string | undefined;
    if (path) removeFile(path);
    replace(withValue(file, `brand.files.${slot}`, undefined));
  };
  const logo = imageOf("logo");
  const dark = imageOf("logoDark") ?? logo;
  const slots = [
    { slot: "logo", title: "Logo", text: "On the sign-in page and the top of every document. A PNG with a transparent background works best." },
    { slot: "logoDark", title: "Logo on dark backgrounds", text: "For the dark sidebar. Leave empty to use the logo above." },
    { slot: "icon", title: "Icon", text: "A square image for the browser tab and a phone's home screen." },
  ];
  return (
    <div className="su-brand">
      <div className="su-stack">
        <SettingsSection title="Names">
          <div className="su-pad grid-2">
            <Field label="Product name" hint={err("brand.productName") ?? "What people call the app. Leave empty for the trading name."}><input className="input" value={String(b.productName ?? "")} onChange={(e) => set("brand.productName", e.target.value)} placeholder={String(c.tradingName || c.legalName || "")} /></Field>
            <Field label="Short name" hint={err("brand.shortName") ?? "Where space is tight: a phone's home screen, text messages."}><input className="input" maxLength={24} value={String(b.shortName ?? "")} onChange={(e) => set("brand.shortName", e.target.value)} /></Field>
            <Field label="E-mails come from" hint={err("brand.emailSenderName") ?? "The sender name people see."}><input className="input" value={String(b.emailSenderName ?? "")} onChange={(e) => set("brand.emailSenderName", e.target.value)} placeholder={name} /></Field>
            <Field label="Message signature" hint={err("brand.signature") ?? "Added to messages, e.g. a number to call."}><input className="input" value={String(b.signature ?? "")} onChange={(e) => set("brand.signature", e.target.value)} /></Field>
          </div>
        </SettingsSection>
        <SettingsSection title="Colour" description="Buttons, links and the sidebar take this colour.">
          <div className="su-pad su-colour">
            {SWATCHES.map((hex) => (
              <button key={hex} type="button" className={`su-swatch ${accent.toLowerCase() === hex ? "on" : ""}`} style={{ background: hex }} aria-label={`Use ${hex}`} aria-pressed={accent.toLowerCase() === hex} onClick={() => set("brand.accent", hex)}>
                {accent.toLowerCase() === hex && <Check size={15} color="#fff" aria-hidden />}
              </button>
            ))}
            <span className="su-colour-own">
              <input type="color" aria-label="Pick any colour" value={accent} onChange={(e) => set("brand.accent", e.target.value)} />
              <input className="input su-mono su-short" aria-label="Colour" value={String(b.accent ?? "")} onChange={(e) => set("brand.accent", e.target.value)} placeholder="#1d4d3f" />
            </span>
            {ratio < 4.5
              ? <p className="su-colour-note"><Status tone="wait">Too light</Status> White text on this colour is hard to read. A darker shade works better.</p>
              : err("brand.accent") && <p className="su-colour-note">{err("brand.accent")}</p>}
          </div>
        </SettingsSection>
        <SettingsSection title="Logos" description="Optional. Without one, the product name is shown in its place.">
          {slots.map(({ slot, title, text }) => {
            const url = imageOf(slot);
            return (
              <SettingRow key={slot} title={title} description={err(`brand.files.${slot}`) ?? text}>
                <FileDrop accept={IMAGE_TYPES} label="Drop an image or choose one" hint="PNG, JPEG or WebP" onFile={(f) => void putLogo(slot, f)} onRemove={() => dropLogo(slot)}
                  chosen={url ? <img className={slot === "logoDark" ? "on-dark" : ""} src={url} alt="" /> : undefined} />
              </SettingRow>
            );
          })}
        </SettingsSection>
        <SettingsSection title="Watermark" description="A faint mark under the content of printed documents.">
          <SettingRow title="Show" description="The company's text, its logo, or nothing.">
            <Segmented choice label="Watermark" value={String(w.mode ?? "off")} onChange={(v) => set("watermark.mode", v)} options={[{ value: "off", label: "None" }, { value: "text", label: "Text" }, { value: "logo", label: "Logo" }]} />
          </SettingRow>
          {w.mode === "text" && (
            <SettingRow title="Text" description="Short and in capitals reads best." htmlFor="su-wm">
              <input id="su-wm" className="input" maxLength={40} value={String(w.text ?? "")} onChange={(e) => set("watermark.text", e.target.value)} placeholder="CONFIDENTIAL" />
            </SettingRow>
          )}
        </SettingsSection>
      </div>

      <aside className="su-preview" aria-label="Preview">
        <span className="su-preview-title">How it will look</span>
        <div className="su-preview-app">
          <div className="su-preview-side" style={{ background: accent }}>
            {dark ? <img src={dark} alt="" /> : <strong>{name}</strong>}
            <span className="on">Overview</span><span>Trips</span><span>Masters</span>
          </div>
          <div className="su-preview-main">
            <strong>Overview</strong>
            <span className="su-preview-line" /><span className="su-preview-line short" />
            <span className="su-preview-btn" style={{ background: accent }}>New trip</span>
          </div>
        </div>
        {/* ui-allow: a printed document, as on the real trip sheet */}
        <div className="su-preview-doc">
          {w.mode === "text" && w.text && <span className="su-preview-mark">{String(w.text)}</span>}
          {w.mode === "logo" && logo && <img className="su-preview-mark-img" src={logo} alt="" />}
          <header>
            {logo ? <img src={logo} alt="" /> : <strong>{String(c.legalName || name)}</strong>}
            <span>Trip sheet</span>
          </header>
          <p>{String(c.legalName || name)}{c.address?.line1 ? `, ${String(c.address.line1)}` : ""}{c.taxId ? ` · Tax ID ${String(c.taxId)}` : ""}</p>
          <span className="su-preview-line" /><span className="su-preview-line" /><span className="su-preview-line short" />
        </div>
      </aside>
    </div>
  );
}

/* ---------- Areas ---------- */

export function AreasStep() {
  const { file, set, err } = useSetUp();
  const list = useAreaList();
  const areas = (list.data ?? []) as (Rec & { key: string; name: string; description: string; state: string; always?: boolean; on: boolean; within?: string })[];
  const value: string[] = (file.areas as string[] | undefined) ?? areas.filter((a) => a.on).map((a) => a.key);
  const toggle = (key: string, on: boolean) => {
    let next = on ? [...new Set([...value, key])] : value.filter((v) => v !== key);
    // What sits inside an area goes off with it.
    if (!on) next = next.filter((k) => areas.find((a) => a.key === k)?.within !== key);
    set("areas", next);
  };
  if (list.isLoading) return <p className="muted">Loading the areas…</p>;
  const main = areas.filter((a) => !a.within);
  return (
    <div className="su-stack">
      {err("areas") && <p className="su-note bad">{err("areas")}</p>}
      <SettingsSection title="Areas switched on" description="Switch off what this company doesn't use: its screens and menus go away, and it can come back on at any time with nothing lost.">
        {main.map((a) => (
          <div key={a.key}>
            <AreaRow area={a} on={value.includes(a.key)} onToggle={toggle} />
            {areas.filter((x) => x.within === a.key).map((x) => <AreaRow key={x.key} area={x} on={value.includes(x.key)} parentOff={!value.includes(a.key)} onToggle={toggle} />)}
          </div>
        ))}
      </SettingsSection>
    </div>
  );
}

function AreaRow({ area: a, on, parentOff, onToggle }: { area: { key: string; name: string; description: string; state: string; always?: boolean; within?: string }; on: boolean; parentOff?: boolean; onToggle: (k: string, on: boolean) => void }) {
  const soon = a.state === "not-built";
  return (
    <div className={a.within ? "su-area-inner" : undefined}>
      <SettingRow title={<>{a.name}{a.state === "early" && <span className="status status-info area-early">Early</span>}{soon && <span className="status status-mute area-early">Coming soon</span>}</>} description={a.description}>
        {a.always ? <span className="setting-fixed">Always on</span>
          : <Switch label={`Use ${a.name}`} checked={on && !soon && !parentOff} disabled={soon || parentOff} onChange={(v) => onToggle(a.key, v)} />}
      </SettingRow>
    </div>
  );
}
