import { useMemo } from "react";
import { useApp } from "../store";
import { byId, positionAt, tripShape } from "../domain/calc";
import { activeTrip } from "../domain/helpers";

/** All active trips on one drawn map of the region. */
export function FleetMap({ onTrip }: { onTrip: (id: string) => void }) {
  const { data } = useApp();
  const W = 640;
  const H = 360;
  const view = useMemo(() => {
    const lats = data.places.map((p) => p.lat);
    const lngs = data.places.map((p) => p.lng);
    const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
    const minX = Math.min(...lngs) * k;
    const maxX = Math.max(...lngs) * k;
    const minY = -Math.max(...lats);
    const maxY = -Math.min(...lats);
    const pad = 30;
    const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
    const ox = (W - (maxX - minX) * scale) / 2;
    const oy = (H - (maxY - minY) * scale) / 2;
    return (lng: number, lat: number) => [ox + (lng * k - minX) * scale, oy + (-lat - minY) * scale] as const;
  }, [data.places]);
  // Each place's name, put above its dot, or below, left or right of it when that would cover another name.
  const labels = useMemo(() => {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const hits = (b: { x: number; y: number; w: number; h: number }) => placed.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
    const out = new Map<string, { text: string; dx: number; dy: number; anchor: "middle" | "start" | "end" }>();
    for (const p of data.places.filter((pl) => pl.kind !== "border")) {
      const [x, y] = view(p.lng, p.lat);
      const text = shortName(p.name);
      const w = text.length * 6.2;
      const h = 12;
      const spots = [
        { dx: 0, dy: -8, anchor: "middle" as const, box: { x: x - w / 2, y: y - 8 - h, w, h } },
        { dx: 0, dy: 16, anchor: "middle" as const, box: { x: x - w / 2, y: y + 5, w, h } },
        { dx: 8, dy: 4, anchor: "start" as const, box: { x: x + 7, y: y - h / 2, w, h } },
        { dx: -8, dy: 4, anchor: "end" as const, box: { x: x - 7 - w, y: y - h / 2, w, h } },
      ];
      const spot = spots.find((s) => !hits(s.box)) ?? spots[0]!;
      placed.push(spot.box);
      out.set(p.id, { text, dx: spot.dx, dy: spot.dy, anchor: spot.anchor });
    }
    return out;
  }, [data.places, view]);
  const trips = data.trips.filter((t) => t.dispatchedAt && activeTrip(t));
  const planned = data.trips.filter((t) => !t.dispatchedAt && activeTrip(t));
  const toPath = (shape: [number, number][]) => shape.map((p, i) => `${i ? "L" : "M"}${view(p[0], p[1]).map((v) => v.toFixed(1)).join(" ")}`).join("");
  return (
    <svg className="fleet-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trucks on the road">
      <defs>
        <pattern id="fm-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="rgba(29,77,63,.07)" />
        </pattern>
        <radialGradient id="fm-glow">
          <stop offset="0" stopColor="#c4902c" stopOpacity=".35" />
          <stop offset="1" stopColor="#c4902c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="url(#fm-grid)" />
      {trips.map((t) => tripShape(data, t).map((shape, i) => <path key={`${t.id}${i}`} d={toPath(shape)} className="fm-route" />))}
      {data.places.map((p) => {
        const [x, y] = view(p.lng, p.lat);
        return (
          <g key={p.id} transform={`translate(${x} ${y})`} className={`fm-place fm-${p.kind}`}>
            <circle r={p.kind === "border" ? 2.5 : 3.2} />
            {labels.has(p.id) && (
              <text x={labels.get(p.id)!.dx} y={labels.get(p.id)!.dy} textAnchor={labels.get(p.id)!.anchor}>
                {labels.get(p.id)!.text}
              </text>
            )}
          </g>
        );
      })}
      {planned.map((t) => {
        const place = byId(data.places, byId(data.trucks, t.truckId)?.placeId);
        if (!place) return null;
        const [x, y] = view(place.lng, place.lat);
        return <circle key={t.id} cx={x + 7} cy={y + 5} r={3.5} className="fm-parked" />;
      })}
      {trips.map((t) => {
        const pos = positionAt(data, t, t.tracking?.km ?? 0);
        const [x, y] = view(pos.lng, pos.lat);
        const truck = byId(data.trucks, t.truckId);
        return (
          <g key={t.id} transform={`translate(${x} ${y})`} className="fm-truck" onClick={() => onTrip(t.id)} role="button" aria-label={truck?.plate}>
            <circle r="16" fill="url(#fm-glow)" />
            <circle r="6" />
            <text x="10" y="4">
              {truck?.plate}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A place's town for the small map: "Kitwe copper refinery" → "Kitwe", "Dar es Salaam port" → "Dar es Salaam". */
const shortName = (name: string) => name.replace(/\s+(copper\s+)?(fuel\s+)?(terminal|depot|yard|refinery|port|mine|warehouse)$/i, "");
