import { Maximize2, Phone } from "lucide-react";
import { useApp } from "../store";
import { byId, funding, fuelNow } from "../domain/calc";
import { activeTrip } from "../domain/helpers";
import type { Trip } from "../domain/types";
import { MiniRoute } from "../tracking/MiniRoute";
import { ago, L, zmw } from "../ui/format";
import { Avatar } from "../ui/kit";

export function TripAside({ trip }: { trip: Trip }) {
  const { data, setOverlay } = useApp();
  const f = funding(data, trip);
  const events = data.events.filter((e) => e.tripId === trip.id).slice().reverse();
  const driver = byId(data.drivers, trip.driverId);
  const customer = byId(data.customers, trip.customerId);
  const live = trip.dispatchedAt && activeTrip(trip);
  return (
    <aside className="trip-aside">
      {trip.stops.length > 0 && (
        <section className="aside-card map-card">
          <MiniRoute stops={trip.stops} trip={trip} height={170} />
          {trip.dispatchedAt && (
            <button className="map-card-open" onClick={() => setOverlay({ tracking: trip.id })}>
              <Maximize2 size={15} />
              <span>Live map</span>
            </button>
          )}
          {live && (
            <div className="map-card-foot">
              <span className="live-dot" aria-hidden />
              {Math.round(trip.tracking?.speed ?? 0) > 0 ? `${Math.round(trip.tracking?.speed ?? 0)} km/h` : "Stopped"} · {L(fuelNow(data, trip))} in the tank
            </div>
          )}
        </section>
      )}
      <section className="aside-card">
        <div className="aside-money">
          <div>
            <span>Fuel</span>
            <strong>{L(f.fuel.issued + f.fuel.onTruck)}</strong>
            <small>of {L(f.fuel.budget)} budget</small>
          </div>
          <div>
            <span>Cash with driver</span>
            <strong>{zmw(Math.max(0, f.cash.holds) + f.cash.issued)}</strong>
            <small>of {zmw(f.cash.budget)} budget</small>
          </div>
        </div>
      </section>
      <section className="aside-card people">
        {driver && (
          <div className="person">
            <Avatar name={driver.name} tone="sky" size={34} />
            <span>
              <strong>{driver.name}</strong>
              <span className="mono muted">{driver.phone}</span>
            </span>
            <a className="icon-btn with-label" href={`tel:${driver.phone.replace(/\s/g, "")}`} aria-label={`Call ${driver.name}`}>
              <Phone size={16} />
              <span>Call</span>
            </a>
          </div>
        )}
        {customer && (
          <div className="person">
            <Avatar name={customer.name} size={34} />
            <span>
              <strong>{customer.name}</strong>
              <span className="muted">{customer.contact}</span>
            </span>
          </div>
        )}
      </section>
      <section className="aside-card">
        <h3 className="aside-title">Activity</h3>
        <ol className="activity">
          {events.slice(0, 14).map((e) => (
            <li key={e.id}>
              <span className={`act-dot act-${e.role}`} aria-hidden />
              <span className="act-text">{e.text}</span>
              <span className="act-time">{ago(data, e.at)}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
