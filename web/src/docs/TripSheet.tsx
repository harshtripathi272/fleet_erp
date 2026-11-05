import { useApp } from "../store";
import { byId, loadedKm, toZmw, tripFuelUsed, tripKm, volume20 } from "../domain/calc";
import { placeName, routeLabel } from "../domain/helpers";
import { BrandMark } from "../ui/brand";
import { cash, clock, day, num, stamp } from "../ui/format";

const n0 = (v?: number) => (v == null ? "—" : num(v));

export function TripSheet({ tripId }: { tripId: string }) {
  const { data } = useApp();
  const trip = byId(data.trips, tripId);
  if (!trip) return null;
  const truck = byId(data.trucks, trip.truckId)!;
  const trailer = byId(data.trailers, trip.trailerId);
  const driver = byId(data.drivers, trip.driverId);
  const customer = byId(data.customers, trip.customerId);
  const settlement = byId(data.settlements, trip.settlementId);
  const consignments = data.consignments.filter((c) => c.tripId === trip.id);
  const requests = data.requests.filter((r) => r.tripId === trip.id && r.status === "issued");
  const expenses = data.expenses.filter((e) => e.tripId === trip.id);
  const docs = data.docs.filter((d) => d.tripId === trip.id);
  const total = tripKm(trip);
  const loaded = loadedKm(trip);
  const used = tripFuelUsed(data, trip);
  const fuelIssued = requests.filter((r) => r.kind === "fuel").reduce((s, r) => s + r.amount, 0);
  const advances = requests.filter((r) => r.kind === "cash").reduce((s, r) => s + toZmw(data, r.amount, r.currency, r.fxAtIssue), 0);
  const approved = expenses.filter((e) => e.status === "approved").reduce((s, e) => s + e.amountZmw, 0);
  const shortage = consignments.reduce((s, c) => s + (c.shortage?.status === "charged" ? c.shortage.amountZmw : 0), 0);
  const days = trip.endedAt && trip.dispatchedAt ? Math.max(1, Math.ceil((Date.parse(trip.endedAt) - Date.parse(trip.dispatchedAt)) / 864e5)) : undefined;
  const c = consignments[0];
  const product = byId(data.products, c?.productId ?? trip.productId);
  const fuelCargo = product?.kind === "fuel";
  return (
    <article className="paper sheet">
      <header className="sheet-head">
        <div className="sheet-brand">
          <BrandMark size={34} />
          <div>
            <strong>{data.settings.company}</strong>
            <span>{[data.settings.office, data.settings.officeAddress].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <div className="sheet-title">
          <h1>Trip sheet</h1>
          <span className="mono">{trip.no}</span>
          {settlement && <span className="mono">{settlement.no}</span>}
        </div>
        <div className="sheet-plate">
          <span>Truck</span>
          <strong>{truck.plate}</strong>
        </div>
      </header>

      <section className="sheet-boxes">
        <div className="sheet-box">
          <h2>Trip</h2>
          <dl>
            <dt>Customer</dt>
            <dd className="wrap">{customer?.name}</dd>
            <dt>Route</dt>
            <dd className="wrap">{routeLabel(data, trip)}</dd>
            <dt>Driver</dt>
            <dd className="wrap">{driver?.name ?? "—"}</dd>
            <dt>Trailer</dt>
            <dd className="wrap">{trailer ? `${trailer.plate} · ${trailer.type}` : "—"}</dd>
            <dt>Left</dt>
            <dd>{stamp(trip.dispatchedAt)}</dd>
            <dt>Ended</dt>
            <dd>{stamp(trip.endedAt)}</dd>
            <dt>Days</dt>
            <dd>{days ?? "—"}</dd>
          </dl>
        </div>
        <div className="sheet-box">
          <h2>Load</h2>
          <dl>
            <dt>Product</dt>
            <dd className="wrap">{product?.name ?? "—"}</dd>
            {fuelCargo ? (
              <>
                <dt>Loaded, observed</dt>
                <dd>{n0(c?.load.ambientL)} L</dd>
                <dt>Loaded at 20 °C</dt>
                <dd>{n0(volume20(c?.load))} L</dd>
                <dt>Delivered, observed</dt>
                <dd>{n0(c?.delivered?.ambientL)} L</dd>
                <dt>Delivered at 20 °C</dt>
                <dd>{n0(volume20(c?.delivered))} L</dd>
                <dt>Loss, allowance {c?.shortage?.allowancePct ?? 0.3}%</dt>
                <dd>
                  {n0(c?.shortage?.lossL)}, {n0(c?.shortage?.allowanceL)} {c?.shortage?.unit ?? "L"}
                </dd>
                <dt>Net shortage</dt>
                <dd>{c?.shortage ? `${n0(c.shortage.netShortL)} ${c.shortage.unit}` : "—"}</dd>
                <dt>Charged to driver</dt>
                <dd>{c?.shortage?.status === "charged" ? `${n0(c.shortage.amountZmw)} ZMW` : c?.shortage?.status === "waived" ? "Waived" : "—"}</dd>
              </>
            ) : (
              <>
                <dt>Loaded</dt>
                <dd>{c ? `${num(c.load.qty, 2)} ${c.load.unit}` : "—"}</dd>
                <dt>Delivered</dt>
                <dd>{c?.delivered ? `${num(c.delivered.qty, 2)} ${c.delivered.unit}` : "—"}</dd>
              </>
            )}
            <dt>Invoice</dt>
            <dd className="mono">{c?.invoiceNo ?? "—"}</dd>
            <dt>Delivery note</dt>
            <dd className="mono">{c?.delivered?.podNo ?? "—"}</dd>
          </dl>
        </div>
        <div className="sheet-box">
          <h2>Mileage and fuel</h2>
          <dl>
            <dt>Distance</dt>
            <dd>{n0(total)} km</dd>
            <dt>Loaded | empty</dt>
            <dd>
              {n0(loaded)} | {n0(total - loaded)} km
            </dd>
            <dt>Fuel at start</dt>
            <dd>{n0(trip.openingFuelL)} L</dd>
            <dt>Issued</dt>
            <dd>{n0(fuelIssued)} L</dd>
            <dt>Left at end</dt>
            <dd>{n0(trip.closingFuelL)} L</dd>
            <dt>Used | budget</dt>
            <dd>
              {n0(used)} | {n0(trip.fuelBudgetL)} L
            </dd>
            <dt>Fuel ratio</dt>
            <dd>{used ? `${num(total / used, 2)} km/L` : "—"}</dd>
          </dl>
        </div>
      </section>

      <section className="sheet-section">
        <h2>Vehicle movement</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Place</th>
              <th>Stop</th>
              <th className="r">Km</th>
              <th>Arrived</th>
              <th>Left</th>
            </tr>
          </thead>
          <tbody>
            {trip.stops.map((s, i) => (
              <tr key={s.id}>
                <td>{i + 1}</td>
                <td>{placeName(data, s.placeId)}</td>
                <td>
                  {s.kind === "via" || s.kind === "border"
                    ? byId(data.places, s.placeId)?.kind === "border"
                      ? "Border"
                      : "On the way"
                    : { start: "Start", load: "Loading", offload: "Offloading", end: "End" }[s.kind]}
                </td>
                <td className="r">{n0(s.legKm)}</td>
                <td>{stamp(s.arrivedAt)}</td>
                <td>{s.kind === "end" ? "" : stamp(s.leftAt)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td className="r">{n0(total)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </section>

      <div className="sheet-two">
        <section className="sheet-section">
          <h2>Advances and fuel</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>Paid by</th>
                <th className="r">Litres</th>
                <th className="r">ZMW</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{day(r.issuedAt)}</td>
                  <td className="mono">{r.reference}</td>
                  <td>{r.medium}</td>
                  <td className="r">{r.kind === "fuel" ? n0(r.amount) : ""}</td>
                  <td className="r">{r.kind === "cash" ? n0(toZmw(data, r.amount, r.currency, r.fxAtIssue)) : ""}</td>
                </tr>
              ))}
              {!requests.length && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    None
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total</td>
                <td className="r">{n0(fuelIssued)}</td>
                <td className="r">{n0(advances)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
        <section className="sheet-section">
          <h2>Expenses</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Receipt</th>
                <th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className={e.status !== "approved" ? "struck" : ""}>
                  <td>{day(e.at)}</td>
                  <td>{byId(data.categories, e.categoryId)?.name}</td>
                  <td className="mono">{e.receiptNo ?? "—"}</td>
                  <td className="r">{cash(e.amount, e.currency)}</td>
                </tr>
              ))}
              {!expenses.length && (
                <tr>
                  <td colSpan={4} className="empty-row">
                    None
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Approved, in ZMW</td>
                <td className="r">{n0(approved)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      </div>

      <section className="sheet-summary">
        <div>
          <span>Advances paid</span>
          <strong>{n0(advances)}</strong>
        </div>
        <span className="op">−</span>
        <div>
          <span>Approved expenses</span>
          <strong>{n0(approved)}</strong>
        </div>
        <span className="op">+</span>
        <div>
          <span>Shortage charged</span>
          <strong>{n0(shortage)}</strong>
        </div>
        <span className="op">=</span>
        <div className="final">
          <span>Left with the driver, ZMW</span>
          <strong>{n0(advances - approved + shortage)}</strong>
        </div>
      </section>

      <section className="sheet-section">
        <h2>Documents</h2>
        <p className="sheet-docs">
          {docs.length
            ? docs.map((d) => `${d.file?.name ?? "Message"} (${d.kind}, ${d.status}${d.recordRef ? ` as ${d.recordRef}` : ""})`).join(" · ")
            : "None"}
        </p>
      </section>

      <footer className="sheet-sign">
        {["Operations", "Finance", "Driver"].map((who) => (
          <div key={who}>
            <span className="sign-line" />
            <span>
              {who}
              {who === "Operations" ? ` · ${data.settings.people.operations}` : who === "Finance" ? ` · ${data.settings.people.finance}` : driver ? ` · ${driver.name}` : ""}
            </span>
          </div>
        ))}
      </footer>
      <div className="sheet-print-foot">
        <span>
          {trip.no} · printed {stamp(new Date(clock(data)).toISOString())}
        </span>
        <span>{settlement ? `Settled in ${settlement.no}` : trip.endedAt ? "Awaiting settlement" : "Trip in progress"}</span>
      </div>
    </article>
  );
}
