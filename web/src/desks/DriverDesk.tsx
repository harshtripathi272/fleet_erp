import { useState } from "react";
import { useBrand } from "../ui/brand";
import { AnimatePresence, motion } from "motion/react";
import { Camera, ChevronRight, Fuel, MapPin, Wallet } from "lucide-react";
import { useApp } from "../store";
import { byId, driverBalance, fuelNow, volume20 } from "../domain/calc";
import { activeTrip, placeName, routeLabel } from "../domain/helpers";
import { nextStep } from "../domain/turn";
import type { DocKind, Trip } from "../domain/types";
import { Device } from "../phone/Device";
import { BotAvatar, WhatsApp } from "../phone/WhatsApp";
import { AttachSheet } from "../phone/Attach";
import { DocThumb } from "../docs/DocThumb";
import { Segmented } from "../ui/kit";
import { day, hm, L, stamp, zmw } from "../ui/format";

const DOC_LABEL: Record<DocKind, string> = {
  loading: "Loading invoice",
  delivery: "Delivery note",
  expense: "Receipt",
  fuel: "Fuel slip",
  other: "Message",
};

export function DriverDesk() {
  const { data, driverId } = useApp();
  const brand = useBrand();
  const [app, setApp] = useState<"whatsapp" | "driver">("whatsapp");
  const driver = byId(data.drivers, driverId)!;
  const trip = data.trips.filter((t) => t.driverId === driver.id && activeTrip(t)).at(-1) ?? data.trips.filter((t) => t.driverId === driver.id && !t.cancelledAt).at(-1);
  const thread = `driver:${driver.id}`;
  return (
    <div className="driver-desk">
      <TripSlip trip={trip} />
      <div className="driver-stage">
        <Segmented
          label="Phone app"
          value={app}
          onChange={setApp}
          options={[
            { value: "whatsapp", label: "WhatsApp" },
            { value: "driver", label: `${brand.shortName} driver app` },
          ]}
        />
        <motion.div className="driver-phone" initial={{ y: 40, rotateX: 14, opacity: 0 }} animate={{ y: 0, rotateX: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 20 }}>
          <Device>
            <AnimatePresence mode="wait" initial={false}>
              {app === "whatsapp" ? (
                <motion.div key="wa" className="app-fill" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.02 }} transition={{ duration: 0.18 }}>
                  <WhatsApp threads={[{ key: thread, name: brand.productName, status: "Business account", avatar: <BotAvatar /> }]} driverId={driver.id} tripId={trip?.id} />
                </motion.div>
              ) : (
                <motion.div key="app" className="app-fill" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.02 }} transition={{ duration: 0.18 }}>
                  <DriverApp trip={trip} />
                </motion.div>
              )}
            </AnimatePresence>
          </Device>
        </motion.div>
      </div>
    </div>
  );
}

/** The paper slip a driver carries: what the trip is, in one glance. */
function TripSlip({ trip }: { trip?: Trip }) {
  const { data, driverId } = useApp();
  const driver = byId(data.drivers, driverId)!;
  const balance = driverBalance(data, driver.id);
  if (!trip)
    return (
      <aside className="slip">
        <span className="slip-kicker">No trip assigned</span>
        <h2>{driver.name}</h2>
      </aside>
    );
  const truck = byId(data.trucks, trip.truckId);
  const trailer = byId(data.trailers, trip.trailerId);
  const load = trip.stops.find((s) => s.kind === "load");
  const offload = trip.stops.find((s) => s.kind === "offload");
  const cargo = data.consignments.find((c) => c.tripId === trip.id);
  const product = byId(data.products, cargo?.productId ?? trip.productId);
  return (
    <aside className="slip">
      <div className="slip-top">
        <span className="slip-kicker">Trip slip</span>
        <span className="mono">{trip.no}</span>
      </div>
      <h2>{driver.name}</h2>
      <div className="slip-route">
        <div>
          <span>Load at</span>
          <strong>{placeName(data, load?.placeId)}</strong>
          <small>{load?.arrivedAt ? `Arrived ${day(load.arrivedAt)}, ${hm(load.arrivedAt)}` : ""}</small>
        </div>
        <span className="slip-arrow" aria-hidden />
        <div>
          <span>Offload at</span>
          <strong>{placeName(data, offload?.placeId)}</strong>
          <small>{offload?.arrivedAt ? `Arrived ${day(offload.arrivedAt)}, ${hm(offload.arrivedAt)}` : ""}</small>
        </div>
      </div>
      <dl className="slip-grid">
        <div>
          <dt>Truck</dt>
          <dd>{truck?.plate}</dd>
        </div>
        <div>
          <dt>Trailer</dt>
          <dd>{trailer?.plate ?? "—"}</dd>
        </div>
        <div>
          <dt>Cargo</dt>
          <dd>{cargo ? (cargo.load.unit === "L" ? `${L(volume20(cargo.load))} at 20 °C` : `${cargo.load.qty} ${cargo.load.unit}`) : product?.name ?? "On the invoice"}</dd>
        </div>
        <div>
          <dt>Customer</dt>
          <dd>{byId(data.customers, trip.customerId)?.name}</dd>
        </div>
        <div>
          <dt>Fuel in tank</dt>
          <dd>{L(fuelNow(data, trip))}</dd>
        </div>
        <div>
          <dt>{balance >= 0 ? "Company cash with you" : "Company owes you"}</dt>
          <dd>{zmw(Math.abs(balance))}</dd>
        </div>
      </dl>
      <div className="slip-tear" aria-hidden />
      <div className="slip-foot">
        <span>{routeLabel(data, trip)}</span>
        <span>{stamp(trip.plannedStart)}</span>
      </div>
    </aside>
  );
}

function DriverApp({ trip }: { trip?: Trip }) {
  const { data, driverId } = useApp();
  const [attach, setAttach] = useState<DocKind | null>(null);
  const driver = byId(data.drivers, driverId)!;
  const balance = driverBalance(data, driver.id);
  const step = trip ? nextStep(data, trip) : undefined;
  const need: DocKind | undefined = step?.actor === "driver" ? (step.stage === "loading" ? "loading" : "delivery") : undefined;
  const docs = data.docs.filter((d) => d.driverId === driver.id).slice().reverse().slice(0, 8);
  const updates = data.messages.filter((m) => m.thread === `driver:${driver.id}` && m.from === "bot" && m.title).slice(-5).reverse();
  const parkedAt = trip && !trip.endedAt ? trip.stops.find((s, i) => i > 0 && s.arrivedAt && !s.leftAt) : undefined;
  const nextStop = parkedAt ?? trip?.stops.find((s, i) => i > 0 && !s.arrivedAt);
  return (
    <div className="dapp">
      <header className="dapp-head">
        <span>Good day, {driver.name.split(" ")[0]}</span>
        <strong>{trip ? trip.no : "No trip"}</strong>
      </header>
      <div className="dapp-scroll">
        {need ? (
          <button className="dapp-need" onClick={() => setAttach(need)}>
            <span className="dapp-need-icon">
              <Camera size={22} />
            </span>
            <span>
              <small>Needed now</small>
              <strong>Send the {need === "loading" ? "loading invoice" : "delivery note"}</strong>
            </span>
            <ChevronRight size={18} />
          </button>
        ) : (
          step && (
            <div className="dapp-state">
              <small>{step.actor === "done" ? "Trip" : step.actor === "road" ? "Now" : "Office"}</small>
              <strong>{step.actor === "road" ? step.title : step.actor === "done" ? "Settled" : step.waiting}</strong>
            </div>
          )
        )}
        {trip && (
          <section className="dapp-card">
            <div className="dapp-row">
              <MapPin size={17} />
              <span>
                <small>{parkedAt ? "You are at" : "Next stop"}</small>
                <strong>{nextStop ? placeName(data, nextStop.placeId) : "Trip complete"}</strong>
              </span>
            </div>
            <div className="dapp-row">
              <Fuel size={17} />
              <span>
                <small>Fuel in tank</small>
                <strong>{L(fuelNow(data, trip))}</strong>
              </span>
            </div>
            <div className="dapp-row">
              <Wallet size={17} />
              <span>
                <small>{balance >= 0 ? "Company cash with you" : "Company owes you"}</small>
                <strong>{zmw(Math.abs(balance))}</strong>
              </span>
            </div>
          </section>
        )}
        <div className="dapp-actions">
          <button onClick={() => setAttach("expense")}>Send a receipt</button>
          <button onClick={() => setAttach("other")}>Report something</button>
        </div>
        <h4 className="dapp-h">Sent</h4>
        <div className="dapp-sent">
          {docs.map((d) => {
            const expense = data.expenses.find((e) => e.docId === d.id);
            const status =
              d.status === "returned"
                ? ["Send again", "bad"]
                : d.status === "new"
                  ? ["Being checked", "wait"]
                  : expense?.status === "pending"
                    ? ["With Finance", "wait"]
                    : expense?.status === "rejected"
                      ? ["Not accepted", "bad"]
                      : ["Accepted", "ok"];
            return (
              <div key={d.id} className="dapp-doc">
                <DocThumb doc={d} />
                <span>
                  <strong>{DOC_LABEL[d.kind]}</strong>
                  <small>{d.returnReason ?? `${day(d.at)}, ${hm(d.at)}`}</small>
                </span>
                <em className={status[1]}>{status[0]}</em>
              </div>
            );
          })}
          {!docs.length && <p className="dapp-empty">Nothing sent yet</p>}
        </div>
        <h4 className="dapp-h">Updates</h4>
        <div className="dapp-updates">
          {updates.map((m) => (
            <div key={m.id}>
              <strong>{m.title}</strong>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      </div>
      <AttachSheet open={attach !== null} kind={attach ?? undefined} driverId={driver.id} tripId={trip?.id} channel="App" onClose={() => setAttach(null)} onSent={() => setAttach(null)} />
    </div>
  );
}
