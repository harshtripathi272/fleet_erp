import { byId } from "../domain/calc";
import { EXPENSE_SAMPLES, readDocument, seeded } from "../domain/reading";
import type { AppData, DocKind, Extracted, Trip } from "../domain/types";

const esc = (s: string | number | undefined) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v?: number, d = 0) => (v == null ? "" : v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }));
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function photo(inner: string, key: string, paperW = 470, paperH = 620) {
  const r = seeded(key);
  const tilt = (r() - 0.5) * 5;
  const dx = (r() - 0.5) * 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 780" width="600" height="780">
  <defs>
    <radialGradient id="desk" cx="45%" cy="40%" r="80%"><stop offset="0" stop-color="#5a4a3c"/><stop offset=".7" stop-color="#3a2f27"/><stop offset="1" stop-color="#231c17"/></radialGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="9"/><feOffset dy="10"/><feComponentTransfer><feFuncA type="linear" slope=".55"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>
    <pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#000" opacity=".03"/><circle cx="1" cy="1" r=".6" fill="#fff" opacity=".05"/></pattern>
  </defs>
  <rect width="600" height="780" fill="url(#desk)"/>
  <rect width="600" height="780" fill="url(#grain)"/>
  <g transform="translate(${300 + dx} 395) rotate(${tilt}) translate(${-paperW / 2} ${-paperH / 2})" filter="url(#sh)">
    <rect width="${paperW}" height="${paperH}" fill="#f8f5ec" rx="2"/>
    ${inner}
    <rect width="${paperW}" height="${paperH}" fill="url(#light)"/>
  </g>
</svg>`;
}

function stamp(x: number, y: number, text: string, sub: string, color: string, rot: number) {
  return `<g transform="translate(${x} ${y}) rotate(${rot})" opacity=".78" font-family="Arial, Helvetica, sans-serif" fill="${color}">
    <circle r="46" fill="none" stroke="${color}" stroke-width="3"/><circle r="39" fill="none" stroke="${color}" stroke-width="1.2"/>
    <text text-anchor="middle" y="-6" font-size="11" font-weight="700" letter-spacing="1">${esc(text)}</text>
    <text text-anchor="middle" y="11" font-size="9">${esc(sub)}</text></g>`;
}
const signature = (x: number, y: number) =>
  `<path d="M${x} ${y}c10-18 18-20 22-8s-6 16 2 6 16-22 22-12-4 14 6 8 14-10 22-6" fill="none" stroke="#1d3b6e" stroke-width="2" stroke-linecap="round"/>`;

function invoice(data: AppData, trip: Trip, read: Extracted, key: string) {
  const product = byId(data.products, read.productId);
  const truck = byId(data.trucks, trip.truckId);
  const trailer = byId(data.trailers, trip.trailerId);
  const driver = byId(data.drivers, trip.driverId);
  const fuel = product?.kind === "fuel";
  const rows: [string, string][] = fuel
    ? [
        ["Product", product?.name ?? ""],
        ["Gross observed volume", `${n(read.ambientL)} L`],
        ["Observed temperature", `${n(read.tempC, 1)} °C`],
        ["Density at obs. temp", `${n(read.density, 1)} kg/m³`],
        ["Compartments sealed", "4 / 4"],
      ]
    : [
        ["Product", product?.name ?? ""],
        ["Quantity", `${n(read.qty, 2)} t`],
        ["Packages", `${Math.round((read.qty ?? 0) * 40)} bundles`],
      ];
  const inner = `<g font-family="Georgia, 'Times New Roman', serif" fill="#1f2421">
    <rect x="0" y="0" width="470" height="8" fill="#1d4d3f"/>
    <text x="30" y="52" font-size="19" font-weight="700">${esc(read.consignor)}</text>
    <text x="30" y="70" font-size="10" fill="#555" font-family="Arial, sans-serif">Loading bay 3 · VAT 1002937741</text>
    <text x="440" y="52" text-anchor="end" font-size="15" font-family="Arial, sans-serif" font-weight="700" letter-spacing="1">${fuel ? "LOADING INVOICE" : "DISPATCH NOTE"}</text>
    <text x="440" y="70" text-anchor="end" font-size="11" font-family="'Courier New', monospace">${esc(read.docNo)}</text>
    <line x1="30" y1="88" x2="440" y2="88" stroke="#999" stroke-width=".8"/>
    <g font-family="Arial, sans-serif" font-size="10.5" fill="#333">
      <text x="30" y="110">Consignee</text><text x="140" y="110" font-weight="700">${esc(read.consignee)}</text>
      <text x="30" y="128">Truck / trailer</text><text x="140" y="128" font-family="'Courier New', monospace">${esc(truck?.plate)} / ${esc(trailer?.plate)}</text>
      <text x="30" y="146">Driver</text><text x="140" y="146">${esc(driver?.name)}</text>
    </g>
    <rect x="30" y="166" width="410" height="${rows.length * 30 + 10}" fill="none" stroke="#bbb"/>
    ${rows
      .map(
        ([k, v], i) =>
          `<text x="44" y="${190 + i * 30}" font-family="Arial, sans-serif" font-size="11" fill="#444">${esc(k)}</text><text x="426" y="${190 + i * 30}" text-anchor="end" font-family="'Courier New', monospace" font-size="13" font-weight="700">${esc(v)}</text>${i < rows.length - 1 ? `<line x1="30" y1="${201 + i * 30}" x2="440" y2="${201 + i * 30}" stroke="#ddd"/>` : ""}`,
      )
      .join("")}
    <text x="30" y="${214 + rows.length * 30}" font-family="Arial, sans-serif" font-size="9" fill="#777">Quantities as loaded at the gantry. Seals checked by the driver.</text>
    ${Array.from({ length: 34 }, (_, i) => `<rect x="${30 + i * 5.2}" y="${560}" width="${1 + ((i * 7) % 3)}" height="30" fill="#222"/>`).join("")}
    <text x="30" y="${520}" font-family="Arial, sans-serif" font-size="10" fill="#444">Gantry officer</text>
    ${signature(40, 505)}
    ${stamp(360, 505, "LOADED", new Date().toLocaleDateString("en-GB"), "#b3261e", -14)}
  </g>`;
  return photo(inner, key);
}

function deliveryNote(data: AppData, trip: Trip, read: Extracted, key: string) {
  const c = data.consignments.find((x) => x.tripId === trip.id && !x.delivered) ?? data.consignments.find((x) => x.tripId === trip.id);
  const product = byId(data.products, c?.productId);
  const place = byId(data.places, trip.stops.find((s) => s.kind === "offload")?.placeId);
  const fuel = product?.kind === "fuel";
  const inner = `<g font-family="Arial, Helvetica, sans-serif" fill="#1f2421">
    <text x="30" y="50" font-size="17" font-weight="700">${esc(byId(data.customers, trip.customerId)?.name)}</text>
    <text x="30" y="68" font-size="10" fill="#555">${esc(place?.name)} receiving</text>
    <text x="440" y="50" text-anchor="end" font-size="15" font-weight="700" letter-spacing="1">PROOF OF DELIVERY</text>
    <text x="440" y="68" text-anchor="end" font-size="11" font-family="'Courier New', monospace">${esc(read.docNo)}</text>
    <line x1="30" y1="84" x2="440" y2="84" stroke="#999"/>
    <g font-size="11" fill="#333">
      <text x="30" y="110">Consignment</text><text x="170" y="110" font-family="'Courier New', monospace">${esc(c?.no)} · ${esc(c?.invoiceNo)}</text>
      <text x="30" y="130">Product</text><text x="170" y="130">${esc(product?.name)}</text>
      ${fuel ? `<text x="30" y="150">Dip before / after</text><text x="170" y="150" font-family="'Courier New', monospace">0 mm / 1 842 mm</text>` : ""}
    </g>
    <rect x="30" y="170" width="410" height="${fuel ? 130 : 70}" fill="#fff" stroke="#bbb"/>
    <g font-size="11">
      <text x="44" y="196" fill="#444">${fuel ? "Received, observed" : "Received"}</text><text x="426" y="196" text-anchor="end" font-family="'Courier New', monospace" font-size="14" font-weight="700">${fuel ? `${n(read.ambientL)} L` : `${n(read.qty, 2)} t`}</text>
      ${
        fuel
          ? `<text x="44" y="226" fill="#444">Temperature</text><text x="426" y="226" text-anchor="end" font-family="'Courier New', monospace" font-size="14" font-weight="700">${n(read.tempC, 1)} °C</text>
      <text x="44" y="256" fill="#444">Density</text><text x="426" y="256" text-anchor="end" font-family="'Courier New', monospace" font-size="14" font-weight="700">${n(read.density, 1)} kg/m³</text>
      <text x="44" y="286" fill="#444">Condition</text><text x="426" y="286" text-anchor="end" font-size="12">Seals intact</text>`
          : `<text x="44" y="226" fill="#444">Condition</text><text x="426" y="226" text-anchor="end" font-size="12">Good order</text>`
      }
    </g>
    <text x="30" y="360" font-size="10" fill="#444">Received by</text>
    <text x="30" y="380" font-size="13" font-family="Georgia, serif" font-style="italic">R. Mutale, depot supervisor</text>
    ${signature(250, 380)}
    ${stamp(350, 470, "RECEIVED", new Date().toLocaleDateString("en-GB"), "#1d3b6e", 11)}
    <line x1="30" y1="560" x2="440" y2="560" stroke="#ccc" stroke-dasharray="4 4"/>
    <text x="30" y="585" font-size="9" fill="#777">White: customer · Yellow: transporter · Pink: driver</text>
  </g>`;
  return photo(inner, key);
}

function receipt(read: Extracted, variant: string, key: string) {
  const sample = EXPENSE_SAMPLES.find((s) => s.variant === variant) ?? EXPENSE_SAMPLES[0];
  const lines = [
    [sample.title.toUpperCase(), ""],
    ["Ref", read.docNo ?? ""],
    ["Date", new Date().toLocaleDateString("en-GB")],
    ["Time", new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })],
  ];
  const inner = `<g font-family="'Courier New', Courier, monospace" fill="#2a2a2a">
    <text x="150" y="44" text-anchor="middle" font-size="15" font-weight="700">${esc(sample.issuer.toUpperCase())}</text>
    <text x="150" y="62" text-anchor="middle" font-size="10">TPIN 1001${Math.round(seeded(key)() * 899999 + 100000)}</text>
    <line x1="20" y1="80" x2="280" y2="80" stroke="#555" stroke-dasharray="3 3"/>
    ${lines.map(([k, v], i) => `<text x="22" y="${104 + i * 20}" font-size="12">${esc(k)}</text><text x="278" y="${104 + i * 20}" text-anchor="end" font-size="12">${esc(v)}</text>`).join("")}
    <line x1="20" y1="${104 + lines.length * 20}" x2="280" y2="${104 + lines.length * 20}" stroke="#555" stroke-dasharray="3 3"/>
    <text x="22" y="${134 + lines.length * 20}" font-size="15" font-weight="700">TOTAL</text>
    <text x="278" y="${134 + lines.length * 20}" text-anchor="end" font-size="17" font-weight="700">${esc(sample.currency)} ${n(sample.amount, 2)}</text>
    <text x="22" y="${156 + lines.length * 20}" font-size="11">PAID CASH</text>
    <line x1="20" y1="${176 + lines.length * 20}" x2="280" y2="${176 + lines.length * 20}" stroke="#555" stroke-dasharray="3 3"/>
    <text x="150" y="${206 + lines.length * 20}" text-anchor="middle" font-size="11">THANK YOU · SAFE JOURNEY</text>
    ${Array.from({ length: 30 }, (_, i) => `<rect x="${58 + i * 6}" y="${230 + lines.length * 20}" width="${1 + ((i * 5) % 3)}" height="26" fill="#333"/>`).join("")}
  </g>
  <path d="M0 ${330 + lines.length * 20} ${Array.from({ length: 16 }, (_, i) => `L${i * 20 + 10} ${340 + lines.length * 20} L${i * 20 + 20} ${330 + lines.length * 20}`).join(" ")}" fill="#f8f5ec"/>`;
  return photo(inner, key, 300, 330 + lines.length * 20);
}

export interface Sample {
  sampleId: string;
  kind: DocKind;
  title: string;
  detail: string;
  read: Extracted;
  image: string;
}

export function galleryFor(data: AppData, trip: Trip | undefined): Sample[] {
  const out: Sample[] = [];
  if (trip) {
    const loaded = data.consignments.some((c) => c.tripId === trip.id);
    if (!loaded) {
      const id = `loading:${trip.id}:0`;
      const read = readDocument(data, trip, "loading", id);
      out.push({ sampleId: id, kind: "loading", title: "Loading invoice", detail: read.docNo ?? "", read, image: svgUrl(invoice(data, trip, read, id)) });
    }
    if (loaded && data.consignments.some((c) => c.tripId === trip.id && !c.delivered)) {
      for (const variant of ["0", "1"]) {
        const id = `delivery:${trip.id}:${variant}`;
        const read = readDocument(data, trip, "delivery", id);
        out.push({ sampleId: id, kind: "delivery", title: "Delivery note", detail: read.docNo ?? "", read, image: svgUrl(deliveryNote(data, trip, read, id)) });
      }
    }
  }
  for (const sample of EXPENSE_SAMPLES) {
    const id = `expense:${trip?.id ?? "none"}:${sample.variant}`;
    const read = readDocument(data, trip, "expense", id);
    out.push({ sampleId: id, kind: "expense", title: sample.title, detail: `${sample.currency} ${sample.amount}`, read, image: svgUrl(receipt(read, sample.variant, id)) });
  }
  return out;
}

const cache = new Map<string, string>();
/** Image for a sent document: the uploaded photo, or the sample it was picked from. */
export function docImage(
  data: AppData,
  doc: { file?: { dataUrl?: string; sampleId?: string }; read?: Extracted; tripId?: string },
): string | undefined {
  if (doc.file?.dataUrl) return doc.file.dataUrl;
  const id = doc.file?.sampleId;
  if (!id) return undefined;
  const hit = cache.get(id);
  if (hit) return hit;
  const [kind, , variant] = id.split(":");
  const trip = byId(data.trips, doc.tripId);
  const read = doc.read ?? {};
  let svg: string | undefined;
  if (kind === "loading" && trip) svg = invoice(data, trip, read, id);
  else if (kind === "delivery" && trip) svg = deliveryNote(data, trip, read, id);
  else if (kind === "expense" || kind === "fuel") svg = receipt(read, variant, id);
  if (!svg) return undefined;
  const url = svgUrl(svg);
  cache.set(id, url);
  return url;
}

export function sampleImage(svg: string) {
  return svgUrl(svg);
}
