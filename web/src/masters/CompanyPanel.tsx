import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Empty, Field, SaveBar, Segmented, SettingRow, SettingsSection, Switch, UnitInput } from "../ui/kit";

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

type Form = Record<string, unknown> & { operations: Record<string, unknown>; modules: string[] };

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

  if (company.isLoading) return <p className="muted">Loading the company…</p>;

  const save = async () => {
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
      };
      await api("/company", { method: "PUT", body });
      toast("Company saved.");
      await client.invalidateQueries({ queryKey: ["company"] });
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
