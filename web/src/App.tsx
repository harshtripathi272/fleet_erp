import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRightLeft,
  BookUser,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Gauge,
  Inbox,
  LayoutGrid,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Settings2,
  Truck,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { AppProvider, queryClient, resetSync, useApp, useSharedData } from "./store";
import type { Overlay, Toast } from "./store";
import { forDesk } from "./api/adapter";
import { ApiError, hasSession, onSignedOut } from "./api/client";
import { Refusal } from "./api/commands";
import { desksFor, signOut, SignIn, useMe, type Me } from "./api/session";
import { queueFor } from "./domain/turn";
import type { Action, Desk, Nav, Role } from "./domain/types";
import { Wordmark } from "./ui/brand";
import { Avatar, Modal } from "./ui/kit";
import { TripsPage } from "./desks/Trips";
import { FinanceToday } from "./desks/Finance";
import { Accounts } from "./desks/Accounts";
import { Nominations } from "./desks/Nominations";
import { MastersScreen } from "./masters/MastersScreen";
import { Overview } from "./desks/Overview";
import { DriverDesk } from "./desks/DriverDesk";
import { DeskPhone, MessageBanner } from "./phone/DeskPhone";
import { DocumentOverlay } from "./docs/DocumentOverlay";
import { SimProvider } from "./tracking/sim";

const Tracking = lazy(() => import("./tracking/Tracking"));

type View = "overview" | "today" | "trips" | "nominations" | "accounts" | "masters" | "driver";
interface Session {
  role?: Role;
  driverId?: string;
  view?: View;
  tripId?: string;
  stage?: string;
  accountDriverId?: string;
  masterEntity?: string;
}
const SESSION = "marichi.tripdesk.session";
const readSession = (): Session => {
  const params = new URLSearchParams(location.search);
  const desk = params.get("desk") as Role | null;
  if (desk && ["operations", "finance", "owner", "driver"].includes(desk)) {
    const session: Session = { role: desk, driverId: desk === "driver" ? params.get("driver") ?? undefined : undefined };
    sessionStorage.setItem(SESSION, JSON.stringify(session));
    history.replaceState(null, "", location.pathname);
    return session;
  }
  try {
    return JSON.parse(sessionStorage.getItem(SESSION) ?? "{}");
  } catch {
    return {};
  }
};

const NAV: Record<Role, { id: View; label: string; icon: typeof Truck }[]> = {
  operations: [
    { id: "trips", label: "Trips", icon: Truck },
    { id: "nominations", label: "Nominations", icon: ClipboardList },
    { id: "accounts", label: "Driver accounts", icon: Wallet },
    { id: "masters", label: "Masters", icon: Settings2 },
  ],
  finance: [
    { id: "today", label: "Approvals", icon: Inbox },
    { id: "trips", label: "Trips", icon: Truck },
    { id: "accounts", label: "Settlements", icon: Wallet },
    { id: "masters", label: "Masters", icon: Settings2 },
  ],
  owner: [
    { id: "overview", label: "Overview", icon: Gauge },
    { id: "trips", label: "Trips", icon: Truck },
    { id: "nominations", label: "Nominations", icon: ClipboardList },
    { id: "accounts", label: "Driver accounts", icon: Wallet },
    { id: "masters", label: "Masters", icon: Settings2 },
  ],
  driver: [{ id: "driver", label: "My trip", icon: Truck }],
};
const HOME: Record<Role, View> = { operations: "trips", finance: "today", owner: "overview", driver: "driver" };
export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  operations: "Operations",
  finance: "Finance",
  driver: "Driver",
};

/** Signed out: the sign-in screen. Signed in: the desks the person's permissions allow. */
export default function App() {
  const [signedIn, setSignedIn] = useState(hasSession);
  useEffect(
    () =>
      onSignedOut(() => {
        resetSync();
        queryClient.clear();
        sessionStorage.removeItem(SESSION);
        setSignedIn(false);
      }),
    [],
  );
  const me = useMe(signedIn);
  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
  if (!me.data) return <Waiting text={me.error ? `Could not load your account: ${(me.error as Error).message}` : "Signing in…"} />;
  return <Desks me={me.data} />;
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
      </aside>
      <main className="picker-main">
        <p className="muted">{text}</p>
      </main>
    </div>
  );
}

function Desks({ me }: { me: Me }) {
  const { data: shared, approvers, perform, refreshReference, error } = useSharedData(me);
  const [session, setSessionState] = useState<Session>(readSession);
  const [overlay, setOverlay] = useState<Overlay>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const allowed = useMemo(() => desksFor(me, approvers), [me, approvers]);
  const setSession = useCallback((patch: Session) => {
    setSessionState((current) => {
      const next = { ...current, ...patch };
      sessionStorage.setItem(SESSION, JSON.stringify(next));
      return next;
    });
  }, []);
  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === "error" ? 5200 : 2800);
  }, []);
  const role = session.role && allowed.includes(session.role) ? session.role : undefined;
  // The desk's phone shows every work thread this person sees (the API already filtered them by permission).
  const data = useMemo(() => (shared && role ? forDesk(shared, role) : shared), [shared, role]);
  const run = useCallback(
    async (action: Action, success?: string) => {
      if (!role) return false;
      try {
        await perform(action, role);
        if (success) toast(success);
        return true;
      } catch (error) {
        toast(error instanceof Refusal || error instanceof ApiError ? error.message : "That didn't work.", "error");
        if (!(error instanceof Refusal || error instanceof ApiError)) console.error(error);
        return false;
      }
    },
    [perform, role, toast],
  );
  const nav = useCallback(
    (target: Nav) => {
      if (!role || !data) return;
      const stages = ["plan", "funding", "loading", "transit", "offloading", "close", "settle"];
      if (target.view === "sheet" && target.tripId) {
        setOverlay({ document: { kind: "trip-sheet", id: target.tripId } });
        return;
      }
      if (target.view === "settle" || target.view === "statement") {
        setSession({ view: role === "driver" ? "driver" : "accounts", accountDriverId: target.driverId });
        if (target.view === "statement" && target.driverId) {
          const last = data.settlements.filter((s) => s.driverId === target.driverId).at(-1);
          if (last) setOverlay({ document: { kind: "statement", id: last.id } });
          else setOverlay({});
        } else setOverlay({});
        return;
      }
      if (target.tripId && role !== "driver") {
        setSession({ view: "trips", tripId: target.tripId, stage: stages.includes(target.view ?? "") ? target.view : undefined });
        setOverlay({});
        return;
      }
      if (target.view === "nominations") setSession({ view: "nominations" });
      if (target.view === "masters" && role !== "driver") setSession({ view: "masters", masterEntity: target.masterEntity });
      if (target.view === "finance" && role === "finance") setSession({ view: "today" });
      setOverlay({});
    },
    [data, role, setSession],
  );

  const ctx = useMemo(
    () => (role && data ? { data, role, me, driverId: session.driverId, run, refreshReference, nav, overlay, setOverlay, toast } : null),
    [data, role, me, session.driverId, run, refreshReference, nav, overlay, toast],
  );

  if (!data) return <Waiting text={error ? `Could not load the desks: ${(error as Error).message}` : "Loading the desks…"} />;
  if (!role || !ctx)
    return (
      <>
        <RolePicker
          company={data.settings.company}
          office={data.settings.office}
          me={me}
          desks={allowed.filter((d): d is Desk => d !== "driver")}
          drivers={allowed.includes("driver") ? data.drivers : []}
          onPick={(nextRole, driverId) => setSession({ role: nextRole, driverId, view: HOME[nextRole] })}
        />
        <Toasts toasts={toasts} />
      </>
    );

  const view = session.view && NAV[role].some((n) => n.id === session.view) ? session.view : HOME[role];
  return (
    <AppProvider value={ctx}>
      <SimProvider>
        <Shell
          role={role}
          view={view}
          person={role === "driver" ? data.drivers.find((d) => d.id === session.driverId)?.name ?? "Driver" : me.name}
          canSwitch={allowed.length > 1}
          onView={(next) => setSession({ view: next })}
          onSwitch={() => setSession({ role: undefined, driverId: undefined })}
          onSignOut={() => void signOut()}
        >
          {view === "trips" && (
            <TripsPage
              tripId={session.tripId}
              stage={session.stage}
              onSelect={(tripId, stage) => setSession({ tripId, stage })}
            />
          )}
          {view === "today" && <FinanceToday />}
          {view === "overview" && <Overview />}
          {view === "nominations" && <Nominations />}
          {view === "accounts" && (
            <Accounts driverId={session.accountDriverId} onDriver={(id) => setSession({ accountDriverId: id })} />
          )}
          {view === "masters" && <MastersScreen key={session.masterEntity || "masters"} initialEntity={session.masterEntity} />}
          {view === "driver" && <DriverDesk />}
        </Shell>
        {role !== "driver" && <DeskPhone />}
        {role !== "driver" && <MessageBanner />}
        <DocumentOverlay />
        <Suspense fallback={null}>{overlay.tracking && <Tracking tripId={overlay.tracking} />}</Suspense>
        <Toasts toasts={toasts} />
      </SimProvider>
    </AppProvider>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast ${t.tone === "error" ? "error" : ""}`}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
          >
            {t.tone === "error" ? <TriangleAlert /> : <CheckCircle2 />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const DESK_TITLE: Record<Desk, { title: string; icon: typeof Truck }> = {
  operations: { title: "Operations", icon: LayoutGrid },
  finance: { title: "Finance", icon: Wallet },
  owner: { title: "Overview and approvals", icon: Gauge },
};

function RolePicker({
  company,
  office,
  me,
  desks,
  drivers,
  onPick,
}: {
  company: string;
  office: string;
  me: Me;
  desks: Desk[];
  drivers: { id: string; name: string; phone: string }[];
  onPick: (role: Role, driverId?: string) => void;
}) {
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
        <div className="picker-art" aria-hidden>
          <RoadArt />
        </div>
        <p className="picker-company">{company}{office ? ` · ${office}` : ""}</p>
      </aside>
      <main className="picker-main">
        <h1>Which desk, {me.name.split(" ")[0]}?</h1>
        <div className="picker-desks">
          {desks.map((desk) => {
            const { title, icon: Icon } = DESK_TITLE[desk];
            return (
              <button key={desk} className="picker-desk" onClick={() => onPick(desk)}>
                <span className="picker-icon">
                  <Icon size={20} />
                </span>
                <span className="picker-text">
                  <strong>{title}</strong>
                  <span>{me.email}</span>
                </span>
                <ChevronRight size={18} className="picker-chev" />
              </button>
            );
          })}
        </div>
        {drivers.length > 0 && (
          <>
            <h2>Driver's phone</h2>
            <div className="picker-drivers">
              {drivers.slice(0, 8).map((driver) => (
                <button key={driver.id} className="picker-driver" onClick={() => onPick("driver", driver.id)}>
                  <Avatar name={driver.name} size={34} />
                  <span>
                    <strong>{driver.name}</strong>
                    <span className="mono">{driver.phone}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <button className="side-reset picker-signout" onClick={() => void signOut()}>
          <LogOut size={14} /> Sign out
        </button>
      </main>
    </div>
  );
}

function RoadArt() {
  return (
    <svg viewBox="0 0 320 420" className="road-art">
      <defs>
        <linearGradient id="ra" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3e1b8" stopOpacity=".0" />
          <stop offset=".5" stopColor="#f3e1b8" stopOpacity=".55" />
          <stop offset="1" stopColor="#f3e1b8" stopOpacity=".9" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="rgba(222,237,229,.08)">
        {Array.from({ length: 9 }, (_, i) => (
          <path key={i} d={`M${-40 + i * 10} ${420 - i * 12} C ${60 + i * 8} ${300 - i * 10}, ${120 - i * 6} ${190 - i * 6}, ${250 + i * 4} ${40 + i * 6}`} />
        ))}
      </g>
      <path d="M40 410 C 120 320, 90 240, 170 190 S 260 90, 280 20" fill="none" stroke="url(#ra)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M40 410 C 120 320, 90 240, 170 190 S 260 90, 280 20" fill="none" stroke="#0d1a17" strokeWidth="0.9" strokeDasharray="4 7" className="road-dash" />
      {[
        [40, 410],
        [170, 190],
        [280, 20],
      ].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="6" fill="#13261f" stroke="#f3e1b8" strokeWidth="1.6" />
        </g>
      ))}
    </svg>
  );
}

function Shell({
  role,
  view,
  person,
  canSwitch,
  onView,
  onSwitch,
  onSignOut,
  children,
}: {
  role: Role;
  view: View;
  person: string;
  canSwitch: boolean;
  onView: (view: View) => void;
  onSwitch: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [more, setMore] = useState(false);
  const items = NAV[role];
  const current = items.find((i) => i.id === view);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [view]);
  return (
    <div className={`shell role-${role}`}>
      <aside className="side">
        <div className="side-brand">
          <Wordmark />
        </div>
        <nav className="side-nav" aria-label="Main">
          {items.map((item) => (
            <NavButton key={item.id} item={item} active={item.id === view} onClick={() => onView(item.id)} role={role} />
          ))}
        </nav>
        <div className="side-foot">
          <button className="side-user" onClick={canSwitch ? onSwitch : undefined} title={canSwitch ? "Switch desk" : undefined} disabled={!canSwitch}>
            <Avatar name={person} tone="dark" size={34} />
            <span>
              <strong>{person}</strong>
              <span>{ROLE_LABEL[role]}</span>
            </span>
            {canSwitch && <ArrowRightLeft size={16} />}
          </button>
          <button className="side-reset" onClick={onSignOut}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>
      <main className="main" ref={main}>
        {role !== "driver" && (
          <header className="topbar">
            <h1>{current?.label}</h1>
            <PhoneButton />
            <button className="topbar-user" onClick={() => setMore(true)} aria-label="Account">
              <Avatar name={person} size={32} />
            </button>
          </header>
        )}
        <div className={`page page-${view}`}>{children}</div>
      </main>
      {role !== "driver" && (
        <nav className="tabbar" aria-label="Main">
          {items.slice(0, 4).map((item) => (
            <NavButton key={item.id} item={item} active={item.id === view} onClick={() => onView(item.id)} role={role} compact />
          ))}
          {items.length > 4 && (
            <button className={`tab ${items.slice(4).some((i) => i.id === view) ? "on" : ""}`} onClick={() => setMore(true)}>
              <MoreHorizontal />
              <span>More</span>
            </button>
          )}
        </nav>
      )}
      <Modal open={more} title="More" onClose={() => setMore(false)}>
        <div className="more-list">
          {items.slice(4).map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onView(item.id);
                setMore(false);
              }}
            >
              <item.icon size={18} /> {item.label}
            </button>
          ))}
          {canSwitch && (
            <button onClick={onSwitch}>
              <BookUser size={18} /> Switch desk
            </button>
          )}
          <button onClick={onSignOut}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </Modal>
    </div>
  );
}

function NavButton({
  item,
  active,
  onClick,
  role,
  compact,
}: {
  item: { id: View; label: string; icon: typeof Truck };
  active: boolean;
  onClick: () => void;
  role: Role;
  compact?: boolean;
}) {
  const count = useQueueCount(role, item.id);
  return (
    <button className={compact ? `tab ${active ? "on" : ""}` : `side-link ${active ? "on" : ""}`} onClick={onClick} aria-current={active}>
      <item.icon size={compact ? 20 : 18} />
      <span>{compact ? item.label.split(" ")[0] : item.label}</span>
      {count > 0 && <b className="nav-count">{count}</b>}
    </button>
  );
}

function useQueueCount(role: Role, view: View) {
  const { data } = useApp() ?? {};
  if (!data || role === "driver") return 0;
  const queue = queueFor(data, role as Desk);
  if (view === "today" || view === "overview") return queue.length;
  if (view === "trips" && role === "operations") return queue.filter((q) => q.tripId).length;
  if (view === "nominations" && role !== "finance")
    return data.nominations.filter((n) => n.status === "accepted").length;
  return 0;
}

function PhoneButton() {
  const { data, role, overlay, setOverlay } = useApp();
  const unread = data.messages.filter(
    (m) => (m.thread === role || m.thread.startsWith("customer:")) && m.from !== "me" && m.at > (data.reads[role] ?? ""),
  ).length;
  return (
    <button className={`phone-btn ${overlay.phone ? "on" : ""}`} onClick={() => setOverlay({ ...overlay, phone: !overlay.phone })}>
      <MessageCircle size={18} />
      <span>WhatsApp</span>
      {unread > 0 && <b>{unread}</b>}
    </button>
  );
}
