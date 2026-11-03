import { useMemo } from "react";
import { useApp } from "../store";
import { byId } from "../domain/calc";
import { positionAt, tripShape } from "../domain/route";
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
            {p.kind !== "border" && (
              <text y={-8} textAnchor="middle">
                {p.name.replace(/ (fuel terminal|fuel depot|copper yard|refinery|port)$/i, "")}
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
