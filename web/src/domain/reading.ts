import { byId, measureFuel, volume20 } from "./calc";
import type { AppData, DocKind, Extracted, Trip } from "./types";

/** Small deterministic generator so the same photo always reads the same way. */
export function seeded(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export const EXPENSE_SAMPLES = [
  { variant: "toll", title: "Toll receipt", amount: 250, currency: "base" as const, issuer: "Road Development Agency" },
  { variant: "border", title: "Border fee", amount: 60, currency: "USD" as const, issuer: "ZIMRA Customs" },
  { variant: "meals", title: "Meals receipt", amount: 185, currency: "base" as const, issuer: "Mama Tasty Kitchen" },
  { variant: "parking", title: "Parking ticket", amount: 100, currency: "base" as const, issuer: "Truck Stop Parking" },
  { variant: "repair", title: "Tyre repair", amount: 1450, currency: "base" as const, issuer: "Highway Tyre Centre" },
];

export function readDocument(
  data: AppData,
  trip: Trip | undefined,
  kind: DocKind,
  sampleId?: string,
): Extracted {
  const variant = sampleId?.split(":")[2] ?? "0";
  const rand = seeded(`${trip?.id ?? "none"}:${kind}:${variant}:${sampleId ?? "upload"}`);
  const n = (min: number, max: number, digits = 0) => {
    const f = 10 ** digits;
    return Math.round((min + rand() * (max - min)) * f) / f;
  };
  if (kind === "expense" || kind === "fuel") {
    const index = Math.max(0, EXPENSE_SAMPLES.findIndex((s) => s.variant === variant));
    const sample = EXPENSE_SAMPLES[index];
    // The sample's type becomes one of the company's own expense categories.
    const category = data.categories.find((c) => c.name.toLowerCase().includes(sample.variant)) ?? data.categories[index % Math.max(1, data.categories.length)];
    return {
      docNo: `R${n(10000, 99999)}`,
      amount: sample.amount,
      // A simulated receipt is in the company's own currency, except the border fee.
      currency: sample.currency === "base" ? data.baseCurrency?.code ?? "" : sample.currency,
      categoryId: category?.id,
    };
  }
  if (!trip) return {};
  // The trip's product, else the goods of its first consignment still to load (#135: goods are on consignments now),
  // else any fuel, else any product. A company with no products has nothing to read.
  const waiting = data.cns.find((c) => c.tripId === trip.id && c.legs.some((l) => l.kind === "pickup" && l.status === "planned"));
  const product = byId(data.products, trip.productId) ?? byId(data.products, waiting?.lines[0]?.productId) ?? data.products.find((p) => p.kind === "fuel") ?? data.products[0];
  if (!product) return {};
  const trailer = byId(data.trailers, trip.trailerId);
  const load = trip.stops.find((s) => s.kind === "load");
  if (kind === "loading") {
    if (product.kind !== "fuel") {
      const truck = byId(data.trucks, trip.truckId)!;
      return {
        docNo: `DN-${n(20000, 89999)}`,
        productId: product.id,
        qty: trip.plannedQty ?? Math.max(1, truck.capacityT - 2),
        consignor: byId(data.places, load?.placeId)?.name ?? "Shipper",
        consignee: byId(data.customers, trip.customerId)?.name,
      };
    }
    const capacity = trailer?.unit === "L" ? trailer.capacity : 38000;
    const ambient = trip.plannedQty ?? Math.round(capacity / 1000) * 1000 - (rand() > 0.5 ? 0 : 1000);
    const petrol = product.fuelGroup === "petrol";
    return {
      docNo: `INV-${n(40000, 49999)}`,
      productId: product.id,
      qty: ambient,
      ambientL: ambient,
      tempC: n(23, 31, 1),
      density: petrol ? n(736, 748, 1) : n(829, 841, 1),
      consignor: byId(data.places, load?.placeId)?.name ?? "Fuel terminal",
      consignee: byId(data.customers, trip.customerId)?.name,
    };
  }
  if (kind === "delivery") {
    const c = data.consignments.find((x) => x.tripId === trip.id && !x.delivered);
    if (!c) return { docNo: `POD-${n(10000, 99999)}` };
    const p = byId(data.products, c.productId)!;
    if (p.kind !== "fuel") return { docNo: `POD-${n(10000, 99999)}`, qty: c.load.qty };
    const loaded20 = volume20(c.load) ?? c.load.qty;
    const tempC = n(19, 26, 1);
    const density = Math.round(((c.load.density ?? 835) + n(-0.8, 0.8, 1)) * 10) / 10;
    const lossPct = variant === "1" ? n(0.08, 0.2, 2) : n(0.38, 0.52, 2);
    const target20 = loaded20 * (1 - lossPct / 100);
    const vcf = measureFuel(p, { ambientL: 1000, tempC, density }).vcf ?? 1;
    const ambient = Math.round(target20 / vcf);
    return {
      docNo: `POD-${n(10000, 99999)}`,
      qty: ambient,
      ambientL: ambient,
      tempC,
      density,
    };
  }
  return {};
}
