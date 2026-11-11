import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(workerUrl);

/** The same free OpenStreetMap tiles as Track. */
const STYLE = "https://tiles.openfreemap.org/styles/positron";

/**
 * A place's pin (#102): click the map or drag the pin to put it where the gate or yard is. Loaded only when the
 * place form opens, so the rest of Masters doesn't carry the map.
 */
export default function PinMap({ at, onPick }: { at?: { lat: number; lng: number }; onPick: (at: { lat: number; lng: number }) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const pin = useRef<Marker | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current, style: STYLE, attributionControl: { compact: true },
      center: at ? [at.lng, at.lat] : [25, -5], zoom: at ? 14 : 2.6,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("error", (event) => console.warn("Map:", event.error?.message));
    m.on("click", (e) => pick.current({ lat: round(e.lngLat.lat), lng: round(e.lngLat.lng) }));
    map.current = m;
    return () => { m.remove(); map.current = null; pin.current = null; };
    // The map is made once; the pin follows `at` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!at) { pin.current?.remove(); pin.current = null; return; }
    if (!pin.current) {
      pin.current = new maplibregl.Marker({ color: "#1d4d3f", draggable: true }).setLngLat([at.lng, at.lat]).addTo(m);
      pin.current.on("dragend", () => { const p = pin.current!.getLngLat(); pick.current({ lat: round(p.lat), lng: round(p.lng) }); });
    } else pin.current.setLngLat([at.lng, at.lat]);
    if (!m.getBounds().contains([at.lng, at.lat]) || m.getZoom() < 10) m.flyTo({ center: [at.lng, at.lat], zoom: Math.max(m.getZoom(), 14), duration: 600 });
  }, [at?.lat, at?.lng]);

  return <div ref={box} className="pin-map" aria-label="Map: click to put the place's pin there" />;
}

/** Six decimals is about 10 cm: more than a gate needs. */
const round = (v: number) => Math.round(v * 1e6) / 1e6;
