import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Empty, Field, SaveBar, Segmented, SettingRow, SettingsSection, Switch, UnitInput } from "../ui/kit";
import { contrastWithWhite, useReloadBrand } from "../ui/brand";
import { BrandUpload } from "./BrandUpload";

/**
 * The company's own settings (GET/PUT /company): details, base currency and time zone, which areas are
 * switched on, self sign-up, and the trip settings that replace values once fixed in code.
 */

/** The areas a company can switch on. `live: false` marks an area that isn't built yet: shown, never a switch that does nothing. */
const MODULES: { key: string; name: string; description: string; live: boolean }[] = [
  { key: "trips", name: "Trips and nominations", description: "Planning, dispatching and closing trips, and customers' nominations.", live: true },
  { key: "finance", name: "Money", description: "Fuel and cash requests, expenses, and settling drivers.", live: true },
  { key: "tracking", name: "Tracking", description: "Where each truck is and how fast it moves, from the driver's phone or a tracker.", live: true },
  { key: "driver-app", name: "Driver app", description: "Drivers sign in on their phone to see their trip, send receipts and report arrivals.", live: true },
  { key: "maintenance", name: "Maintenance", description: "Services, repairs and parts for each truck.", live: false },
  { key: "billing", name: "Billing", description: "Invoices to customers and payments received.", live: false },
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];
const PERIODS: { value: string; label: string }[] = [{ value: "any", label: "Any time" }, { value: "weekly", label: "Weekly" }, { value: "fortnightly", label: "Fortnightly" }, { value: "monthly", label: "Monthly" }];
const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];

/** Number settings under "operations", with their defaults (today's values for the first client) and when each is used. */
const NUMBERS: { key: string; title: string; description: string; unit: string; step: number; fallback: number }[] = [
  { key: "roadDistanceFactor", title: "Road distance from a straight line", description: "When no route gives the distance, the straight-line distance is multiplied by this.", unit: "×", step: 0.01, fallback: 1.28 },
  { key: "averageSpeedKmh", title: "Average speed", description: "Used to estimate how long a leg takes and when a truck arrives.", unit: "km/h", step: 1, fallback: 62 },
  { key: "defaultFuelReservePercent", title: "Fuel reserve", description: "Extra fuel added to a trip's budget when no fuel norm sets a reserve.", unit: "%", step: 0.5, fallback: 6 },
  { key: "defaultShortageAllowancePercent", title: "Shortage allowance", description: "How much of a load may go missing before it counts as a shortage, when no shortage policy or product sets it.", unit: "%", step: 0.01, fallback: 0.3 },
  { key: "deliveredOverLoadedPercent", title: "Delivered above loaded", description: "A delivery may show up to this much more than was loaded (both at 20 °C) before it is questioned.", unit: "%", step: 0.1, fallback: 2 },
];
const DENSITY = { min: { key: "densityMinKgM3", fallback: 600 }, max: { key: "densityMaxKgM3", fallback: 1000 } };
const ALL_NUMBERS = [...NUMBERS.map((n) => ({ key: n.key, fallback: n.fallback })), DENSITY.min, DENSITY.max];

type Form = Record<string, unknown> & { operations: Record<string, unknown>; modules: string[]; brand: Record<string, string>; watermark: Record<string, unknown> };
const BRAND_KEYS = ["productName", "shortName", "accent", "emailSenderName", "signature", "logoFileId", "logoDarkFileId", "iconFileId", "logoPdfFileId"] as const;

function formFrom(company: Rec | null): Form {
  const ops = company?.operations ?? {};
  return {
    legalName: company?.legalName ?? "",
    tradingName: company?.tradingName ?? "",
    registrationNumber: company?.registrationNumber ?? "",
    taxId: company?.taxId ?? "",
    countryId: company?.countryId ?? "",
    baseCurrencyId: company?.baseCurrencyId ?? "",
    timezone: company?.timezone ?? "Africa/Lusaka",
    fiscalYearStartMonth: company?.fiscalYearStartMonth ?? 1,
    dateFormat: company?.dateFormat ?? "DD/MM/YYYY",
    phone: company?.phone ?? "",
    email: company?.email ?? "",
    website: company?.website ?? "",
    allowSelfRegistration: Boolean(company?.allowSelfRegistration),
    modules: company?.modules ?? ["masters", "trips"],
    brand: Object.fromEntries(BRAND_KEYS.map((k) => [k, String(company?.brand?.[k] ?? "")])),
    watermark: { mode: "off", text: "", opacity: 0.08, angle: 35, tripSheet: true, statement: true, invoice: true, screens: false, ...(company?.watermark ?? {}) },
    operations: {
      tripStartsFromTruck: ops.tripStartsFromTruck ?? true,
      stopBeforeLoading: ops.stopBeforeLoading ?? true,
      settlementPeriod: ops.settlementPeriod ?? "any",
      ...Object.fromEntries(ALL_NUMBERS.map((n) => [n.key, ops[n.key] ?? n.fallback])),
    },
  };
}

/** Empty optional text clears the value; required text is left out when empty. */
const textOrNull = (v: unknown) => (String(v ?? "").trim() ? String(v).trim() : null);

export function CompanyPanel() {
  const { me, toast, refreshReference } = useApp();
  const client = useQueryClient();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Rec>("/company").catch(() => null) });
  const currencies = useQuery({ queryKey: ["company-currencies"], queryFn: () => api<Rec[]>("/currencies", { query: { limit: 100, status: "active" } }) });
  const countries = useQuery({ queryKey: ["company-countries"], queryFn: () => api<Rec[]>("/countries", { query: { limit: 100, status: "active" } }) });
  const [form, setForm] = useState<Form>(() => formFrom(null));
  const saved = formFrom(company.data ?? null);
  const dirty = company.data !== undefined && JSON.stringify(form) !== JSON.stringify(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (company.data !== undefined) setForm(formFrom(company.data)); }, [company.data]);
  const writable = can(me, "company", "update");
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const setOp = (key: string, value: unknown) => setForm((f) => ({ ...f, operations: { ...f.operations, [key]: value } }));
  const setBrand = (change: Record<string, string>) => setForm((f) => ({ ...f, brand: { ...f.brand, ...change } }));
  const setMark = (key: string, value: unknown) => setForm((f) => ({ ...f, watermark: { ...f.watermark, [key]: value } }));
  const reloadBrand = useReloadBrand();

  if (company.isLoading) return <p className="muted">Loading the company…</p>;

  const save = async () => {
    const accent = form.brand.accent;
    if (accent && contrastWithWhite(accent) < 4.5) {
      toast(`White text on ${accent} is hard to read (${contrastWithWhite(accent).toFixed(1)}:1). Pick a darker accent colour.`, "error");
      return;
    }
    setBusy(true);
    try {
      const body: Rec = {
        ...(company.data ? { version: company.data.version } : {}),
        legalName: String(form.legalName).trim() || undefined,
        tradingName: textOrNull(form.tradingName), registrationNumber: textOrNull(form.registrationNumber), taxId: textOrNull(form.taxId),
        countryId: textOrNull(form.countryId), baseCurrencyId: textOrNull(form.baseCurrencyId),
        timezone: form.timezone, fiscalYearStartMonth: Number(form.fiscalYearStartMonth), dateFormat: form.dateFormat,
        phone: textOrNull(form.phone), email: textOrNull(form.email), website: textOrNull(form.website),
        allowSelfRegistration: form.allowSelfRegistration, modules: form.modules,
        operations: { ...form.operations, ...Object.fromEntries(ALL_NUMBERS.map((n) => [n.key, Number(form.operations[n.key])])) },
        brand: Object.fromEntries(BRAND_KEYS.map((k) => [k, textOrNull(form.brand[k])])),
        watermark: { ...form.watermark, text: textOrNull(form.watermark.text), opacity: Number(form.watermark.opacity), angle: Number(form.watermark.angle) },
      };
      await api("/company", { method: "PUT", body });
      toast("Company saved.");
      await client.invalidateQueries({ queryKey: ["company"] });
      reloadBrand();
      refreshReference();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const has = (key: string) => form.modules.includes(key);
  const toggleModule = (key: string, on: boolean) => set("modules", on ? [...new Set([...form.modules, key])] : form.modules.filter((m) => m !== key));
  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Company</h2>
          <p>Details, currency, the areas switched on, and the trip settings this company works with.</p>
        </div>
      </header>
      {company.error && <Empty title="Could not load the company">{(company.error as Error).message}</Empty>}
      <fieldset className="company-form settings-page" disabled={!writable}>
        <SettingsSection title="Details" description="How the company appears on trip sheets, statements and messages.">
          <div className="grid-2">
            <Field label="Legal name"><input className="input" value={String(form.legalName)} onChange={(e) => set("legalName", e.target.value)} /></Field>
            <Field label="Trading name"><input className="input" value={String(form.tradingName)} onChange={(e) => set("tradingName", e.target.value)} /></Field>
            <Field label="Registration number"><input className="input" value={String(form.registrationNumber)} onChange={(e) => set("registrationNumber", e.target.value)} /></Field>
            <Field label="Tax ID"><input className="input" value={String(form.taxId)} onChange={(e) => set("taxId", e.target.value)} /></Field>
            <Field label="Phone"><input className="input" value={String(form.phone)} onChange={(e) => set("phone", e.target.value)} placeholder="+260…" /></Field>
            <Field label="E-mail"><input className="input" type="email" value={String(form.email)} onChange={(e) => set("email", e.target.value)} /></Field>
            <Field label="Website"><input className="input" value={String(form.website)} onChange={(e) => set("website", e.target.value)} placeholder="https://" /></Field>
            <Field label="Country">
              <select className="input" value={String(form.countryId)} onChange={(e) => set("countryId", e.target.value)}>
                <option value="">—</option>
                {(countries.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection title="Brand" description="How the product looks to everyone who uses it: staff, drivers and customers. It appears on the sign-in page, every screen, the driver app, documents, e-mails and messages.">
          <SettingRow title="Product name" description="What people call the app: the browser tab, the sign-in page and e-mail subjects. Empty: the trading name." htmlFor="br-name">
            <input id="br-name" className="input" placeholder={String(form.tradingName || form.legalName || "")} value={form.brand.productName} onChange={(e) => setBrand({ productName: e.target.value })} />
          </SettingRow>
          <SettingRow title="Short name" description="Where space is tight: the driver app on a phone's home screen, and text messages." htmlFor="br-short">
            <input id="br-short" className="input" maxLength={24} placeholder={form.brand.productName || "Short name"} value={form.brand.shortName} onChange={(e) => setBrand({ shortName: e.target.value })} />
          </SettingRow>
          <SettingRow title="Logo" description="On the sign-in page, the top of every printed document, and in place of the name where there is room. PNG with a transparent background works best.">
            <BrandUpload label="Logo" fileId={form.brand.logoFileId} onChange={(id) => setBrand({ logoFileId: id })} onPdfCopy={(id) => setBrand({ logoPdfFileId: id })} disabled={!writable} />
          </SettingRow>
          <SettingRow title="Logo on dark backgrounds" description="For the dark sidebar. Empty: the logo above.">
            <BrandUpload label="Logo on dark backgrounds" dark fileId={form.brand.logoDarkFileId} onChange={(id) => setBrand({ logoDarkFileId: id })} disabled={!writable} />
          </SettingRow>
          <SettingRow title="Icon" description="A square image for the browser tab and the phone's home screen.">
            <BrandUpload label="Icon" square fileId={form.brand.iconFileId} onChange={(id) => setBrand({ iconFileId: id })} disabled={!writable} />
          </SettingRow>
          <SettingRow title="Accent colour" description="Buttons, links and the sidebar take this colour. It must be dark enough for white text on it to read easily." htmlFor="br-accent">
            <span className="accent-input">
              <input type="color" aria-label="Pick the accent colour" value={form.brand.accent || "#1d4d3f"} onChange={(e) => setBrand({ accent: e.target.value })} />
              <input id="br-accent" className="input" placeholder="#1d4d3f (the default)" value={form.brand.accent} onChange={(e) => setBrand({ accent: e.target.value.trim() })} />
              {form.brand.accent && <button type="button" className="link-btn" onClick={() => setBrand({ accent: "" })}>Default</button>}
            </span>
          </SettingRow>
          <SettingRow title="E-mails come from" description="The sender name people see. The address stays the one set in Sending messages. Empty: the product name." htmlFor="br-sender">
            <input id="br-sender" className="input" placeholder={form.brand.productName || String(form.tradingName || "")} value={form.brand.emailSenderName} onChange={(e) => setBrand({ emailSenderName: e.target.value })} />
          </SettingRow>
          <SettingRow title="Message signature" description="Available to every message template as {{company.signature}}, e.g. a phone number to call." htmlFor="br-sign">
            <input id="br-sign" className="input" maxLength={160} value={form.brand.signature} onChange={(e) => setBrand({ signature: e.target.value })} />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Watermark" description="A faint mark under the content of printed documents, and on their previews. An installation used for testing always shows TEST COPY as well.">
          <SettingRow title="Watermark" description="The company's text, its logo, or none.">
            <Segmented choice label="Watermark" value={String(form.watermark.mode)} disabled={!writable}
              options={[{ value: "off", label: "None" }, { value: "text", label: "Text" }, { value: "logo", label: "Logo" }]} onChange={(v) => setMark("mode", v)} />
          </SettingRow>
          {form.watermark.mode === "text" && (
            <SettingRow title="Text" description="Short and in capitals reads best, e.g. CONFIDENTIAL or the company's name." htmlFor="wm-text">
              <input id="wm-text" className="input" maxLength={40} value={String(form.watermark.text ?? "")} onChange={(e) => setMark("text", e.target.value)} />
            </SettingRow>
          )}
          {form.watermark.mode !== "off" && (
            <>
              <SettingRow title="Strength" description="How visible it is: 3% is barely there, 15% is clearly seen behind the text.">
                <UnitInput label="Watermark strength" unit="%" step={1} value={Math.round(Number(form.watermark.opacity) * 100)} onChange={(v) => setMark("opacity", Math.min(0.5, Math.max(0.03, Number(v) / 100)))} />
              </SettingRow>
              <SettingRow title="Angle" description="Degrees from level. 35 runs corner to corner on a page.">
                <UnitInput label="Watermark angle" unit="°" step={5} value={Number(form.watermark.angle)} onChange={(v) => setMark("angle", Math.max(-90, Math.min(90, Number(v))))} />
              </SettingRow>
              {([["tripSheet", "Trip sheets"], ["statement", "Driver statements"], ["invoice", "Invoices"], ["screens", "Previews on screen"]] as const).map(([key, title]) => (
                <SettingRow key={key} title={title}>
                  <Switch label={`Watermark on ${title.toLowerCase()}`} checked={Boolean(form.watermark[key])} onChange={(on) => setMark(key, on)} />
                </SettingRow>
              ))}
            </>
          )}
        </SettingsSection>

        <SettingsSection title="Money and time">
          <SettingRow title="Base currency" description="Budgets, balances and settlements are kept in it. Amounts in other currencies are converted to it." htmlFor="co-currency">
            <select id="co-currency" className="input" value={String(form.baseCurrencyId)} onChange={(e) => set("baseCurrencyId", e.target.value)}>
              <option value="">—</option>
              {(currencies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </SettingRow>
          <SettingRow title="Time zone" description="The company's clock: the day a trip, a rate or a report belongs to." htmlFor="co-tz">
            <select id="co-tz" className="input" value={String(form.timezone)} onChange={(e) => set("timezone", e.target.value)}>
              {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>)}
            </select>
          </SettingRow>
          <SettingRow title="Financial year starts in" description="Yearly figures run from the first of this month." htmlFor="co-fy">
            <select id="co-fy" className="input" value={String(form.fiscalYearStartMonth)} onChange={(e) => set("fiscalYearStartMonth", Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </SettingRow>
          <SettingRow title="Date format" description="How dates are written on documents the company sends." htmlFor="co-date">
            <select id="co-date" className="input" value={String(form.dateFormat)} onChange={(e) => set("dateFormat", e.target.value)}>
              {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Areas switched on" description="Switch off what the company doesn't use. An area that is off accepts no new work; what was recorded in it is kept.">
          <SettingRow title="Masters" description="Trucks, drivers, customers, places and every other list the work draws on.">
            <span className="setting-fixed">Always on</span>
          </SettingRow>
          {MODULES.map((m) => (
            <SettingRow key={m.key} title={m.name} description={m.description}>
              {m.live
                ? <Switch label={m.name} checked={has(m.key)} onChange={(on) => toggleModule(m.key, on)} />
                : <span className="setting-fixed">Not built yet</span>}
            </SettingRow>
          ))}
        </SettingsSection>

        <SettingsSection title="Signing up">
          <SettingRow title="Let people create their own account" description="Anyone with the app's address can sign up. They start as Viewer, able to see but not change anything, until someone gives them a role.">
            <Switch label="Let people create their own account" checked={Boolean(form.allowSelfRegistration)} onChange={(on) => set("allowSelfRegistration", on)} />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Trips" description="Rules the trip desks follow. Masters such as fuel norms, routes and shortage policies take precedence where they set a value.">
          <SettingRow title="Start a trip from the truck" description="Picking a truck fills in its paired trailer and its usual driver. Off: each is chosen on its own.">
            <Switch label="Start a trip from the truck" checked={Boolean(form.operations.tripStartsFromTruck)} onChange={(on) => setOp("tripStartsFromTruck", on)} />
          </SettingRow>
          <SettingRow title="Allow stopping a trip before loading" description="Operations can stop a trip that left but never loaded, and free the truck for other work.">
            <Switch label="Allow stopping a trip before loading" checked={Boolean(form.operations.stopBeforeLoading)} onChange={(on) => setOp("stopBeforeLoading", on)} />
          </SettingRow>
          {NUMBERS.map((n) => (
            <SettingRow key={n.key} title={n.title} description={n.description}>
              <UnitInput label={n.title} unit={n.unit} step={n.step} value={String(form.operations[n.key] ?? "")} onChange={(v) => setOp(n.key, v)} />
            </SettingRow>
          ))}
          <SettingRow title="Believable density" description="A loading or delivery reading outside this range is questioned as a likely typing mistake.">
            <span className="range-inputs">
              <UnitInput label="Lowest believable density" unit="kg/m³" step={1} value={String(form.operations[DENSITY.min.key] ?? "")} onChange={(v) => setOp(DENSITY.min.key, v)} />
              <span aria-hidden>to</span>
              <UnitInput label="Highest believable density" unit="kg/m³" step={1} value={String(form.operations[DENSITY.max.key] ?? "")} onChange={(v) => setOp(DENSITY.max.key, v)} />
            </span>
          </SettingRow>
          <SettingRow title="How often drivers are settled" description="Any time: Finance settles a driver whenever it chooses. Otherwise settlements follow the period.">
            <Segmented choice label="How often drivers are settled" value={String(form.operations.settlementPeriod)} options={PERIODS} onChange={(v) => setOp("settlementPeriod", v)} disabled={!writable} />
          </SettingRow>
        </SettingsSection>
      </fieldset>
      {writable && <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => setForm(saved)} />}
    </div>
  );
}
