import { ArrowRight } from "lucide-react";
import { useApp } from "../store";
import { byId, driverBalance } from "../domain/calc";
import { activeTrip } from "../domain/helpers";
import { nextStep, queueFor, stageIndex, visibleStages } from "../domain/turn";
import { FleetMap } from "../tracking/FleetMap";
import { ago, L, zmw } from "../ui/format";
import { Card } from "./stages";
import { Approval } from "./Finance";

export function Overview() {
  const { data, nav } = useApp();
  const active = data.trips.filter(activeTrip);
  const onRoad = active.filter((t) => t.dispatchedAt);
  const owner = data.requests.filter((r) => r.status === "owner" && r.mayDecide);
  const weekAgo = new Date(Date.now() + data.settings.clockOffsetMs - 7 * 864e5).toISOString();
  const fuelWeek = data.requests.filter((r) => r.kind === "fuel" && r.status === "issued" && (r.issuedAt ?? "") > weekAgo).reduce((s, r) => s + r.amount, 0);
  const cashOut = data.drivers.reduce((s, d) => s + Math.max(0, driverBalance(data, d.id)), 0);
  const byStage = visibleStages(data).map((s) => ({
    ...s,
    trips: data.trips.filter((t) => !t.cancelledAt && !t.settlementId && nextStep(data, t).stage === s.id),
  }));
  const max = Math.max(1, ...byStage.map((s) => s.trips.length));
  const waiting = { operations: queueFor(data, "operations").length, finance: queueFor(data, "finance").length };
  return (
    <div className="desk overview">
      <div className="kpis">
        <div className="kpi">
          <span>On the road</span>
          <strong className="num">{onRoad.length}</strong>
        </div>
        <div className="kpi">
          <span>Planned</span>
          <strong className="num">{active.length - onRoad.length}</strong>
        </div>
        <div className="kpi">
          <span>Cash with drivers</span>
          <strong className="num">{zmw(cashOut)}</strong>
        </div>
        <div className="kpi">
          <span>Fuel issued, 7 days</span>
          <strong className="num">{L(fuelWeek)}</strong>
        </div>
      </div>
      {owner.length > 0 && (
        <Card title={`Needs your approval (${owner.length})`}>
          <div className="approvals">
            {owner.map((r) => (
              <Approval key={r.id} request={r} picked={false} />
            ))}
          </div>
        </Card>
      )}
      <div className="overview-grid">
        <Card title="Fleet now" aside={<span className="muted">{onRoad.length} moving · {data.trucks.length - active.length} free</span>}>
          <FleetMap onTrip={(id) => nav({ tripId: id })} />
        </Card>
        <Card title="Where trips are">
          <div className="stage-bars">
            {byStage.map((s) => (
              <div key={s.id} className="stage-bar">
                <span>{s.label}</span>
                <span className="stage-bar-track">
                  <i style={{ width: `${(s.trips.length / max) * 100}%` }} />
                </span>
                <b className="num">{s.trips.length}</b>
              </div>
            ))}
          </div>
          <div className="desk-waits">
            <div>
              <span>Operations has</span>
              <strong>{waiting.operations} to do</strong>
            </div>
            <div>
              <span>Finance has</span>
              <strong>{waiting.finance} to do</strong>
            </div>
          </div>
        </Card>
      </div>
      <Card title="Latest">
        <ol className="feed">
          {data.events
            .slice(-12)
            .reverse()
            .map((e) => {
              const trip = byId(data.trips, e.tripId);
              return (
                <li key={e.id}>
                  <span className={`act-dot act-${e.role}`} aria-hidden />
                  <span className="feed-text">
                    {trip && <b className="plate-sm">{byId(data.trucks, trip.truckId)?.plate}</b>} {e.text}
                  </span>
                  <span className="muted">{ago(data, e.at)}</span>
                  {trip && (
                    <button className="icon-btn with-label" aria-label={`Open ${trip.no}`} onClick={() => nav({ tripId: trip.id })}>
                      <span>Open</span>
                      <ArrowRight size={15} />
                    </button>
                  )}
                </li>
              );
            })}
        </ol>
      </Card>
    </div>
  );
}

export { stageIndex };
