import { useApp } from "../store";
import { byId, driverLedger, tripKm } from "../domain/calc";
import { routeLabel } from "../domain/helpers";
import { BrandMark } from "../ui/brand";
import { dayYear, num, stamp } from "../ui/format";

export function Statement({ id }: { id: string }) {
  const { data } = useApp();
  const s = byId(data.settlements, id);
  if (!s) return null;
  const driver = byId(data.drivers, s.driverId)!;
  const trips = s.tripIds.map((t) => byId(data.trips, t)!).filter(Boolean);
  const lines = driverLedger(data, driver.id).filter((e) => e.tripId && s.tripIds.includes(e.tripId));
  const before = s.openingZmw + s.advancesZmw - s.expensesZmw + s.shortagesZmw;
  return (
    <article className="paper statement">
      <header className="sheet-head">
        <div className="sheet-brand">
          <BrandMark size={34} />
          <div>
            <strong>{data.settings.company}</strong>
            <span>{data.settings.office} office</span>
          </div>
        </div>
        <div className="sheet-title">
          <h1>Driver settlement</h1>
          <span className="mono">{s.no}</span>
        </div>
        <div className="sheet-plate">
          <span>Posted</span>
          <strong className="small">{dayYear(s.postedAt)}</strong>
        </div>
      </header>
      <section className="statement-who">
        <div>
          <span>Driver</span>
          <strong>{driver.name}</strong>
          <span className="mono">
            {driver.phone} · {driver.licence}
          </span>
        </div>
        <div>
          <span>Period</span>
          <strong>
            {dayYear(s.from)} to {dayYear(s.to)}
          </strong>
          <span>
            {trips.length} trip{trips.length === 1 ? "" : "s"}, {num(trips.reduce((a, t) => a + tripKm(t), 0))} km
          </span>
        </div>
      </section>
      <section className="sheet-section">
        <h2>Trips</h2>
        <table>
          <thead>
            <tr>
              <th>Trip</th>
              <th>Route</th>
              <th>Truck</th>
              <th>Left</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.no}</td>
                <td>{routeLabel(data, t)}</td>
                <td>{byId(data.trucks, t.truckId)?.plate}</td>
                <td>{stamp(t.dispatchedAt)}</td>
                <td>{stamp(t.endedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="sheet-section">
        <h2>Account</h2>
        <table className="ledger">
          <tbody>
            <tr className="strong">
              <td>Brought forward</td>
              <td />
              <td className="r">{num(s.openingZmw, 2)}</td>
            </tr>
            {lines.map((e) => (
              <tr key={e.id}>
                <td>{e.label}</td>
                <td className="mono">{byId(data.trips, e.tripId)?.no}</td>
                <td className="r">
                  {e.amountZmw >= 0 ? "+" : "−"} {num(Math.abs(e.amountZmw), 2)}
                </td>
              </tr>
            ))}
            <tr className="strong">
              <td>{before >= 0 ? "Held by the driver" : "Owed to the driver"}</td>
              <td />
              <td className="r">{num(Math.abs(before), 2)}</td>
            </tr>
            <tr>
              <td>{s.cashZmw >= 0 ? "Cash handed back" : "Paid to the driver"}</td>
              <td />
              <td className="r">{num(Math.abs(s.cashZmw), 2)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>Carried forward, ZMW</td>
              <td />
              <td className="r">{num(s.closingZmw, 2)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
      <section className="statement-totals">
        <div>
          <span>Advances</span>
          <strong>{num(s.advancesZmw)}</strong>
        </div>
        <div>
          <span>Expenses</span>
          <strong>{num(s.expensesZmw)}</strong>
        </div>
        <div>
          <span>Shortage charged</span>
          <strong>{num(s.shortagesZmw)}</strong>
        </div>
        <div className="final">
          <span>Carried forward</span>
          <strong>{num(s.closingZmw)}</strong>
        </div>
      </section>
      <footer className="sheet-sign">
        {[`Finance · ${data.settings.people.finance}`, `Driver · ${driver.name}`].map((who) => (
          <div key={who}>
            <span className="sign-line" />
            <span>{who}</span>
          </div>
        ))}
      </footer>
      <div className="stamp-posted" aria-hidden>
        <span>Posted</span>
        <small>{dayYear(s.postedAt)}</small>
      </div>
    </article>
  );
}
