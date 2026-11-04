import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Empty, Field } from "../ui/kit";

/**
 * The company's own settings (GET/PUT /company): details, base currency and time zone, which areas are
 * switched on, self sign-up, and the trip settings that replace values once fixed in code.
 */

const MODULES: [string, string][] = [
  ["masters", "Masters"],
  ["trips", "Trips and nominations"],
  ["finance", "Money: requests, expenses and settlement"],
  ["tracking", "Tracking"],
  ["maintenance", "Maintenance"],
  ["billing", "Billing"],
  ["driver-app", "Driver web app (drivers sign in on their phone)"],
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];
const PERIODS: [string, string][] = [["any", "Whenever Finance chooses"], ["weekly", "Weekly"], ["fortnightly", "Fortnightly"], ["monthly", "Monthly"]];
const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];

/** Number settings under "operations", with their defaults (today's values for the first client). */
const NUMBERS: { key: string; label: string; unit: string; step: number; fallback: number }[] = [
  { key: "roadDistanceFactor", label: "Road distance when no route gives it", unit: "× straight line", step: 0.01, fallback: 1.28 },
  { key: "averageSpeedKmh", label: "Average speed", unit: "km/h", step: 1, fallback: 62 },
  { key: "defaultFuelReservePercent", label: "Fuel reserve when no fuel norm sets one", unit: "%", step: 0.5, fallback: 6 },
  { key: "defaultShortageAllowancePercent", label: "Shortage allowance when no policy or product sets one", unit: "%", step: 0.01, fallback: 0.3 },
  { key: "deliveredOverLoadedPercent", label: "Delivered may exceed loaded by up to", unit: "%", step: 0.1, fallback: 2 },
  { key: "densityMinKgM3", label: "Lowest believable density", unit: "kg/m³", step: 1, fallback: 600 },
  { key: "densityMaxKgM3", label: "Highest believable density", unit: "kg/m³", step: 1, fallback: 1000 },
];

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
      ...Object.fromEntries(NUMBERS.map((n) => [n.key, ops[n.key] ?? n.fallback])),
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
        operations: { ...form.operations, ...Object.fromEntries(NUMBERS.map((n) => [n.key, Number(form.operations[n.key])])) },
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

  return (
    <div className="desk">
      <header className="masters-head">
        <h2>Company</h2>
        {writable && <Button tone="primary" busy={busy} onClick={save}>Save</Button>}
      </header>
      {company.error && <Empty title="Could not load the company">{(company.error as Error).message}</Empty>}
      <fieldset className="company-form" disabled={!writable}>
        <fieldset className="form-group">
          <legend>Details</legend>
          <div className="grid-2">
            <Field label="Legal name"><input className="input" value={String(form.legalName)} onChange={(e) => set("legalName", e.target.value)} /></Field>
            <Field label="Trading name"><input className="input" value={String(form.tradingName)} onChange={(e) => set("tradingName", e.target.value)} /></Field>
            <Field label="Registration number"><input className="input" value={String(form.registrationNumber)} onChange={(e) => set("registrationNumber", e.target.value)} /></Field>
            <Field label="Tax id"><input className="input" value={String(form.taxId)} onChange={(e) => set("taxId", e.target.value)} /></Field>
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
        </fieldset>
        <fieldset className="form-group">
          <legend>Money and time</legend>
          <div className="grid-2">
            <Field label="Base currency" hint="Budgets, balances and settlements are kept in it.">
              <select className="input" value={String(form.baseCurrencyId)} onChange={(e) => set("baseCurrencyId", e.target.value)}>
                <option value="">—</option>
                {(currencies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </select>
            </Field>
            <Field label="Time zone">
              <select className="input" value={String(form.timezone)} onChange={(e) => set("timezone", e.target.value)}>
                {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </Field>
            <Field label="Financial year starts in">
              <select className="input" value={String(form.fiscalYearStartMonth)} onChange={(e) => set("fiscalYearStartMonth", Number(e.target.value))}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </Field>
            <Field label="Date format">
              <select className="input" value={String(form.dateFormat)} onChange={(e) => set("dateFormat", e.target.value)}>
                {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Areas switched on</legend>
          <div className="checks">
            {MODULES.map(([key, name]) => (
              <label key={key} className="check-line">
                <input
                  type="checkbox"
                  checked={form.modules.includes(key)}
                  disabled={key === "masters"}
                  onChange={(e) => set("modules", e.target.checked ? [...form.modules, key] : form.modules.filter((m) => m !== key))}
                />
                {name}
              </label>
            ))}
          </div>
          <label className="check-line">
            <input type="checkbox" checked={Boolean(form.allowSelfRegistration)} onChange={(e) => set("allowSelfRegistration", e.target.checked)} />
            Let people create their own account (they start as Viewer)
          </label>
        </fieldset>
        <fieldset className="form-group">
          <legend>Trip settings</legend>
          <label className="check-line">
            <input type="checkbox" checked={Boolean(form.operations.tripStartsFromTruck)} onChange={(e) => setOp("tripStartsFromTruck", e.target.checked)} />
            Trips start from the truck: its trailer and driver fill in
          </label>
          <label className="check-line">
            <input type="checkbox" checked={Boolean(form.operations.stopBeforeLoading)} onChange={(e) => setOp("stopBeforeLoading", e.target.checked)} />
            Operations can stop a trip that left but never loaded, and free the truck
          </label>
          <div className="grid-2">
            {NUMBERS.map((n) => (
              <Field key={n.key} label={n.label}>
                <span className="unit-input">
                  <input className="input" type="number" step={n.step} value={String(form.operations[n.key] ?? "")} onChange={(e) => setOp(n.key, e.target.value)} />
                  <span className="muted">{n.unit}</span>
                </span>
              </Field>
            ))}
            <Field label="Drivers are settled">
              <select className="input" value={String(form.operations.settlementPeriod)} onChange={(e) => setOp("settlementPeriod", e.target.value)}>
                {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          </div>
        </fieldset>
      </fieldset>
    </div>
  );
}
