import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, Plus } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Empty, Field, FieldGroup, SaveBar, Segmented, Status, Switch, UnitInput } from "../ui/kit";
import { RefName, RefSelect } from "./MastersScreen";
import { calendarDate, num } from "../ui/format";

/**
 * The tariff editor (#135, consignments design 3.11.9): a full-width page in the masters console, because a tariff's
 * charge lines don't fit a drawer. Who it applies to, how it is charged, its numbered charge lines (slabs, a
 * condition, a formula), and "Try it", which prices sample figures or a real consignment with the revenue engine
 * before anything is saved. Saving runs the server's `checkTariff`; its problems come back line by line.
 */

type Def = Rec;
type Money = { amountMinor: number; currencyId: string };
type Slab = { upTo?: number | null; price: Money };
type Line = {
  _id?: string; key: string; chargeTypeId: string; description?: string; basis: string; price?: Money; slabs?: Slab[]; slabMode?: string;
  percent?: number; when?: string; formula?: string; perLine?: boolean; freeQty?: number; minimum?: Money; maximum?: Money; taxRatePercent?: number;
};
type Basis = { value: string; label: string; sentence?: string; price: "price" | "percent" | "formula" | "none"; priceOptional?: boolean; free: boolean };
type Variable = { name: string; meaning?: string; help?: string; kind: string };

const CONDITIONS: { key: string; label: string; target: string }[] = [
  { key: "customerId", label: "Customer", target: "parties" },
  { key: "consignorPartyId", label: "Consignor", target: "parties" },
  { key: "consignmentTypeId", label: "Consignment type", target: "consignment-types" },
  { key: "routeId", label: "Route", target: "routes" },
  { key: "fromPlaceId", label: "From place", target: "places" },
  { key: "toPlaceId", label: "To place", target: "places" },
  { key: "fromCountryId", label: "From country", target: "countries" },
  { key: "toCountryId", label: "To country", target: "countries" },
  { key: "productId", label: "Product", target: "products" },
  { key: "productGroupId", label: "Product group", target: "product-groups" },
  { key: "vehicleTypeId", label: "Vehicle type", target: "vehicle-types" },
];
const DEFAULT = { value: "", label: "Default" };
const CHARGE_ON = [DEFAULT, { value: "loaded", label: "Loaded quantity" }, { value: "delivered", label: "Delivered quantity" }, { value: "planned", label: "Planned quantity" }, { value: "greater_of", label: "The greater of loaded and delivered" }, { value: "lesser_of", label: "The lesser of loaded and delivered" }];
const PRICE_ON = [DEFAULT, { value: "pickup_date", label: "The day it was loaded" }, { value: "delivery_date", label: "The day it was delivered" }, { value: "booking_date", label: "The day it was booked" }, { value: "trip_dispatch", label: "The day the truck left" }];
const DISTANCE = [{ value: "route_lead", label: "Lead" }, { value: "trip_loaded_km", label: "Loaded km" }, { value: "manual", label: "Typed" }, DEFAULT];
const SHORTAGE = [{ value: "none", label: "None" }, { value: "beyond_allowance", label: "Beyond allowance" }, { value: "all", label: "All" }, DEFAULT];
const NUMBERS = ["shortageAllowancePercent", "taxRatePercent", "volumetricDivisorKgPerM3", "minimumChargeableKg", "roundQtyUpTo", "priority"] as const;
const CHOICES = ["priceOn", "chargeOn", "distanceSource", "shortageDeduction"] as const;

let lineKeys = 0;
const newKey = () => `l${++lineKeys}`;

/** What the editor holds: text boxes as typed, money in minor units of the tariff's currency. */
function formFrom(t: Rec | undefined): Rec {
  return {
    code: t?.code ?? "", name: t?.name ?? "", description: t?.description ?? "", currencyId: t?.currencyId ?? "",
    validFrom: t?.validFrom ? String(t.validFrom).slice(0, 10) : "", validTo: t?.validTo ? String(t.validTo).slice(0, 10) : "",
    ...Object.fromEntries(CONDITIONS.map((c) => [c.key, t?.[c.key] ?? ""])),
    ...Object.fromEntries(CHOICES.map((k) => [k, t?.[k] ?? ""])),
    ...Object.fromEntries(NUMBERS.map((k) => [k, t?.[k] ?? ""])),
    minimumCharge: t?.minimumCharge?.amountMinor ?? "",
    lines: ((t?.lines ?? []) as Rec[]).map((l) => ({ ...l, key: newKey(), _id: l._id ?? l.id })),
  };
}

/** The body the master's create and update schemas take: empty boxes are left out, money carries the tariff's currency. */
function bodyFrom(form: Rec, editing: boolean): Rec {
  const cur = String(form.currencyId);
  const money = (minor: unknown) => (minor === "" || minor === undefined || minor === null ? undefined : { amountMinor: Math.round(Number(minor)), currencyId: cur });
  const out: Rec = { code: String(form.code).trim(), name: String(form.name).trim(), currencyId: cur };
  // On an edit an emptied box clears the value (null); on a new tariff it is simply left out.
  const put = (key: string, v: unknown) => { if (v === "" || v === undefined || v === null) { if (editing) out[key] = null; } else out[key] = v; };
  put("description", String(form.description).trim());
  put("validFrom", form.validFrom);
  put("validTo", form.validTo);
  for (const c of CONDITIONS) put(c.key, form[c.key]);
  for (const k of CHOICES) put(k, form[k]);
  for (const k of NUMBERS) put(k, form[k] === "" ? "" : Number(form[k]));
  put("minimumCharge", money(form.minimumCharge));
  out.lines = (form.lines as Line[]).map((l, i) => {
    const line: Rec = { chargeTypeId: l.chargeTypeId, basis: l.basis, order: (i + 1) * 10 };
    if (l._id) line._id = l._id;
    if (l.description?.trim()) line.description = l.description.trim();
    if (l.price) line.price = { amountMinor: l.price.amountMinor, currencyId: cur };
    if (l.slabs?.length) { line.slabs = l.slabs.map((s) => ({ ...(s.upTo === null || s.upTo === undefined ? {} : { upTo: s.upTo }), price: { amountMinor: s.price.amountMinor, currencyId: cur } })); line.slabMode = l.slabMode ?? "progressive"; }
    for (const k of ["percent", "freeQty", "taxRatePercent"] as const) if (l[k] !== undefined && l[k] !== null && String(l[k]) !== "") line[k] = Number(l[k]);
    if (l.when?.trim()) line.when = l.when.trim();
    if (l.formula?.trim()) line.formula = l.formula.trim();
    if (l.perLine) line.perLine = true;
    if (l.minimum) line.minimum = { amountMinor: l.minimum.amountMinor, currencyId: cur };
    if (l.maximum) line.maximum = { amountMinor: l.maximum.amountMinor, currencyId: cur };
    return line;
  });
  return out;
}

export function TariffEditor({ def, defs, id, onClose }: { def: Def; defs: Def[]; id?: string; onClose: () => void }) {
  const { me, toast, data } = useApp();
  const client = useQueryClient();
  const record = useQuery({ queryKey: ["record", "tariffs", id], queryFn: () => api<Rec>(`/tariffs/${id}`), enabled: Boolean(id) });
  const chargeTypes = useQuery({ queryKey: ["options-full", "charge-types"], queryFn: () => api<Rec[]>("/charge-types", { query: { status: "active", limit: 100 } }) });
  const reference = useQuery({ queryKey: ["freight-formula-variables"], queryFn: () => api<Rec>("/freight/formula/variables").catch(() => null), staleTime: 10 * 60_000 });
  const saved = useMemo(() => formFrom(id ? record.data : undefined), [id, record.data]);
  const [form, setForm] = useState<Rec>(saved);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => { setForm(saved); setProblems([]); }, [saved]);
  const writable = id ? Boolean(def.permissions?.update) && record.data?.status !== "archived" : Boolean(def.permissions?.create);
  const dirty = JSON.stringify(bodyFrom(form, Boolean(id))) !== JSON.stringify(bodyFrom(saved, Boolean(id)));
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const lines = form.lines as Line[];
  const setLines = (next: Line[]) => set("lines", next);
  const currency = (data.currencies ?? []).find((c: Rec) => c.id === form.currencyId) as Rec | undefined;
  const units = 10 ** Number(currency?.minorUnits ?? 2);
  const code = String(currency?.code ?? "");

  // Rate bases as the server describes them; a server without the list still offers the master's choices.
  const basisField = (def.fields as Rec[]).find((f) => f.path === "lines.basis");
  const bases: Basis[] = useMemo(() => {
    const fromServer = reference.data?.bases as Basis[] | undefined;
    if (fromServer?.length) return fromServer;
    return ((basisField?.enum ?? []) as string[]).map((value) => ({
      value, label: String((basisField?.choiceLabels as Rec | undefined)?.[value] ?? value),
      price: value.startsWith("percent_") ? "percent" : value === "formula" ? "formula" : "price", free: value === "per_drop_beyond" || value === "per_pickup_beyond",
    }));
  }, [reference.data, basisField]);
  const variables = (reference.data?.variables ?? []) as Variable[];

  if (id && record.isLoading) return <p className="muted">Loading the tariff…</p>;
  if (id && record.error) return <Empty title="Could not load the tariff">{(record.error as Error).message}</Empty>;

  const save = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const body = bodyFrom(form, Boolean(id));
      const result = id
        ? await api<Rec>(`/tariffs/${id}`, { method: "PATCH", body: { ...body, version: record.data!.version } })
        : await api<Rec>("/tariffs", { method: "POST", body });
      toast(id ? "Tariff saved." : "Tariff added.");
      await client.invalidateQueries({ queryKey: ["records", "tariffs"] });
      await client.invalidateQueries({ queryKey: ["record", "tariffs", id ?? result.id] });
      if (!id) onClose();
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as Rec | undefined) : undefined;
      const listed = [...((details?.lines as string[] | undefined) ?? []), ...Object.entries(details ?? {}).filter(([k]) => k !== "lines").map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : String(v)}`)];
      setProblems(listed);
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };

  const status = String(record.data?.status ?? "active");
  return (
    <div className="desk tariff-editor">
      <button className="link-btn tariff-back" onClick={onClose}><ChevronLeft size={16} /> All tariffs</button>
      <header className="masters-head">
        <div className="masters-title">
          <h2>{String(form.name || (id ? "Tariff" : "New tariff"))}</h2>
          {id && <p className="tariff-ids"><span className="mono">{String(record.data?.code ?? "")}</span> · <Status tone={status === "active" ? "ok" : status === "archived" ? "mute" : "wait"}>{status === "active" ? "Active" : status === "archived" ? "Archived" : "Inactive"}</Status></p>}
        </div>
      </header>

      <fieldset className="tariff-form" disabled={!writable}>
        <section className="tariff-section">
          <h3>Name</h3>
          <div className="grid-2">
            <Field label="Code"><input className="input mono" value={String(form.code)} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="PUMA-DAR-ZM" /></Field>
            <Field label="Name"><input className="input" value={String(form.name)} onChange={(e) => set("name", e.target.value)} placeholder="Puma Energy, Dar es Salaam to Zambia" /></Field>
          </div>
        </section>

        <section className="tariff-section">
          <h3>Applies to</h3>
          <p className="muted">Each empty choice means any. The most specific tariff that fits a consignment prices it: a customer and route beat a customer alone.</p>
          <div className="grid-2">
            {CONDITIONS.map((c) => (
              <Field key={c.key} label={c.label}>
                <RefSelect target={c.target} defs={defs} value={String(form[c.key] ?? "")} onChange={(v: unknown) => set(c.key, v ?? "")} disabled={!writable}
                  {...(c.key === "customerId" ? { partyRoles: ["customer"] } : {})} />
              </Field>
            ))}
            <Field label="Valid from"><input className="input" type="date" value={String(form.validFrom)} onChange={(e) => set("validFrom", e.target.value)} /></Field>
            <Field label="Valid until"><input className="input" type="date" value={String(form.validTo)} onChange={(e) => set("validTo", e.target.value)} /></Field>
            <Field label="Priority" hint="Breaks a tie between two equally specific tariffs: the higher number wins.">
              <input className="input" type="number" step={1} value={String(form.priority ?? "")} onChange={(e) => set("priority", e.target.value)} />
            </Field>
          </div>
          <p className="tariff-sentence">{appliesSentence(form, defs)}</p>
        </section>

        <section className="tariff-section">
          <h3>How it is charged</h3>
          <div className="tariff-rows">
            <Row title="Currency" description="Every price, slab and minimum on this tariff is in it.">
              <select className="input" aria-label="Currency" value={String(form.currencyId)} onChange={(e) => set("currencyId", e.target.value)}>
                <option value="">Choose…</option>
                {(data.currencies ?? []).filter((c: Rec) => c.status !== "archived").map((c: Rec) => <option key={c.id} value={c.id}>{c.name ? `${c.code} · ${c.name}` : c.code}</option>)}
              </select>
            </Row>
            <Row title="Charged on" description="Which quantity a rate per litre, tonne or piece is charged on. The company's default is set under Freight.">
              <select className="input" aria-label="Charged on" value={String(form.chargeOn)} onChange={(e) => set("chargeOn", e.target.value)}>
                {CHARGE_ON.map((o) => <option key={o.value} value={o.value}>{o.value ? o.label : "The company's default"}</option>)}
              </select>
            </Row>
            <Row title="Priced on the day of" description="Which day decides that this tariff applies, and the exchange rate.">
              <select className="input" aria-label="Priced on the day of" value={String(form.priceOn)} onChange={(e) => set("priceOn", e.target.value)}>
                {PRICE_ON.map((o) => <option key={o.value} value={o.value}>{o.value ? o.label : "The company's default"}</option>)}
              </select>
            </Row>
            <Row title="Distance from" description="For per-km and tonne-km lines. Lead: from the consignment's first pickup to its last drop. Loaded km: the trip's first loading to its last offloading. Typed: entered on the consignment.">
              <Segmented choice label="Distance from" value={String(form.distanceSource)} options={DISTANCE} onChange={(v) => set("distanceSource", v)} disabled={!writable} />
            </Row>
            <Row title="Chargeable weight" description="For lines per kg (and per tonne when a divisor is set): the greatest of the actual weight, the volume × the divisor, and the least kg charged, rounded up.">
              <span className="tariff-trio">
                <Field label="Kg per m³"><UnitInput label="Volumetric kg per m³" unit="kg/m³" step={1} value={String(form.volumetricDivisorKgPerM3 ?? "")} onChange={(v) => set("volumetricDivisorKgPerM3", v)} disabled={!writable} /></Field>
                <Field label="At least"><UnitInput label="Least kg charged" unit="kg" step={1} value={String(form.minimumChargeableKg ?? "")} onChange={(v) => set("minimumChargeableKg", v)} disabled={!writable} /></Field>
                <Field label="Rounded up to"><UnitInput label="Round kg up to" unit="kg" step={1} value={String(form.roundQtyUpTo ?? "")} onChange={(v) => set("roundQtyUpTo", v)} disabled={!writable} /></Field>
              </span>
            </Row>
            <Row title="Shortage on the customer's bill" description="What the customer deducts for goods lost on the way, apart from what the driver pays. Allowance empty: the product's allowance.">
              <span className="tariff-stack">
                <Segmented choice label="Shortage on the customer's bill" value={String(form.shortageDeduction)} options={SHORTAGE} onChange={(v) => set("shortageDeduction", v)} disabled={!writable} />
                {form.shortageDeduction === "beyond_allowance" && <UnitInput label="Allowance" unit="%" step={0.01} value={String(form.shortageAllowancePercent ?? "")} onChange={(v) => set("shortageAllowancePercent", v)} disabled={!writable} />}
              </span>
            </Row>
            <Row title="VAT" description="On every line, unless a line says otherwise. Empty: Money settings.">
              <UnitInput label="VAT" unit="%" step={0.5} value={String(form.taxRatePercent ?? "")} onChange={(v) => set("taxRatePercent", v)} disabled={!writable} />
            </Row>
            <Row title="Minimum charge" description="The least the freight comes to. A smaller figure is topped up with a Minimum charge line.">
              <MoneyBox label="Minimum charge" code={code} units={units} value={form.minimumCharge === "" ? undefined : Number(form.minimumCharge)} onChange={(m) => set("minimumCharge", m ?? "")} disabled={!writable} />
            </Row>
          </div>
        </section>

        <section className="tariff-section">
          <h3>Charge lines</h3>
          <p className="muted">Worked out in this order. A percentage of freight counts the freight lines above it.</p>
          <div className="form-group item-list">
            {!lines.length && <p className="muted">None yet. A tariff needs at least one line.</p>}
            {lines.map((line, i) => (
              <LineCard key={line.key} n={i + 1} line={line} bases={bases} variables={variables} chargeTypes={chargeTypes.data ?? []} code={code} units={units} disabled={!writable}
                onChange={(next) => setLines(lines.map((l) => (l.key === line.key ? next : l)))}
                onRemove={() => setLines(lines.filter((l) => l.key !== line.key))}
                onMove={(by) => { const j = i + by; if (j < 0 || j >= lines.length) return; const next = [...lines]; [next[i], next[j]] = [next[j]!, next[i]!]; setLines(next); }}
                first={i === 0} last={i === lines.length - 1} />
            ))}
            {writable && (
              <div>
                <Button size="sm" onClick={() => setLines([...lines, { key: newKey(), chargeTypeId: String((chargeTypes.data ?? []).find((c) => c.kind === "freight")?.id ?? ""), basis: lines.length ? "per_consignment" : "per_tonne" }])}>
                  <Plus size={14} /> Add a line
                </Button>
              </div>
            )}
          </div>
        </section>

        {problems.length > 0 && (
          <div className="tariff-problems" role="alert">
            <strong>The tariff can't be saved yet</strong>
            <ul className="plain">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
      </fieldset>

      {can(me, "tariffs", "read") && <TryIt body={bodyFrom(form, false)} ready={Boolean(form.currencyId && lines.length)} code={code} units={units} />}
      {writable && <SaveBar dirty={dirty || !id} busy={busy} onSave={() => void save()} onDiscard={() => (id ? setForm(saved) : onClose())} />}
    </div>
  );
}

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text"><span className="setting-title">{title}</span>{description && <p>{description}</p>}</div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Money typed in the tariff's currency, kept in minor units. */
function MoneyBox({ label, code, units, value, onChange, disabled }: { label: string; code: string; units: number; value?: number; onChange: (minor: number | undefined) => void; disabled?: boolean }) {
  return (
    <UnitInput label={label} unit={code || "—"} step={1 / units} disabled={disabled} value={value === undefined ? "" : String(value / units)}
      onChange={(v) => onChange(v === "" ? undefined : Math.round(Number(v) * units * 1e4) / 1e4)} />
  );
}

/** "Applies to Puma Energy, any consignor, diesel, Dar es Salaam → any place, from 1 Nov 2026." */
function appliesSentence(form: Rec, defs: Def[]): ReactNode {
  const name = (key: string, target: string, any: string) => (form[key] ? <RefName target={target} id={String(form[key])} defs={defs} /> : any);
  const parts: ReactNode[] = [
    name("customerId", "parties", "every customer"),
    form.consignorPartyId ? <>consignor {name("consignorPartyId", "parties", "")}</> : null,
    form.productId ? name("productId", "products", "") : form.productGroupId ? name("productGroupId", "product-groups", "") : "any goods",
    form.consignmentTypeId ? name("consignmentTypeId", "consignment-types", "") : null,
    form.routeId ? <>route {name("routeId", "routes", "")}</>
      : (form.fromPlaceId || form.toPlaceId || form.fromCountryId || form.toCountryId)
        ? <>{form.fromPlaceId ? name("fromPlaceId", "places", "") : form.fromCountryId ? <>anywhere in {name("fromCountryId", "countries", "")}</> : "anywhere"} → {form.toPlaceId ? name("toPlaceId", "places", "") : form.toCountryId ? <>anywhere in {name("toCountryId", "countries", "")}</> : "anywhere"}</>
        : "any route",
    form.vehicleTypeId ? <>on {name("vehicleTypeId", "vehicle-types", "")}</> : null,
  ].filter(Boolean);
  const d = (v: unknown) => calendarDate(String(v));
  const dates = form.validFrom && form.validTo ? `, from ${d(form.validFrom)} to ${d(form.validTo)}` : form.validFrom ? `, from ${d(form.validFrom)}` : form.validTo ? `, until ${d(form.validTo)}` : "";
  return <>Applies to {parts.map((p, i) => <span key={i}>{i ? ", " : ""}{p}</span>)}{dates}.</>;
}

function LineCard({ n, line, bases, variables, chargeTypes, code, units, disabled, onChange, onRemove, onMove, first, last }: {
  n: number; line: Line; bases: Basis[]; variables: Variable[]; chargeTypes: Rec[]; code: string; units: number; disabled: boolean;
  onChange: (l: Line) => void; onRemove: () => void; onMove: (by: number) => void; first: boolean; last: boolean;
}) {
  const basis = bases.find((b) => b.value === line.basis);
  const [showSlabs, setShowSlabs] = useState(Boolean(line.slabs?.length));
  const [showWhen, setShowWhen] = useState(Boolean(line.when));
  const [showVars, setShowVars] = useState(false);
  const up = (patch: Partial<Line>) => onChange({ ...line, ...patch });
  const money = (minor: number | undefined): Money | undefined => (minor === undefined ? undefined : { amountMinor: minor, currencyId: "" });
  const priceKind = basis?.price ?? "price";
  const slabbable = priceKind === "price" && !["per_consignment", "per_trip", "shortage_beyond_allowance", "damage_value"].includes(line.basis);
  return (
    <div className="item-card tariff-line">
      <header>
        <strong>Line {n}</strong>
        {!disabled && (
          <span className="row-actions">
            <Button size="sm" tone="quiet" disabled={first} onClick={() => onMove(-1)}><ArrowUp size={14} /> Up</Button>
            <Button size="sm" tone="quiet" disabled={last} onClick={() => onMove(1)}><ArrowDown size={14} /> Down</Button>
            <Button size="sm" tone="quiet" onClick={onRemove}>Remove</Button>
          </span>
        )}
      </header>
      <div className="tariff-line-grid">
        <Field label="Charge">
          <select className="input" value={line.chargeTypeId} onChange={(e) => up({ chargeTypeId: e.target.value })}>
            <option value="">Choose…</option>
            {chargeTypes.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}{c.direction === "cost" ? " (a cost)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Worked out" hint={basis?.sentence}>
          <select className="input" value={line.basis} onChange={(e) => up({ basis: e.target.value })}>
            {bases.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </Field>
        {priceKind === "percent" && (
          <Field label="Percent"><UnitInput label="Percent" unit="%" step={0.01} value={line.percent ?? ""} onChange={(v) => up({ percent: v === "" ? undefined : Number(v) })} disabled={disabled} /></Field>
        )}
        {(priceKind === "price" || priceKind === "none") && !line.slabs?.length && (
          <Field label={`${priceLabel(basis)}${priceKind === "none" || basis?.priceOptional ? " (optional)" : ""}`} hint={basis?.priceOptional ? "Empty: the product's shortage price, or the goods' declared value." : undefined}>
            <MoneyBox label={priceLabel(basis)} code={code} units={units} value={line.price?.amountMinor} onChange={(m) => up({ price: money(m) })} disabled={disabled} />
          </Field>
        )}
        {basis?.free && (
          <Field label="Free" hint="One free unless set.">
            <UnitInput label="Free" unit={line.basis === "per_pickup_beyond" ? "pickups" : "drops"} step={1} value={line.freeQty ?? ""} onChange={(v) => up({ freeQty: v === "" ? undefined : Number(v) })} disabled={disabled} />
          </Field>
        )}
        <Field label="Description" hint="The words on the bill. Empty: the charge's name.">
          <input className="input" value={line.description ?? ""} onChange={(e) => up({ description: e.target.value })} />
        </Field>
        <Field label="At least"><MoneyBox label="At least" code={code} units={units} value={line.minimum?.amountMinor} onChange={(m) => up({ minimum: money(m) })} disabled={disabled} /></Field>
        <Field label="At most"><MoneyBox label="At most" code={code} units={units} value={line.maximum?.amountMinor} onChange={(m) => up({ maximum: money(m) })} disabled={disabled} /></Field>
        <Field label="VAT" hint="Empty: the tariff's.">
          <UnitInput label="VAT on this line" unit="%" step={0.5} value={line.taxRatePercent ?? ""} onChange={(v) => up({ taxRatePercent: v === "" ? undefined : Number(v) })} disabled={disabled} />
        </Field>
        <FieldGroup label="Per goods line" hint="Worked out once for each product on the consignment, for mixed goods at different rates.">
          <Switch label="Per goods line" checked={Boolean(line.perLine)} onChange={(on) => up({ perLine: on })} disabled={disabled} />
        </FieldGroup>
      </div>

      {priceKind === "formula" && (
        <div className="tariff-formula">
          <Field label="Formula" hint={`The amount in ${code || "the tariff's currency"}, e.g. max(0, 1.80 - 0.03 * floor((1500 - min(km, 1500)) / 100)) * litres20`}>
            <textarea className="input mono" rows={3} spellCheck={false} value={line.formula ?? ""} onChange={(e) => up({ formula: e.target.value })} />
          </Field>
          <button type="button" className="link-btn" onClick={() => setShowVars(!showVars)}>{showVars ? "Hide what a formula can use" : "What a formula can use"}</button>
          {showVars && <Reference variables={variables} />}
        </div>
      )}

      <div className="tariff-line-links">
        {slabbable && <button type="button" className="link-btn" onClick={() => { if (showSlabs && line.slabs?.length) up({ slabs: undefined, slabMode: undefined }); setShowSlabs(!showSlabs); }}>{showSlabs ? "No slabs: one price" : "Slabs"}</button>}
        <button type="button" className="link-btn" onClick={() => { if (showWhen) up({ when: undefined }); setShowWhen(!showWhen); }}>{showWhen ? "Always applies" : "Only when…"}</button>
      </div>

      {showSlabs && slabbable && <Slabs line={line} code={code} units={units} disabled={disabled} onChange={up} unit={basis} />}
      {showWhen && (
        <div className="tariff-when">
          <Field label="Only when" hint='A condition, e.g. packaging = "CONT20", or fuelPrice > 30 and km > 1000.'>
            <input className="input mono" spellCheck={false} value={line.when ?? ""} onChange={(e) => up({ when: e.target.value })} />
          </Field>
          {priceKind !== "formula" && (
            <>
              <button type="button" className="link-btn" onClick={() => setShowVars(!showVars)}>{showVars ? "Hide what a condition can use" : "What a condition can use"}</button>
              {showVars && <Reference variables={variables} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "Price per litre at 20 °C", from the basis's own words where they say per what. */
function priceLabel(basis: Basis | undefined) {
  const per = basis?.label.match(/^Per (.+?)(?: after the free ones)?$/i)?.[1];
  return per ? `Price per ${per.replace(/ \(as measured\)$/, "")}` : "Price";
}

function Slabs({ line, code, units, disabled, onChange, unit }: { line: Line; code: string; units: number; disabled: boolean; onChange: (p: Partial<Line>) => void; unit?: Basis }) {
  const slabs = line.slabs ?? [];
  const set = (next: Slab[]) => onChange({ slabs: next, slabMode: line.slabMode ?? "progressive" });
  return (
    <div className="tariff-slabs">
      <FieldGroup label="Slabs count">
        <Segmented choice label="Slabs count" value={line.slabMode ?? "progressive"} disabled={disabled}
          options={[{ value: "progressive", label: "Each band at its price" }, { value: "whole", label: "All at the band reached" }]} onChange={(v) => onChange({ slabMode: v })} />
      </FieldGroup>
      <div className="table-frame">
        <table className="table">
          <thead><tr><th>Band</th><th>Up to</th><th>{priceLabel(unit)}</th><th /></tr></thead>
          <tbody>
            {slabs.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><UnitInput label={`Band ${i + 1} up to`} unit={s.upTo === null || s.upTo === undefined ? "no limit" : ""} step={1} value={s.upTo ?? ""} disabled={disabled}
                  onChange={(v) => set(slabs.map((x, j) => (j === i ? { ...x, upTo: v === "" ? null : Number(v) } : x)))} /></td>
                <td><MoneyBox label={`Band ${i + 1} price`} code={code} units={units} value={s.price.amountMinor} disabled={disabled}
                  onChange={(m) => set(slabs.map((x, j) => (j === i ? { ...x, price: { amountMinor: m ?? 0, currencyId: "" } } : x)))} /></td>
                <td>{!disabled && <Button size="sm" tone="quiet" onClick={() => set(slabs.filter((_, j) => j !== i))}>Remove</Button>}</td>
              </tr>
            ))}
            {!slabs.length && <tr><td colSpan={4} className="muted">No bands yet. The last band may have no upper limit.</td></tr>}
          </tbody>
        </table>
      </div>
      {!disabled && <div><Button size="sm" onClick={() => set([...slabs, { upTo: null, price: { amountMinor: line.price?.amountMinor ?? 0, currencyId: "" } }])}><Plus size={14} /> Add a band</Button></div>}
    </div>
  );
}

function Reference({ variables }: { variables: Variable[] }) {
  if (!variables.length) return <p className="muted">The list of values isn't available from the server yet.</p>;
  return (
    <dl className="tariff-vars">
      {variables.map((v) => (
        <div key={v.name}><dt className="mono">{v.name}</dt><dd>{v.meaning ?? v.help}{v.kind === "text" ? " (text)" : ""}</dd></div>
      ))}
    </dl>
  );
}

const SAMPLE_FIELDS: { key: string; label: string; unit: string; text?: boolean }[] = [
  { key: "unit", label: "Goods measured in", unit: "", text: true }, { key: "loadedQty", label: "Loaded", unit: "" }, { key: "deliveredQty", label: "Delivered", unit: "" },
  { key: "km", label: "Distance", unit: "km" }, { key: "drops", label: "Drops", unit: "drops" }, { key: "pickups", label: "Pickups", unit: "pickups" },
  { key: "grossKg", label: "Weight", unit: "kg" }, { key: "volumeM3", label: "Volume", unit: "m³" }, { key: "litres20", label: "Litres at 20 °C", unit: "L" },
  { key: "pieces", label: "Pieces", unit: "pieces" }, { key: "declaredValue", label: "Declared value", unit: "" },
];

/** "Try it" (design 3.11.9, step 5): price sample figures or a real consignment against the tariff as it is on screen. */
function TryIt({ body, ready, code, units }: { body: Rec; ready: boolean; code: string; units: number }) {
  const [mode, setMode] = useState<"sample" | "consignment">("sample");
  const [sample, setSample] = useState<Record<string, string>>({ unit: "t", loadedQty: "30", deliveredQty: "29.8", km: "1840", drops: "1" });
  const [search, setSearch] = useState("");
  const [consignmentId, setConsignmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Rec | null>(null);
  const [error, setError] = useState("");
  const found = useQuery({
    queryKey: ["try-consignments", search],
    queryFn: () => api<Rec[]>("/consignments", { query: { q: search.trim() || undefined, limit: 20 } }).catch(() => []),
    enabled: mode === "consignment",
  });
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const figures = Object.fromEntries(Object.entries(sample).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, k === "unit" ? v.trim() : Number(v)]));
      setAnswer(await api<Rec>("/tariffs/try", { method: "POST", body: { tariff: body, ...(mode === "consignment" && consignmentId ? { consignmentId } : { sample: figures }) } }));
    } catch (err) {
      setAnswer(null);
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const result = answer?.result as Rec | null | undefined;
  const money = (minor: unknown) => `${num(Number(minor) / units, 0, 4)} ${code}`;
  return (
    <section className="tariff-section tariff-try">
      <h3>Try it</h3>
      <p className="muted">Prices figures you type, or a consignment, with the tariff as it is on this page. Nothing is saved.</p>
      <Segmented label="Try with" value={mode} options={[{ value: "sample", label: "Figures" }, { value: "consignment", label: "A consignment" }]} onChange={setMode} />
      {mode === "sample" ? (
        <div className="tariff-sample">
          {SAMPLE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              {f.text ? <input className="input" value={sample[f.key] ?? ""} placeholder="L, t, kg, bags" onChange={(e) => setSample((s) => ({ ...s, [f.key]: e.target.value }))} />
                : <UnitInput label={f.label} unit={f.key === "declaredValue" ? code : f.key === "loadedQty" || f.key === "deliveredQty" ? sample.unit ?? "" : f.unit} value={sample[f.key] ?? ""} onChange={(v) => setSample((s) => ({ ...s, [f.key]: v }))} />}
            </Field>
          ))}
        </div>
      ) : (
        <div className="grid-2">
          <Field label="Find a consignment"><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, reference, party or trip" /></Field>
          <Field label="Consignment">
            <select className="input" value={consignmentId} onChange={(e) => setConsignmentId(e.target.value)}>
              <option value="">Choose…</option>
              {(found.data ?? []).map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.number)} · {String((c.consignee as Rec | undefined)?.name ?? "")}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div><Button tone="primary" busy={busy} disabled={!ready || (mode === "consignment" && !consignmentId)} onClick={() => void run()}>Work it out</Button>{!ready && <span className="muted"> Choose a currency and add a line first.</span>}</div>
      {error && <p className="tariff-problems">{error}</p>}
      {answer && ((answer.problems as string[] | undefined) ?? []).length > 0 && (
        <div className="tariff-problems"><strong>Fix these before saving</strong><ul className="plain">{(answer.problems as string[]).map((p) => <li key={p}>{p}</li>)}</ul></div>
      )}
      {result && (
        <div className="tariff-result">
          <p className="tariff-result-line">
            <Status tone={result.status === "priced" ? "ok" : result.status === "unpriced" ? "bad" : "wait"}>{result.status === "priced" ? "Priced" : result.status === "unpriced" ? "Unpriced" : "Estimated"}</Status>
            {result.status !== "unpriced" && <span> Total <b className="num">{money(result.totalMinor)}</b></span>}
          </p>
          {((result.lines as Rec[] | undefined) ?? []).length > 0 && (
            <div className="table-frame">
              <table className="table">
                <thead><tr><th>Charge</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Amount</th><th className="num">Tax</th></tr></thead>
                <tbody>
                  {(result.lines as Rec[]).map((l, i) => (
                    <tr key={i}>
                      <td>{String(l.description)}</td>
                      <td className="num">{l.qty === undefined ? "" : `${num(Number(l.qty), 0, 3)}${l.unit ? ` ${l.unit}` : ""}`}</td>
                      <td className="num">{l.unitPriceMinor === undefined ? "" : money(l.unitPriceMinor)}</td>
                      <td className="num">{money(l.amountMinor)}</td>
                      <td className="num">{money(l.taxMinor ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4>How this was worked out</h4>
          <ol className="tariff-explain">{((result.explanation as string[] | undefined) ?? []).map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      )}
    </section>
  );
}
