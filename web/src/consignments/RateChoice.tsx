import { useQuery } from "@tanstack/react-query";
import { request } from "../api/client";
import { UnitInput } from "../ui/kit";
import type { AppData } from "../domain/types";
import { moneyText } from "./TripConsignments";

/**
 * A consignment's price while it is booked (#151). When the customer's rate contract covers the route and goods, the
 * consignment is under it: it says so, and Operations never sees the amount. The person booking may charge it at
 * another rate instead, with the reason; with Company → Freight's switch on, Finance approves that rate first. With
 * no contract line, they type the day's rate, or leave it for later.
 */

export interface ContractLine { contractId: string; code: string; name: string; lineId: string; basis?: string; chargeOn?: string; price?: { amountMinor: number; currencyId: string } }
export interface ContractAnswer { line: ContractLine | null; contract: { contractId: string; code: string; name: string } | null }

export interface RateDraft {
  rateBasis: string;
  ratePrice: string;
  rateCurrencyId: string;
  rateOn: "" | "loaded" | "delivered";
  /** false: charged at the typed rate though the contract covers it. */
  useContract: boolean;
  rateReason: string;
}

export const RATE_BASES: { value: string; label: string; per: string }[] = [
  { value: "per_consignment", label: "fixed", per: "" }, { value: "per_tonne", label: "per tonne", per: "t" }, { value: "per_kg", label: "per kg", per: "kg" },
  { value: "per_litre", label: "per litre", per: "L" }, { value: "per_litre_20", label: "per litre at 20 °C", per: "L at 20 °C" },
  { value: "per_piece", label: "per piece", per: "piece" }, { value: "per_km", label: "per km", per: "km" },
];
const CONTRACT_BASIS: Record<string, string> = { per_consignment: "fixed for the route", per_tonne: "per tonne", per_kg: "per kg", per_litre: "per litre", per_litre_20: "per litre at 20 °C", per_piece: "per piece" };

/** The contract line a consignment for this customer, goods and route would be under. */
export function useContractLine(q: { customerId?: string; productId?: string; routeId?: string; tripId?: string; fromPlaceId?: string; toPlaceId?: string }) {
  return useQuery({
    queryKey: ["contract-for", q],
    enabled: Boolean(q.customerId && q.productId),
    staleTime: 30_000,
    queryFn: async () => (await request<ContractAnswer>("/rate-contracts/for", { query: Object.fromEntries(Object.entries(q).filter(([, v]) => v)) as Record<string, string> })).data,
  });
}

/** "Rate contract TK-2026-01 (Trade King 2026)", with the amount for someone who sees money. */
export function contractText(data: AppData, line: ContractLine) {
  const amount = line.price ? ` · ${moneyText(data, line.price.amountMinor, line.price.currencyId)} ${CONTRACT_BASIS[line.basis ?? ""] ?? ""}${line.chargeOn && line.basis !== "per_consignment" ? `, on the ${line.chargeOn === "delivered" ? "delivered" : "loaded"} quantity` : ""}` : "";
  return `Rate contract ${line.code} (${line.name})${amount}`;
}

/** The typed rate's own controls: price, currency, per what, on which quantity. */
function RateInputs({ data, d, set, label }: { data: AppData; d: RateDraft; set: (patch: Partial<RateDraft>) => void; label: string }) {
  const basis = RATE_BASES.find((b) => b.value === d.rateBasis);
  const cur = data.currencies?.find((c) => c.id === d.rateCurrencyId) ?? data.baseCurrency;
  return (
    <div className="cn-row-rate-controls">
      <UnitInput label={label} unit={cur?.code ?? ""} value={d.ratePrice} onChange={(v) => set({ ratePrice: v })} />
      {(data.currencies?.length ?? 0) > 1 && (
        <select className="input" aria-label="Currency of the price" value={cur?.id ?? ""} onChange={(e) => set({ rateCurrencyId: e.target.value })}>
          {(data.currencies ?? []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
      )}
      <select className="input" aria-label="Per what" value={d.rateBasis} onChange={(e) => set({ rateBasis: e.target.value })}>
        {RATE_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
      </select>
      {basis?.per && basis.value !== "per_km" && (
        <select className="input" aria-label="On which quantity" value={d.rateOn} onChange={(e) => set({ rateOn: e.target.value as RateDraft["rateOn"] })}>
          <option value="">on the company's usual quantity</option>
          <option value="loaded">on the loaded quantity</option>
          <option value="delivered">on the delivered quantity</option>
        </select>
      )}
    </div>
  );
}

export function RateChoice({ data, d, set, answer, label }: { data: AppData; d: RateDraft; set: (patch: Partial<RateDraft>) => void; answer?: ContractAnswer; label: string }) {
  const line = answer?.line;
  const approval = data.settings.freight.ownRateNeedsApproval;
  if (line) {
    return (
      <div className="cn-row-rate">
        <span className="field-label">Rate</span>
        <div className="rate-choice" role="radiogroup" aria-label={`Rate for ${label}`}>
          <label className="rate-option">
            <input type="radio" checked={d.useContract} onChange={() => set({ useContract: true })} />
            <span>{contractText(data, line)}</span>
          </label>
          <label className="rate-option">
            <input type="radio" checked={!d.useContract} onChange={() => set({ useContract: false })} />
            <span>Another rate</span>
          </label>
        </div>
        {!d.useContract && (
          <>
            <RateInputs data={data} d={d} set={set} label={`Price for ${label}`} />
            <input className="input" aria-label="Why not the contract" placeholder="Why not the contract, for example a one-off deal agreed by phone" value={d.rateReason} onChange={(e) => set({ rateReason: e.target.value })} />
            <span className="field-hint">{approval ? `Finance approves this rate first. Until then ${line.code} prices it.` : "Kept with the consignment, and shown to Finance."}</span>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="cn-row-rate">
      <span className="field-label">Rate</span>
      <RateInputs data={data} d={d} set={set} label={`Price for ${label}`} />
      <span className="field-hint">
        {answer?.contract ? `${answer.contract.code} doesn't cover this route and goods. Type the day's rate, or leave it for Finance. ` : ""}
        {d.ratePrice.trim() ? "" : "Empty: set the price later."}
      </span>
    </div>
  );
}

/** The body fields for the rate a person chose. */
export function rateBody(data: AppData, d: RateDraft, underContract: boolean) {
  const currency = data.currencies?.find((c) => c.id === d.rateCurrencyId) ?? data.baseCurrency;
  if (underContract && d.useContract) return { useContract: true };
  if (!d.ratePrice.trim() || !currency) return underContract ? { useContract: true } : {};
  return {
    rate: {
      // A unit price keeps fractions of a minor unit (0.085 USD a litre is 8.5); four decimals are plenty.
      basis: d.rateBasis, price: { amountMinor: Math.round(Number(d.ratePrice) * 10 ** currency.minorUnits * 1e4) / 1e4, currencyId: currency.id },
      ...(d.rateOn && d.rateBasis !== "per_consignment" && d.rateBasis !== "per_km" ? { chargeOn: d.rateOn } : {}),
    },
    ...(underContract ? { useContract: false, rateReason: d.rateReason.trim() } : {}),
  };
}
