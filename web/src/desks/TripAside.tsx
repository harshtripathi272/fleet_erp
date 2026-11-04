import { Maximize2, Phone } from "lucide-react";
import { useApp } from "../store";
import { byId, driverLedger, funding, fuelNow } from "../domain/calc";
import { activeTrip } from "../domain/helpers";
import type { Trip } from "../domain/types";
import { MiniRoute } from "../tracking/MiniRoute";
import { ago, L, zmw } from "../ui/format";
import { Avatar } from "../ui/kit";

export function TripAside({ trip }: { trip: Trip }) {
  const { data, setOverlay } = useApp();
  const f = funding(data, trip);
  // Unsettled: what the driver holds now, the Driver accounts figure. Settled: this trip's advances less its approved receipts.
  const ledger = trip.driverId ? driverLedger(data, trip.driverId) : [];
  const own = ledger.filter((e) => e.tripId === trip.id && (e.kind === "advance" || e.kind === "expense"));
  const cash = Math.max(0, Math.round((trip.settlementId ? own : ledger).reduce((sum, e) => sum + e.amountZmw, 0)));
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
            <div className="map-card-foot">
              <span>{live ? <>{Math.round(trip.tracking?.speed ?? 0) > 0 ? `${Math.round(trip.tracking?.speed ?? 0)} km/h` : "Stopped"} · {L(fuelNow(data, trip))} in the tank</> : null}</span>
              <button className="link-btn" onClick={() => setOverlay({ tracking: trip.id })}>
                <Maximize2 size={14} /> Open map
              </button>
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
            {/* The driver ledger's figure (as on Driver accounts): advances paid less receipts approved. */}
            <span>{trip.settlementId ? "Cash on this trip" : "Cash with driver"}</span>
            <strong>{zmw(cash)}</strong>
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
              <span className="mono muted num">{driver.phone}</span>
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
