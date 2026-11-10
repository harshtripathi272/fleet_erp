import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { ChoiceChips, Empty, SaveBar, Segmented, SettingRow, SettingsSection, Status, Switch, UnitInput } from "../ui/kit";

/**
 * Company → Freight (#135, consignments design 3.9 and 3.11.11): how this company carries consignments, holds a
 * truck at a stop, prices freight and counts a trip's profit. What applies now comes from the server
 * (`effectiveFreight` on GET /company), which also says which settings are stored but not acted on yet. Saving sends
 * only what changed; the server merges it.
 */

type Option = { value: string; label: string };
type Control =
  | { kind: "switch" }
  | { kind: "choice"; options: Option[] }
  | { kind: "select"; options: Option[] }
  | { kind: "chips"; options: Option[]; atLeastOne?: boolean }
  | { kind: "number"; unit: string; step: number; min?: number; max?: number }
  | { kind: "money"; per: string }
  | { kind: "consignment-type" };
type Setting = { key: string; title: string; description: ReactNode; control: Control };

const SECTIONS: { title: string; description: string; settings: Setting[] }[] = [
  {
    title: "Consignments",
    description: "What a consignment is on this company's trips, and what booking one asks for.",
    settings: [
      {
        key: "consignmentBy", title: "A trip needs its consignment",
        description: "At loading: a trip can be planned and leave before its consignment is entered, which is then added at the loading stop. Before it leaves: the trip can't leave the yard without one.",
        control: { kind: "choice", options: [{ value: "loading", label: "At loading" }, { value: "dispatch", label: "Before it leaves" }] },
      },
      {
        key: "maxConsignmentsPerTrip", title: "Most consignments on one trip",
        description: "0 means no limit. 1 suits a company whose trucks always carry one load: the trip screens then have no “Add consignment”.",
        control: { kind: "number", unit: "consignments", step: 1, min: 0, max: 1000 },
      },
      {
        key: "defaultConsignmentTypeId", title: "Type of a new consignment",
        description: "Chosen first on a new consignment when the trip type doesn't name one. The type sets the cargo kind, whether it may have several pickups or drops, and the papers it needs.",
        control: { kind: "consignment-type" },
      },
      {
        key: "consignorDefault", title: "Consignor of a new consignment",
        description: "The customer: the consignor starts as the trip's customer, which is right when the customer ships its own goods. Left empty: it is picked each time.",
        control: { kind: "choice", options: [{ value: "customer", label: "The customer" }, { value: "empty", label: "Left empty" }] },
      },
      {
        key: "consigneeMustBeParty", title: "The consignee must be a saved party",
        description: "Off: a consignee may be only a name and a phone number, typed on the consignment. On: it must be picked from Parties.",
        control: { kind: "switch" },
      },
      {
        key: "consigneePhoneRequired", title: "The consignee's phone number is required",
        description: "A consignment can't be saved without a number to call at the drop.",
        control: { kind: "switch" },
      },
      {
        key: "createPlacesFromAddresses", title: "A delivery address becomes a place",
        description: "When a drop is a party's address rather than a saved place, a place is made for it, so distances and the map work.",
        control: { kind: "switch" },
      },
      {
        key: "duplicateCheck", title: "A consignment that looks like another",
        description: "The same consignor, consignee and product on the same day. Warn: the person is asked to confirm. Refuse: it can't be saved.",
        control: { kind: "choice", options: [{ value: "warn", label: "Warn" }, { value: "refuse", label: "Refuse" }, { value: "off", label: "Allow" }] },
      },
      {
        key: "bookWithoutTrip", title: "Book consignments before a truck is chosen",
        description: "Consignments can be taken as orders and put on a trip later. The Consignments list then has an Unassigned tab.",
        control: { kind: "switch" },
      },
    ],
  },
  {
    title: "Stops and loading",
    description: "How a trip's stops follow its consignments, and what holds a truck at a stop.",
    settings: [
      {
        key: "stopsEditableOnRoad", title: "Stops can change after the trip leaves",
        description: "A stop can be added or the order changed for stops the truck hasn't reached. Off: the stops are fixed once the trip leaves.",
        control: { kind: "switch" },
      },
      {
        key: "lateSplit", title: "Drops decided on the road",
        description: "A drop may be left “to be confirmed” at booking and split between places later, for example after the border. By type: only for consignment types that allow it.",
        control: { kind: "choice", options: [{ value: "by_type", label: "By consignment type" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }] },
      },
      {
        key: "leaveStopRequires", title: "The truck can leave a stop when",
        description: "Every consignment planned there has its quantities recorded, and the papers its type requires are in. With neither, nothing holds the truck.",
        control: { kind: "chips", options: [{ value: "lines", label: "Quantities are recorded" }, { value: "required_documents", label: "Required papers are in" }] },
      },
      {
        key: "capacityCheck", title: "Loading more than the truck carries",
        description: "Measured on board along the route, by weight against the truck's payload and the trailer's limit, and by volume against the trailer's litres. Refuse: only someone allowed to override can record it.",
        control: { kind: "choice", options: [{ value: "refuse", label: "Refuse" }, { value: "warn", label: "Warn" }, { value: "off", label: "Don't check" }] },
      },
      {
        key: "capacityTolerancePercent", title: "Overload allowed",
        description: "How far over the limit a load may go before the check above applies.",
        control: { kind: "number", unit: "%", step: 0.5, min: 0, max: 50 },
      },
      {
        key: "tripsWithoutCargo", title: "A trip may end with nothing loaded",
        description: "For moving an empty truck to where its next load is. Off: a trip can't be closed without a consignment.",
        control: { kind: "switch" },
      },
      {
        key: "podPerStopAllowed", title: "One signed sheet for every drop at a stop",
        description: "A courier's manifest: one proof of delivery covers all the consignments dropped at that stop.",
        control: { kind: "switch" },
      },
      {
        key: "notifyConsignee", title: "Message the consignee",
        description: "The consignee's number gets the truck's arrival and the delivery, through the company's message settings.",
        control: { kind: "switch" },
      },
      {
        key: "ewayBillWarnHours", title: "Warn before an e-way bill or permit runs out",
        description: "0 means no warning. The trip shows it, and the notice goes to whoever the company's notices name.",
        control: { kind: "number", unit: "hours", step: 1, min: 0, max: 720 },
      },
    ],
  },
  {
    title: "Revenue",
    description: "How a consignment is priced when its tariff doesn't say. A tariff's own choice always wins.",
    settings: [
      {
        key: "consignmentRateRequired", title: "A consignment needs its price",
        description: "Later: it can be priced any time before invoicing. At booking, or at loading: it can't be saved, or loaded, while it has no tariff or typed price.",
        control: { kind: "choice", options: [{ value: "later", label: "Later" }, { value: "at_booking", label: "At booking" }, { value: "at_loading", label: "At loading" }] },
      },
      {
        key: "chargeOnDefault", title: "Quantity charged",
        description: "Which quantity a rate per litre, tonne or piece is charged on. Until the last drop, the loaded quantity stands in for the delivered one as an estimate.",
        control: { kind: "choice", options: [{ value: "loaded", label: "Loaded" }, { value: "delivered", label: "Delivered" }, { value: "planned", label: "Planned" }, { value: "greater_of", label: "The greater" }, { value: "lesser_of", label: "The lesser" }] },
      },
      {
        key: "priceOnDefault", title: "Priced on the day of",
        description: "Which day's tariff and exchange rate apply, when a tariff changes or a trip straddles a month.",
        control: { kind: "choice", options: [{ value: "pickup_date", label: "Loading" }, { value: "delivery_date", label: "Delivery" }, { value: "booking_date", label: "Booking" }, { value: "trip_dispatch", label: "The trip leaving" }] },
      },
      {
        key: "distanceSourceDefault", title: "Distance charged per km",
        description: "Lead distance: from the consignment's own first pickup to its last drop, or the route's figure when one matches. Loaded km: the whole trip from its first loading to its last offloading. Typed: what the office enters on the consignment.",
        control: { kind: "choice", options: [{ value: "route_lead", label: "Lead distance" }, { value: "trip_loaded_km", label: "Trip's loaded km" }, { value: "manual", label: "Typed" }] },
      },
      {
        key: "shortageDeductionDefault", title: "Shortage on the customer's bill",
        description: "Whether the customer pays less freight for goods lost on the way. Beyond the allowance: only the loss above the shortage allowance. This is apart from what the driver pays.",
        control: { kind: "choice", options: [{ value: "none", label: "Not deducted" }, { value: "beyond_allowance", label: "Beyond the allowance" }, { value: "all", label: "All of it" }] },
      },
      {
        key: "shortageScopeDefault", title: "Shortage worked out",
        description: "On the consignment's totals, or at each drop on its own.",
        control: { kind: "choice", options: [{ value: "consignment", label: "Per consignment" }, { value: "drop", label: "Per drop" }] },
      },
      {
        key: "detentionShare", title: "Waiting at a stop shared by several consignments",
        description: "Each: every consignment whose tariff charges waiting pays for the whole wait. Split: the hours are shared between them.",
        control: { kind: "choice", options: [{ value: "each", label: "Each pays in full" }, { value: "split", label: "Split between them" }] },
      },
      {
        key: "costShareBy", title: "A trip's passed-on cost is shared by",
        description: "How a toll or another trip cost charged on to customers is divided between the trip's consignments.",
        control: { kind: "choice", options: [{ value: "weight", label: "Weight" }, { value: "revenue", label: "Revenue" }, { value: "equal", label: "Equally" }, { value: "km", label: "Distance" }] },
      },
      {
        key: "manualPriceNeedsReason", title: "A typed price needs a reason",
        description: "Someone who sets a price by hand instead of a tariff must say why. It is kept with the price.",
        control: { kind: "switch" },
      },
      {
        key: "freezeOn", title: "A price stops changing",
        description: "Until then it is worked out again whenever a quantity, a stop or the tariff changes. After it, changing it needs “Reopen pricing”.",
        control: { kind: "choice", options: [{ value: "invoice_or_settlement", label: "When invoiced or the trip is settled" }, { value: "delivery", label: "When delivered" }, { value: "manual", label: "Only when someone freezes it" }] },
      },
      {
        key: "invoiceWithoutPod", title: "Invoice before the proof of delivery is in",
        description: "Off: Billing waits for the consignment's proof of delivery.",
        control: { kind: "switch" },
      },
    ],
  },
  {
    title: "Profit",
    description: "What counts against a trip's revenue, for the people allowed to see profit.",
    settings: [
      {
        key: "profitCosts", title: "Costs counted",
        description: "Fuel used, approved expenses, cost charges such as a broker's commission, losses the company carries, what is recovered from the driver, other costs typed on the trip, and the company's overhead.",
        control: {
          kind: "chips", options: [
            { value: "fuel", label: "Fuel" }, { value: "expenses", label: "Expenses" }, { value: "charges", label: "Cost charges" }, { value: "losses", label: "Losses" },
            { value: "recovered", label: "Recovered from the driver" }, { value: "other", label: "Other costs" }, { value: "overhead", label: "Overhead" },
          ],
        },
      },
      {
        key: "defaultFuelPricePerLMinor", title: "Fuel price when none is known",
        description: "Used for a litre whose fuel issue has no price and no fuel price covers. Empty: that fuel is left out and the trip says so.",
        control: { kind: "money", per: "L" },
      },
      {
        key: "overheadPerKmMinor", title: "Overhead per km",
        description: "The company's fixed costs spread over the distance driven, when Overhead is counted.",
        control: { kind: "money", per: "km" },
      },
      {
        key: "overheadPerDayMinor", title: "Overhead per day",
        description: "The same, per day the truck is on the trip.",
        control: { kind: "money", per: "day" },
      },
      {
        key: "transferRevenueSplit", title: "A consignment moved to another truck earns for",
        description: "Which trip counts its revenue: the one that delivers it, the one it started on, or each by the distance it carried it.",
        control: { kind: "choice", options: [{ value: "delivering_trip", label: "The delivering trip" }, { value: "first_trip", label: "The first trip" }, { value: "by_km", label: "Each by distance" }] },
      },
      {
        key: "showProfitOnTripList", title: "Revenue and profit on the trips list",
        description: "Two columns on the trips table, for the people allowed to see profit.",
        control: { kind: "switch" },
      },
    ],
  },
];

const SETTINGS = new Map(SECTIONS.flatMap((s) => s.settings).map((s) => [s.key, s] as const));
const MONEY_KEYS = [...SETTINGS.values()].filter((s) => s.control.kind === "money").map((s) => s.key);

/** The value as the form holds it: money in major units, as typed. */
function toForm(effective: Rec, minorUnits: number): Rec {
  const out: Rec = { ...effective };
  for (const key of MONEY_KEYS) out[key] = effective[key] == null ? "" : String(Number(effective[key]) / 10 ** minorUnits);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function FreightSettings() {
  const { me, toast } = useApp();
  const client = useQueryClient();
  const writable = can(me, "company", "update");
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Rec>("/company") });
  const types = useQuery({ queryKey: ["consignment-types-active"], queryFn: () => api<Rec[]>("/consignment-types", { query: { limit: 100, status: "active" } }).catch(() => []) });
  const currencies = useQuery({ queryKey: ["company-currencies"], queryFn: () => api<Rec[]>("/currencies", { query: { limit: 100, status: "active" } }) });
  const base = (currencies.data ?? []).find((c) => c.id === company.data?.baseCurrencyId);
  const minorUnits = Number(base?.minorUnits ?? 2);
  // What applies now: the company's own choice, else the default. Older servers send only what is stored.
  const effective = useMemo(() => (company.data?.effectiveFreight ?? company.data?.freight ?? {}) as Rec, [company.data]);
  const notBuilt = new Set((company.data?.freightNotBuilt ?? []) as string[]);
  const notBuiltValues = (company.data?.freightNotBuiltValues ?? {}) as Record<string, string[]>;
  const saved = useMemo(() => toForm(effective, minorUnits), [effective, minorUnits]);
  const [form, setForm] = useState<Rec>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(saved), [saved]);
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const changed = [...SETTINGS.keys()].filter((k) => !same(form[k], saved[k]));
  const dirty = changed.length > 0;

  if (company.isLoading) return <p className="muted">Loading the company…</p>;
  if (company.error) return <Empty title="Could not load the company">{(company.error as Error).message}</Empty>;

  const save = async () => {
    setBusy(true);
    try {
      const freight: Rec = {};
      for (const key of changed) {
        const kind = SETTINGS.get(key)?.control.kind;
        if (!kind) continue;
        const v = form[key];
        const empty = String(v ?? "").trim() === "";
        // Money is typed in the currency and saved in minor units. An empty box puts the default back.
        freight[key] = kind === "money" ? (empty ? null : Math.round(Number(v) * 10 ** minorUnits))
          : kind === "number" ? (empty ? null : Number(v))
          : kind === "consignment-type" ? (empty ? null : v)
          : v;
      }
      await api("/company", { method: "PUT", body: { version: company.data!.version, freight } });
      toast("Freight settings saved.");
      await client.invalidateQueries({ queryKey: ["company"] });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const notBuiltTag = <Status tone="mute">Not built yet</Status>;
  const optionLabel = (key: string, o: Option) => (notBuiltValues[key]?.includes(o.value) ? `${o.label} (not built yet)` : o.label);

  const control = (s: Setting) => {
    const c = s.control;
    const id = `fr-${s.key}`;
    switch (c.kind) {
      case "switch":
        return <Switch label={s.title} checked={Boolean(form[s.key])} onChange={(on) => set(s.key, on)} disabled={!writable} />;
      case "choice":
        return <Segmented choice label={s.title} value={String(form[s.key] ?? "")} disabled={!writable} options={c.options.map((o) => ({ value: o.value, label: optionLabel(s.key, o) }))} onChange={(v) => set(s.key, v)} />;
      case "select":
        return (
          <select id={id} className="input" value={String(form[s.key] ?? "")} onChange={(e) => set(s.key, e.target.value)}>
            {c.options.map((o) => <option key={o.value} value={o.value}>{optionLabel(s.key, o)}</option>)}
          </select>
        );
      case "chips": {
        const value = (form[s.key] ?? []) as string[];
        return <ChoiceChips label={s.title} disabled={!writable} options={c.options.map((o) => ({ value: o.value, label: optionLabel(s.key, o) }))} value={value} onChange={(v) => set(s.key, v)} />;
      }
      case "number":
        return <UnitInput label={s.title} unit={c.unit} step={c.step} value={String(form[s.key] ?? "")} disabled={!writable} onChange={(v) => set(s.key, v)} />;
      case "money":
        return <UnitInput label={s.title} unit={`${base?.code ?? ""} per ${c.per}`.trim()} step={1 / 10 ** minorUnits} value={String(form[s.key] ?? "")} disabled={!writable} onChange={(v) => set(s.key, v)} />;
      case "consignment-type":
        return (
          <select id={id} className="input" value={String(form[s.key] ?? "")} disabled={!writable} onChange={(e) => set(s.key, e.target.value)}>
            <option value="">The trip type's, else the first</option>
            {(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{String(t.name)}</option>)}
          </select>
        );
    }
  };

  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Freight</h2>
          <p>With every setting here left as it is, a trip carries one consignment from its loading point to its offloading point, as before.</p>
        </div>
      </header>
      <fieldset className="company-form settings-page" disabled={!writable}>
        {SECTIONS.map((section) => (
          <SettingsSection key={section.title} title={section.title} description={section.description}>
            {section.settings.map((s) => (
              <SettingRow key={s.key} title={<>{s.title}{notBuilt.has(s.key) && <> {notBuiltTag}</>}</>} description={s.description}
                htmlFor={s.control.kind === "select" || s.control.kind === "consignment-type" ? `fr-${s.key}` : undefined}>
                {control(s)}
              </SettingRow>
            ))}
          </SettingsSection>
        ))}
      </fieldset>
      {writable && <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => setForm(saved)} />}
    </div>
  );
}
