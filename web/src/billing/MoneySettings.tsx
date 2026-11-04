import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { SaveBar, Segmented, SettingRow, SettingsSection, Switch, UnitInput } from "../ui/kit";

interface Money { rateBasis: "mid" | "buying" | "selling"; viaPivot: boolean; pivotCurrencyId?: string; pivotCurrencyCode: string | null }
interface Billing {
  taxMode: "none" | "single" | "per_customer_product"; taxRatePercent: number; taxLabel: string; pricesIncludeTax: boolean;
  invoiceFrom: "trip" | "nomination" | "on_demand"; paymentTermsDays: number; billOn: "delivered" | "loaded"; shortageOnInvoice: "deduct" | "none";
  revaluation: "off" | "monthly" | "quarterly"; ageingBucketsDays: number[];
}
interface Settings { money: Money; billing: Billing; version: number }

const BASES = [{ value: "mid", label: "Mid" }, { value: "buying", label: "Buying" }, { value: "selling", label: "Selling" }] as const;
const TAX = [{ value: "none", label: "None" }, { value: "single", label: "One VAT rate" }, { value: "per_customer_product", label: "Per customer and product" }] as const;
const FROM = [{ value: "trip", label: "Each closed trip" }, { value: "nomination", label: "A nomination" }, { value: "on_demand", label: "On demand" }] as const;
const BILL_ON = [{ value: "delivered", label: "Delivered" }, { value: "loaded", label: "Loaded" }] as const;
const REVALUE = [{ value: "off", label: "Off" }, { value: "monthly", label: "Monthly" }, { value: "quarterly", label: "Quarterly" }] as const;

/**
 * Company → Money (#61): which of a day's rates conversions use and whether they go through a pivot currency,
 * and, with Billing on, how customers are invoiced. Every value is the company's choice; the defaults are the first client's.
 */
export function MoneySettings({ billing }: { billing: boolean }) {
  const { me, toast, refreshReference } = useApp();
  const client = useQueryClient();
  const saved = useQuery({ queryKey: ["finance-settings"], queryFn: () => api<Settings>("/finance-settings") });
  const currencies = useQuery({ queryKey: ["money-currencies"], queryFn: () => api<Rec[]>("/currencies", { query: { status: "active", limit: 100 } }) });
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [bucketsText, setBucketsText] = useState("");
  useEffect(() => { if (saved.data) { setForm(saved.data); setBucketsText(saved.data.billing.ageingBucketsDays.join(", ")); } }, [saved.data]);
  if (!saved.data || !form) return null;
  const writable = can(me, "finance-settings", "update");
  const dirty = JSON.stringify(form) !== JSON.stringify(saved.data);
  const setMoney = (patch: Partial<Money>) => setForm({ ...form, money: { ...form.money, ...patch } });
  const setBilling = (patch: Partial<Billing>) => setForm({ ...form, billing: { ...form.billing, ...patch } });
  const save = async () => {
    setBusy(true);
    try {
      const { pivotCurrencyCode: _code, ...money } = form.money;
      const next = await api<Settings>("/finance-settings", { method: "PUT", body: { money: { ...money, pivotCurrencyId: money.pivotCurrencyId ?? null }, ...(billing ? { billing: form.billing } : {}), version: saved.data!.version } });
      client.setQueryData(["finance-settings"], next);
      setForm(next);
      refreshReference();
      toast("Money settings saved");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "That didn't save.", "error");
    } finally {
      setBusy(false);
    }
  };
  const list = currencies.data ?? [];
  const pivotId = form.money.pivotCurrencyId ?? String(list.find((c) => c.code === "USD")?.id ?? "");
  return (
    <>
      <fieldset className="settings-page" disabled={!writable}>
        <SettingsSection title="Converting money" description="Every conversion follows these: invoices and payments, driver advances, expenses and budgets in other currencies.">
          <SettingRow title="Which rate to convert at" description="A day's rate can carry the bank's buying and selling rates as well as the mid rate. A day without the one chosen uses its mid rate.">
            <Segmented choice label="Which rate to convert at" value={form.money.rateBasis} options={[...BASES]} onChange={(v) => setMoney({ rateBasis: v })} disabled={!writable} />
          </SettingRow>
          <SettingRow title="Convert through another currency" description="With no rate between two currencies, go through this one: TZS to ZMW as TZS to USD to ZMW. Off: such a conversion is refused until the rate is added." htmlFor="money-pivot">
            <span className="range-inputs">
              <Switch label="Convert through another currency" checked={form.money.viaPivot} onChange={(on) => setMoney({ viaPivot: on })} />
              <select id="money-pivot" className="input" aria-label="Through" value={pivotId} disabled={!form.money.viaPivot} onChange={(e) => setMoney({ pivotCurrencyId: e.target.value || undefined })}>
                {list.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)}</option>)}
              </select>
            </span>
          </SettingRow>
        </SettingsSection>
        {billing && (
          <SettingsSection title="Invoicing customers" description="Customer rates set the prices; these say when invoices are drafted, what they charge and when they are due.">
            <SettingRow title="Invoice from" description="Each closed trip: closing a trip drafts its invoice. A nomination: one invoice once all its trips are closed. On demand: Finance picks the trips.">
              <Segmented choice label="Invoice from" value={form.billing.invoiceFrom} options={[...FROM]} onChange={(v) => setBilling({ invoiceFrom: v })} disabled={!writable} />
            </SettingRow>
            <SettingRow title="Charge on" description="The quantity a per-tonne or per-litre rate is charged on.">
              <Segmented choice label="Charge on" value={form.billing.billOn} options={[...BILL_ON]} onChange={(v) => setBilling({ billOn: v })} disabled={!writable} />
            </SettingRow>
            <SettingRow title="Take shortages off the invoice" description="A shortage beyond the allowance is deducted from the customer's invoice at the shortage policy's price.">
              <Switch label="Take shortages off the invoice" checked={form.billing.shortageOnInvoice === "deduct"} onChange={(on) => setBilling({ shortageOnInvoice: on ? "deduct" : "none" })} />
            </SettingRow>
            <SettingRow title="Payment terms" description="Days from the invoice date to its due date, for a customer whose record doesn't set its own.">
              <UnitInput label="Payment terms" unit="days" step={1} value={String(form.billing.paymentTermsDays)} onChange={(v) => setBilling({ paymentTermsDays: Number(v) })} />
            </SettingRow>
            <SettingRow title="Tax" description="Per customer and product: each customer rate carries its own VAT rate, and a rate without one uses the rate below.">
              <Segmented choice label="Tax" value={form.billing.taxMode} options={[...TAX]} onChange={(v) => setBilling({ taxMode: v })} disabled={!writable} />
            </SettingRow>
            {form.billing.taxMode !== "none" && (
              <>
                <SettingRow title="VAT rate" description="Charged on every line of an invoice.">
                  <UnitInput label="VAT rate" unit="%" step={0.5} value={String(form.billing.taxRatePercent)} onChange={(v) => setBilling({ taxRatePercent: Number(v) })} />
                </SettingRow>
                <SettingRow title="Prices include tax" description="On: a customer rate is the price with tax, and the invoice shows the tax inside it. Off: tax is added on top.">
                  <Switch label="Prices include tax" checked={form.billing.pricesIncludeTax} onChange={(on) => setBilling({ pricesIncludeTax: on })} />
                </SettingRow>
              </>
            )}
            <SettingRow title="Revalue open invoices" description="At each month's or quarter's end, invoices still owed in another currency are valued at that day's rate, and the unrealised gain or loss is recorded. The next run reverses it first.">
              <Segmented choice label="Revalue open invoices" value={form.billing.revaluation} options={[...REVALUE]} onChange={(v) => setBilling({ revaluation: v })} disabled={!writable} />
            </SettingRow>
            <SettingRow title="Ageing columns" description="Where each column ends, in days past the due date. 30, 60, 90 gives current, 1–30, 31–60, 61–90 and over 90." htmlFor="money-ageing">
              <input id="money-ageing" className="input" value={bucketsText} onChange={(e) => setBucketsText(e.target.value)} onBlur={() => { const days = bucketsText.split(/[\s,]+/).filter(Boolean).map(Number); if (days.length && days.every((d) => Number.isInteger(d) && d > 0)) setBilling({ ageingBucketsDays: days }); else setBucketsText(form.billing.ageingBucketsDays.join(", ")); }} />
            </SettingRow>
            <SettingRow title="Invoice numbers" description="INV/26/0001 unless a numbering series for invoices is set up under Numbering series. Credit notes are CRN/26/0001 and receipts RCT/26/0001 the same way.">
              <span className="setting-fixed">Numbering series</span>
            </SettingRow>
          </SettingsSection>
        )}
      </fieldset>
      {writable && <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => setForm(saved.data!)} />}
    </>
  );
}
