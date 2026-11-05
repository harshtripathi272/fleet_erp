import { usePlacement } from "./usePlacement";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, FileText, Search } from "lucide-react";
import { useApp } from "../store";
import { useMay } from "../api/session";
import { byId, driverBalance, driverLedger, round } from "../domain/calc";
import { routeLabel, toSettle } from "../domain/helpers";
import type { Driver } from "../domain/types";
import { Avatar, Button, Empty, Field, Segmented, Status } from "../ui/kit";
import { ago, day, dayYear, inBase, baseLabel } from "../ui/format";
import { Card } from "./stages";

export function Accounts({ driverId, onDriver }: { driverId?: string; onDriver: (id: string | undefined) => void }) {
  const { data } = useApp();
  const [query, setQuery] = useState("");
  const rows = data.drivers
    .map((d) => ({
      driver: d,
      balance: driverBalance(data, d.id),
      open: data.trips.filter((t) => t.driverId === d.id && toSettle(t)).length,
      onTrip: data.trips.some((t) => t.driverId === d.id && t.dispatchedAt && !t.endedAt),
    }))
    .filter((r) => r.driver.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.open - a.open || Math.abs(b.balance) - Math.abs(a.balance));
  const selected = byId(data.drivers, driverId);
  useEffect(() => {
    if (!selected && rows[0] && window.innerWidth > 900) onDriver(rows[0].driver.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  return (
    <div className={`accounts ${selected ? "has-selection" : ""}`}>
      <section className="acc-list-pane">
        <div className="search">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a driver" aria-label="Find a driver" />
        </div>
        <div className="acc-list">
          {rows.map(({ driver, balance, open, onTrip }) => (
            <button key={driver.id} className={`acc-row ${driver.id === selected?.id ? "on" : ""}`} onClick={() => onDriver(driver.id)}>
              <Avatar name={driver.name} tone="sky" size={34} />
              <span className="acc-who">
                <strong>{driver.name}</strong>
                <span className="muted">
                  {open ? `${open} to settle` : onTrip ? "On a trip" : "No open trips"}
                  {driver.settleRequestedAt ? " · requested" : ""}
                </span>
              </span>
              <span className={`balance ${balance > 0 ? "holds" : balance < 0 ? "owed" : ""}`}>{balance ? inBase(Math.abs(balance)) : "Clear"}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="acc-detail-pane">
        {selected ? <DriverAccount key={selected.id} driver={selected} onBack={() => onDriver(undefined)} /> : <Empty title="Pick a driver" />}
      </section>
    </div>
  );
}

function DriverAccount({ driver, onBack }: { driver: Driver; onBack: () => void }) {
  const { data } = useApp();
  const may = useMay();
  const [tab, setTab] = useState<"settle" | "ledger" | "history">("settle");
  const balance = driverBalance(data, driver.id);
  const history = data.settlements.filter((s) => s.driverId === driver.id).slice().reverse();
  return (
    <article className="account">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Drivers
      </button>
      <header className="account-head">
        <Avatar name={driver.name} tone="sky" size={48} />
        <div>
          <h2>{driver.name}</h2>
          <span className="muted mono">
            {driver.phone} · {driver.licence}
          </span>
        </div>
        <div className={`account-balance ${balance > 0 ? "holds" : balance < 0 ? "owed" : ""}`}>
          <span>{balance > 0 ? "Holds company cash" : balance < 0 ? "Company owes" : "Account"}</span>
          <strong className="num">{balance ? inBase(Math.abs(balance)) : "Clear"}</strong>
        </div>
      </header>
      <Segmented
        label="Account view"
        value={tab}
        onChange={setTab}
        options={[
          { value: "settle", label: may("settlement.post") ? "Statement" : "Next statement" },
          { value: "ledger", label: "All movements" },
          { value: "history", label: "Past statements", count: history.length },
        ]}
      />
      {tab === "settle" && <StatementBuilder driver={driver} />}
      {tab === "ledger" && <Ledger driver={driver} />}
      {tab === "history" && <History driver={driver} />}
    </article>
  );
}

function StatementBuilder({ driver }: { driver: Driver }) {
  const { data, run, setOverlay } = useApp();
  const may = useMay();
  const closed = data.trips.filter((t) => t.driverId === driver.id && toSettle(t));
  const [picked, setPicked] = useState<string[]>(() => closed.map((t) => t.id));
  useEffect(() => {
    setPicked(closed.map((t) => t.id));
  }, [closed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const ledger = driverLedger(data, driver.id);
  const set = new Set(picked);
  const lines = ledger.filter((e) => e.tripId && set.has(e.tripId) && !e.settlementId);
  const balance = ledger.reduce((s, e) => s + e.amountBase, 0);
  const opening = round(balance - lines.reduce((s, e) => s + e.amountBase, 0));
  const due = round(opening + lines.reduce((s, e) => s + e.amountBase, 0));
  const [cashText, setCashText] = useState("");
  const cashValue = cashText === "" ? due : Number(cashText);
  const closing = round(due - cashValue);
  const blockers = useMemo(
    () =>
      picked.flatMap((id) => {
        const t = byId(data.trips, id)!;
        const out: string[] = [];
        if (data.expenses.some((e) => e.tripId === id && e.status === "pending")) out.push(`${t.no}: expense to decide`);
        if (data.docs.some((d) => d.tripId === id && d.status === "new" && (d.kind === "expense" || d.kind === "fuel"))) out.push(`${t.no}: receipt to check`);
        if (data.consignments.some((c) => c.tripId === id && c.shortage?.status === "pending")) out.push(`${t.no}: fuel shortage to decide`);
        return out;
      }),
    [data, picked],
  );
  const finance = may("settlement.post");
  const company = usePlacement("settlements", "post");
  // After posting, open the new statement once it arrives from the API.
  const [awaiting, setAwaiting] = useState<number | null>(null);
  useEffect(() => {
    if (awaiting === null) return;
    const mine = data.settlements.filter((s) => s.driverId === driver.id);
    if (mine.length > awaiting) {
      setOverlay({ document: { kind: "statement", id: mine.at(-1)!.id } });
      setAwaiting(null);
    }
  }, [awaiting, data.settlements, driver.id, setOverlay]);
  const post = async () => {
    const before = data.settlements.filter((s) => s.driverId === driver.id).length;
    if (await run({ type: "settlement.post", custom: company.custom, driverId: driver.id, tripIds: picked, cashBase: cashValue }, "Statement posted. The driver has it on WhatsApp.")) setAwaiting(before);
  };
  if (!closed.length)
    return (
      <Card>
        <Empty title="No closed trips to settle">
          <span>{balance ? `${inBase(Math.abs(balance))} carries into the next statement.` : "The account is clear."}</span>
        </Empty>
      </Card>
    );
  return (
    <div className="statement-builder">
      <Card title="Trips in this statement">
        <div className="trip-picks">
          {closed.map((t) => {
            const tripLines = ledger.filter((e) => e.tripId === t.id && !e.settlementId);
            const net = tripLines.reduce((s, e) => s + e.amountBase, 0);
            return (
              <label key={t.id} className={`trip-pick ${set.has(t.id) ? "on" : ""}`}>
                <span className="check">
                  <input
                    type="checkbox"
                    checked={set.has(t.id)}
                    disabled={!finance}
                    onChange={() => setPicked((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))}
                  />
                  <span />
                </span>
                <span className="trip-pick-text">
                  <strong>
                    <span className="mono">{t.no}</span> · {routeLabel(data, t)}
                  </strong>
                  <span className="muted">
                    {t.endedAt ? `${day(t.dispatchedAt)} to ${day(t.endedAt)}` : `Cancelled ${day(t.cancelledAt)}`} · {byId(data.trucks, t.truckId)?.plate}
                  </span>
                </span>
                <span className="num">{inBase(net)}</span>
              </label>
            );
          })}
        </div>
      </Card>
      <section className="statement-paper">
        <header>
          <span className="paper-kicker">Driver statement</span>
          <h3>{driver.name}</h3>
          <span className="muted">
            {picked.length} trip{picked.length === 1 ? "" : "s"} · {dayYear(new Date(Date.now() + data.settings.clockOffsetMs).toISOString())}
          </span>
        </header>
        <table className="recon">
          <tbody>
            <tr>
              <td>Brought forward</td>
              <td className="num">{inBase(opening)}</td>
            </tr>
            {lines.map((e) => (
              <tr key={e.id} className="line">
                <td>
                  {e.label}
                  <span className="muted mono"> {byId(data.trips, e.tripId)?.no}</span>
                </td>
                <td className="num">
                  {e.amountBase >= 0 ? "+" : "−"} {inBase(Math.abs(e.amountBase))}
                </td>
              </tr>
            ))}
            <tr className="sub">
              <td>{due >= 0 ? `${driver.name.split(" ")[0]} holds` : "Company owes"}</td>
              <td className="num">{inBase(Math.abs(due))}</td>
            </tr>
          </tbody>
        </table>
        {finance ? (
          <div className="statement-cash">
            <Field label={due >= 0 ? "Cash handed back now" : "Paid to the driver now"}>
              <span className="suffix">
                <input
                  type="number"
                  value={cashText === "" ? String(Math.abs(due)) : String(Math.abs(Number(cashText)))}
                  onChange={(e) => setCashText(String((due >= 0 ? 1 : -1) * Number(e.target.value)))}
                />
                <span>{baseLabel()}</span>
              </span>
            </Field>
            <div className="carry">
              <span>Carries forward</span>
              <strong className="num">{closing ? `${inBase(Math.abs(closing))}${closing < 0 ? " owed to driver" : ""}` : "Nothing"}</strong>
            </div>
          </div>
        ) : (
          <div className="carry">
            <span>Settled by Finance</span>
            <strong>{driver.settleRequestedAt ? `Asked ${ago(data, driver.settleRequestedAt)} ago` : ""}</strong>
          </div>
        )}
        {blockers.length > 0 && (
          <ul className="blockers">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <footer>
          {finance ? (
            <Button tone="primary" size="lg" disabled={!picked.length || blockers.length > 0 || !company.ready} onClick={post}>
              <Check /> Post statement
            </Button>
          ) : may("settlement.request") ? (
            <Button disabled={Boolean(driver.settleRequestedAt)} onClick={() => run({ type: "settlement.request", driverId: driver.id }, "Finance asked on WhatsApp.")}>
              {driver.settleRequestedAt ? "Finance has been asked" : "Ask Finance to settle"}
            </Button>
          ) : null}
          {data.settlements.some((s) => s.driverId === driver.id) && (
            <Button tone="quiet" onClick={() => setOverlay({ document: { kind: "statement", id: data.settlements.filter((s) => s.driverId === driver.id).at(-1)!.id } })}>
              <FileText /> Last statement
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}

function Ledger({ driver }: { driver: Driver }) {
  const { data } = useApp();
  const entries = driverLedger(data, driver.id);
  let running = 0;
  const rows = entries.map((e) => ({ ...e, running: (running += e.amountBase) })).reverse();
  return (
    <Card>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Movement</th>
            <th>Trip</th>
            <th className="right">Amount</th>
            <th className="right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{e.kind === "opening" ? "Opening" : day(e.at)}</td>
              <td>
                {e.label}
                {e.settlementId && e.settlementId !== "opening" && e.kind !== "cash" && <span className="settled-tag">settled</span>}
              </td>
              <td className="mono">{byId(data.trips, e.tripId)?.no ?? ""}</td>
              <td className={`right num ${e.amountBase < 0 ? "neg" : ""}`}>
                {e.amountBase >= 0 ? "+" : "−"}
                {inBase(Math.abs(e.amountBase))}
              </td>
              <td className="right num">{inBase(e.running)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function History({ driver }: { driver: Driver }) {
  const { data, setOverlay } = useApp();
  const list = data.settlements.filter((s) => s.driverId === driver.id).slice().reverse();
  if (!list.length)
    return (
      <Card>
        <Empty title="No statements yet" />
      </Card>
    );
  return (
    <Card>
      <div className="history">
        {list.map((s) => (
          <button key={s.id} className="history-row" onClick={() => setOverlay({ document: { kind: "statement", id: s.id } })}>
            <FileText size={18} />
            <span>
              <strong className="mono">{s.no}</strong>
              <span className="muted">
                {s.tripIds.length} trip{s.tripIds.length === 1 ? "" : "s"} · posted {dayYear(s.postedAt)}
              </span>
            </span>
            <Status tone={s.closingBase ? "info" : "ok"}>{s.closingBase ? `${inBase(Math.abs(s.closingBase))} carried` : "Cleared"}</Status>
          </button>
        ))}
      </div>
    </Card>
  );
}
