import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(workerUrl);
import { Camera, Crosshair, Fuel, Gauge, MapPin, Pause, Play, X } from "lucide-react";
import { useApp } from "../store";
import { byId, cumulativeKm, fuelNow, legLoaded, positionAt, tripKm, tripShape } from "../domain/calc";
import { activeTrip, placeName, routeLabel } from "../domain/helpers";
import { useSim } from "./sim";
import { Dashcam } from "./Dashcam";
import { clock, day, hm, hoursText, km, L } from "../ui/format";
import { Button } from "../ui/kit";
import { StopsTimeline } from "../desks/Trips";

const STYLE = "https://tiles.openfreemap.org/styles/positron";

function tint(map: MlMap) {
  for (const layer of map.getStyle().layers ?? []) {
    try {
      if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#efece3");
      else if (layer.type === "fill" && /water/.test(layer.id)) map.setPaintProperty(layer.id, "fill-color", "#c9dcd7");
      else if (layer.type === "fill" && /(landcover|park|wood|grass)/.test(layer.id)) map.setPaintProperty(layer.id, "fill-color", "#e2e6d6");
      else if (layer.type === "line" && /boundary/.test(layer.id)) map.setPaintProperty(layer.id, "line-color", "#a39c88");
    } catch {
      /* layer without that paint property */
    }
  }
}

export default function Tracking({ tripId }: { tripId: string }) {
  const { data, role, run, overlay, setOverlay, me } = useApp();
  const sim = useSim();
  const trip = byId(data.trips, tripId)!;
  const truck = byId(data.trucks, trip.truckId)!;
  const driver = byId(data.drivers, trip.driverId);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const markerEl = useRef<HTMLDivElement | null>(null);
  const shown = useRef<{ lng: number; lat: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [follow, setFollow] = useState(true);
  const [camera, setCamera] = useState(false);
  const close = () => setOverlay({ ...overlay, tracking: undefined });
  const legs = useMemo(() => tripShape(data, trip), [data, trip]);
  const at = trip.tracking?.km ?? 0;
  const pos = positionAt(data, trip, at);
  const running = sim.running && sim.tripId === trip.id;
  const ops = role === "operations" || role === "owner";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [pos.lng, pos.lat],
      zoom: 6,
      attributionControl: { compact: true },
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map?: MlMap }).__map = m;
    m.on("error", (event) => console.warn("Map:", event.error?.message));
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      tint(m);
      const features = legs.map((shape, i) => ({
        type: "Feature" as const,
        properties: { loaded: legLoaded(trip.stops, i + 1) },
        geometry: { type: "LineString" as const, coordinates: shape },
      }));
      m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features } });
      m.addSource("done", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 }, layout: { "line-cap": "round", "line-join": "round" } });
      m.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: { "line-color": ["case", ["get", "loaded"], "#9a6a12", "#6f8a80"], "line-width": 4, "line-dasharray": [1.4, 1.2] },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      m.addLayer({ id: "done-line", type: "line", source: "done", paint: { "line-color": "#1d4d3f", "line-width": 5 }, layout: { "line-cap": "round", "line-join": "round" } });
      const stops = trip.stops
        .filter((s, i) => i === 0 || s.kind !== "end" || s.placeId !== trip.stops[i - 1].placeId)
        .map((s) => {
          const p = byId(data.places, s.placeId)!;
          return { type: "Feature" as const, properties: { name: p.name, kind: s.kind }, geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] } };
        });
      m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: stops } });
      m.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        paint: {
          "circle-radius": ["match", ["get", "kind"], "via", 4, 6],
          "circle-color": ["match", ["get", "kind"], "load", "#9a6a12", "offload", "#1d4d3f", "via", "#ffffff", "#13261f"],
          "circle-stroke-color": ["match", ["get", "kind"], "via", "#6f8a80", "#ffffff"],
          "circle-stroke-width": 2,
        },
      });
      m.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stops",
        layout: { "text-field": ["get", "name"], "text-size": 12, "text-offset": [0, 1.3], "text-anchor": "top", "text-font": ["Noto Sans Bold"] },
        paint: { "text-color": "#13261f", "text-halo-color": "#fbfaf6", "text-halo-width": 1.6 },
      });
      const bounds = new maplibregl.LngLatBounds();
      legs.flat().forEach((p) => bounds.extend(p as [number, number]));
      m.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, duration: 0 });
      setReady(true);
    });
    const el = document.createElement("div");
    el.className = "truck-marker";
    el.innerHTML = `<span class="tm-pulse"></span><span class="tm-body"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2l6 18-6-4-6 4z" fill="#fff"/></svg></span><span class="tm-plate">${truck.plate}</span>`;
    markerEl.current = el;
    marker.current = new maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(m);
    shown.current = { lng: pos.lng, lat: pos.lat };
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const done: [number, number][] = [];
    const cum = cumulativeKm(trip);
    legs.forEach((shape, i) => {
      const legEnd = cum[i + 1];
      if (at >= legEnd) done.push(...shape);
      else if (at > cum[i]) {
        const t = (at - cum[i]) / Math.max(1, trip.stops[i + 1].legKm);
        done.push(...shape.slice(0, Math.max(1, Math.round(shape.length * t))));
        done.push([pos.lng, pos.lat]);
      }
    });
    (m.getSource("done") as GeoJSONSource | undefined)?.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: done.length > 1 ? done : [] },
    });
    const from = shown.current ?? { lng: pos.lng, lat: pos.lat };
    const to = { lng: pos.lng, lat: pos.lat };
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 440);
      const e = 1 - (1 - t) * (1 - t);
      const p = { lng: from.lng + (to.lng - from.lng) * e, lat: from.lat + (to.lat - from.lat) * e };
      marker.current?.setLngLat([p.lng, p.lat]);
      shown.current = p;
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    if (markerEl.current) {
      markerEl.current.style.setProperty("--heading", `${pos.heading}deg`);
      markerEl.current.classList.toggle("moving", (trip.tracking?.speed ?? 0) > 0);
    }
    if (follow && trip.dispatchedAt && activeTrip(trip) && at > 0) m.easeTo({ center: [pos.lng, pos.lat], zoom: Math.max(m.getZoom(), 7.2), duration: 420 });
    return () => cancelAnimationFrame(raf);
  }, [at, ready, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const cum = cumulativeKm(trip);
  const nextIndex = trip.stops.findIndex((s, i) => i > 0 && !s.arrivedAt);
  const next = trip.stops[nextIndex];
  const loaded = data.consignments.some((c) => c.tripId === trip.id);
  const delivered = loaded && data.consignments.filter((c) => c.tripId === trip.id).every((c) => c.delivered);
  const blocked =
    (!loaded && nextIndex > trip.stops.findIndex((s) => s.kind === "load")) ||
    (!delivered && nextIndex > trip.stops.findIndex((s) => s.kind === "offload"));
  const toNext = next ? Math.max(0, cum[nextIndex] - at) : 0;
  const eta = next ? clock(data) + (toNext / (data.settings.averageSpeedKmh || 62)) * 36e5 : undefined;
  const total = tripKm(trip);
  const fuel = fuelNow(data, trip);
  return createPortal(
    <motion.div className="track-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="track-map" ref={container}>
        {!ready && <div className="map-loading"><span className="map-loading-ring" /></div>}
      </div>
      {camera && (
        <motion.div className="dashcam-frame" initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}>
          <Dashcam plate={truck.plate} speed={activeTrip(trip) ? trip.tracking?.speed ?? 0 : 0} time={clock(data)} coords={`${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`} />
          <span className="sim-tag dashcam-sim">Simulated camera</span>
          <button className="dashcam-close" onClick={() => setCamera(false)} aria-label="Close camera">
            <X size={16} />
          </button>
        </motion.div>
      )}
      <motion.aside className="track-panel" initial={{ x: 30, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 30 }}>
        <header className="track-head">
          <div>
            <span className="mono muted">{trip.no}</span>
            <h2>{truck.plate}</h2>
            <span className="muted">
              {driver?.name} · {routeLabel(data, trip)}
            </span>
          </div>
          <button className="icon-btn with-label" onClick={close} aria-label="Close map">
            <X size={20} />
            <span>Close</span>
          </button>
        </header>
        <div className="gauges">
          <div className="gauge">
            <Gauge size={16} />
            <span>Speed</span>
            <strong>{activeTrip(trip) ? `${Math.round(trip.tracking?.speed ?? 0)}` : "0"}</strong>
            <small>km/h</small>
          </div>
          <div className="gauge">
            <MapPin size={16} />
            <span>{next ? placeName(data, next.placeId) : "Arrived"}</span>
            <strong>{next ? km(toNext).replace(" km", "") : "—"}</strong>
            <small>{next && eta ? `km · ${day(new Date(eta).toISOString())} ${hm(new Date(eta).toISOString())}` : ""}</small>
          </div>
          <div className="gauge">
            <Fuel size={16} />
            <span>Tank</span>
            <strong>{Math.round(fuel)}</strong>
            <small>L of {truck.tankL}</small>
            <i className="gauge-bar">
              <b style={{ width: `${Math.min(100, (fuel / truck.tankL) * 100)}%` }} />
            </i>
          </div>
        </div>
        <div className="track-progress">
          <span style={{ width: `${(at / Math.max(total, 1)) * 100}%` }} />
        </div>
        <div className="track-progress-label">
          <span>{km(at)} driven</span>
          <span>{km(total - at)} to go · about {hoursText((total - at) / (data.settings.averageSpeedKmh || 62))}</span>
        </div>
        <div className="track-controls">
          {ops && activeTrip(trip) && trip.dispatchedAt && (
            <Button tone={running ? "secondary" : "primary"} onClick={() => (running ? sim.stop() : sim.start(trip.id))}>
              {running ? <Pause /> : <Play />} {running ? "Pause" : "Simulate"}
            </Button>
          )}
          {ops && running && (
            <div className="segmented small" aria-label="Simulation speed">
              {[1, 3].map((s) => (
                <button key={s} className={sim.speed === s ? "on" : ""} onClick={() => sim.setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
          )}
          {me.simulators && (
            <Button onClick={() => setCamera((c) => !c)}>
              <Camera /> {camera ? "Hide camera" : "Simulated camera"}
            </Button>
          )}
          <button className={`icon-btn with-label ${follow ? "on" : ""}`} onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
            <Crosshair size={18} />
            <span>Follow truck</span>
          </button>
        </div>
        {sim.note && sim.tripId === trip.id && <p className="sim-note">{sim.note}</p>}
        {ops && next && !blocked && !running && activeTrip(trip) && trip.dispatchedAt && (
          <button className="link-btn" onClick={() => run({ type: "trip.arrive", tripId: trip.id, stopId: next.id }, `Marked at ${placeName(data, next.placeId)}.`)}>
            Mark arrived at {placeName(data, next.placeId)}
          </button>
        )}
        <div className="track-stops">
          <StopsTimeline trip={trip} />
        </div>
        <p className="track-foot">Last position {trip.tracking ? `${day(trip.tracking.at)}, ${hm(trip.tracking.at)}` : "not yet"}</p>
      </motion.aside>
    </motion.div>,
    document.body,
  );
}
