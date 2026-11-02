import { useMemo } from "react";
import { useApp } from "../store";
import { byId, legLoaded, legShape, positionAt } from "../domain/calc";
import type { StopKind, Trip } from "../domain/types";

interface StopLike {
  placeId: string;
  kind: StopKind;
  legKm: number;
}

/** A small drawn map of a route on real road shapes, with the truck's position. */
export function MiniRoute({ stops, trip, height = 150 }: { stops: StopLike[]; trip?: Trip; height?: number }) {
  const { data } = useApp();
  const drawn = useMemo(() => {
    const legs = stops.slice(1).map((s, i) => ({ shape: legShape(data, stops[i].placeId, s.placeId), loaded: legLoaded(stops, i + 1) }));
    const pts = legs.flatMap((l) => l.shape);
    for (const s of stops) {
      const p = byId(data.places, s.placeId);
      if (p) pts.push([p.lng, p.lat]);
    }
    if (!pts.length) return null;
    const lats = pts.map((p) => p[1]);
    const lngs = pts.map((p) => p[0]);
    const k = Math.cos(((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180));
    const minX = Math.min(...lngs) * k;
    const maxX = Math.max(...lngs) * k;
    const minY = -Math.max(...lats);
    const maxY = -Math.min(...lats);
    const w = 320;
    const pad = 22;
    const spanX = Math.max(maxX - minX, 0.05);
    const spanY = Math.max(maxY - minY, 0.05);
    const scale = Math.min((w - pad * 2) / spanX, (height - pad * 2) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = (height - spanY * scale) / 2;
    const project = ([lng, lat]: [number, number]) => [ox + (lng * k - minX) * scale, oy + (-lat - minY) * scale] as const;
    const path = (shape: [number, number][]) =>
      shape.map((p, i) => `${i ? "L" : "M"}${project(p)[0].toFixed(1)} ${project(p)[1].toFixed(1)}`).join("");
    return { legs: legs.map((l) => ({ d: path(l.shape), loaded: l.loaded })), project, w };
  }, [data, stops, height]);
  if (!drawn) return null;
  const truck = trip?.dispatchedAt && !trip.endedAt ? positionAt(data, trip, trip.tracking?.km ?? 0) : undefined;
  const seen = new Set<string>();
  return (
    <svg className="mini-route" viewBox={`0 0 ${drawn.w} ${height}`} role="img" aria-label="Route">
      <defs>
        <pattern id="mr-grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" stroke="rgba(29,77,63,.06)" />
        </pattern>
      </defs>
      <rect width={drawn.w} height={height} fill="url(#mr-grid)" />
      {drawn.legs.map((l, i) => (
        <path key={`c${i}`} d={l.d} className="mr-casing" />
      ))}
      {drawn.legs.map((l, i) => (
        <path key={`l${i}`} d={l.d} className={l.loaded ? "mr-loaded" : "mr-empty"} />
      ))}
      {stops.map((s, i) => {
        const place = byId(data.places, s.placeId);
        if (!place || seen.has(s.placeId + s.kind)) return null;
        seen.add(s.placeId + s.kind);
        const [x, y] = drawn.project([place.lng, place.lat]);
        const major = s.kind !== "via" && s.kind !== "border";
        const label = s.kind === "start" || s.kind === "load" || s.kind === "offload";
        const labelled = label && !(s.kind === "start" && stops.some((o) => o !== s && o.placeId === s.placeId && o.kind !== "via" && o.kind !== "border"));
        return (
          <g key={i} transform={`translate(${x} ${y})`}>
            <circle r={major ? 4.5 : 3} className={`mr-stop mr-${s.kind}`} />
            {labelled && (
              <text y={-9} textAnchor={x > drawn.w - 70 ? "end" : x < 70 ? "start" : "middle"} className="mr-label">
                {place.name.replace(/ (fuel terminal|fuel depot|copper yard|refinery|border.*|port)$/i, "")}
              </text>
            )}
          </g>
        );
      })}
      {truck && (
        <g transform={`translate(${drawn.project([truck.lng, truck.lat]).join(" ")})`} className="mr-truck">
          <circle r="10" className="mr-truck-halo" />
          <circle r="5.5" className="mr-truck-dot" />
        </g>
      )}
    </svg>
  );
}
