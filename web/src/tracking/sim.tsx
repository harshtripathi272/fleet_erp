import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useApp } from "../store";
import { byId, cumulativeKm } from "../domain/calc";
import { placeName } from "../domain/helpers";
import { holdingStop, nextStep } from "../domain/turn";

interface Sim {
  tripId?: string;
  running: boolean;
  note?: string;
  speed: number;
  start: (tripId: string) => void;
  stop: () => void;
  setSpeed: (value: number) => void;
}
const SimContext = createContext<Sim>({ running: false, speed: 1, start: () => {}, stop: () => {}, setSpeed: () => {} });
export const useSim = () => useContext(SimContext);

const TICK_MS = 450;
const SIM_MINUTES = 9;

/** Time-lapse driver: moves one trip along its road, advancing the shared demo clock. */
export function SimProvider({ children }: { children: ReactNode }) {
  const { data, run } = useApp();
  const [tripId, setTripId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string>();
  const [speed, setSpeed] = useState(1);
  const latest = useRef(data);
  latest.current = data;
  const hold = useRef(0);

  const stop = useCallback(() => setRunning(false), []);
  const start = useCallback((id: string) => {
    setTripId(id);
    setNote(undefined);
    setRunning(true);
  }, []);

  useEffect(() => {
    if (!running || !tripId) return;
    const timer = window.setInterval(() => {
      const d = latest.current;
      const trip = byId(d.trips, tripId);
      if (!trip || !trip.dispatchedAt || trip.endedAt) {
        setRunning(false);
        return;
      }
      const cum = cumulativeKm(trip);
      const at = trip.tracking?.km ?? 0;
      const total = cum.at(-1) ?? 0;
      const holding = holdingStop(d, trip);
      const wall = holding >= 0 ? cum[holding] : total;
      if (at >= wall - 0.01) {
        setRunning(false);
        if ((trip.tracking?.speed ?? 0) > 0) run({ type: "trip.ping", tripId, km: at, speed: 0 });
        // The same sentence as the trip page.
        setNote(holding >= 0 ? nextStep(d, trip).waiting : "Arrived");
        return;
      }
      if (hold.current > 0) {
        hold.current -= 1;
        run({ type: "trip.ping", tripId, km: at, speed: 0, advanceMs: SIM_MINUTES * 6e4 * speed * 3 });
        return;
      }
      const kmh = 58 + Math.sin(Date.now() / 2400) * 9 + Math.random() * 6;
      const step = (kmh * SIM_MINUTES * speed) / 60;
      let next = Math.min(wall, at + step);
      const border = trip.stops.findIndex((s, i) => i > 0 && s.kind === "border" && !s.arrivedAt && cum[i] <= next);
      if (border > 0) {
        next = cum[border];
        hold.current = 3;
        setNote(`Clearing ${placeName(d, trip.stops[border].placeId)}`);
      } else if (hold.current === 0) setNote(undefined);
      const ok = run({ type: "trip.ping", tripId, km: next, speed: Math.round(kmh), advanceMs: SIM_MINUTES * 6e4 * speed });
      if (!ok) setRunning(false);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, tripId, run, speed]);

  return <SimContext.Provider value={{ tripId, running, note, speed, start, stop, setSpeed }}>{children}</SimContext.Provider>;
}
