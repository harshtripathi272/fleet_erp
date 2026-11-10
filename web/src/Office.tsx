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
  KeyRound,
  LogOut,
  MessageCircle,
  Wrench,
  MoreHorizontal,
  Settings2,
  Truck,
  TriangleAlert,
  Wallet,
  X,
  Receipt,
  Users,
  Map as MapIcon,
  Package,
} from "lucide-react";
import { AppProvider, useApp, useSharedData } from "./store";
import type { Overlay, Toast } from "./store";
import { forDesk } from "./api/adapter";
import { ApiError } from "./api/client";
import { Refusal } from "./api/commands";
import { AccountDialog, can, DESK_SESSION, desksFor, signOut, useMay, type Me } from "./api/session";
import { useAreas, VIEW_AREA } from "./api/areas";
import { nextStep, queueFor, type QueueItem } from "./domain/turn";
import type { Action, AppData, Desk, Nav, Role, WorkspaceDesk } from "./domain/types";
import { w } from "./domain/words";
import { Waiting, Wordmark } from "./ui/brand";
import { Avatar, Modal } from "./ui/kit";
import { useMine } from "./desks/mine";
import { DeskPhone, MessageBanner } from "./phone/DeskPhone";
import { DocumentOverlay } from "./docs/DocumentOverlay";
import { SimProvider } from "./tracking/sim";
import { wantsAuditLog } from "./masters/history";

// Each screen is its own download, fetched the first time it's opened; the map only when a map is opened.
const TripsPage = lazy(() => import("./desks/Trips").then((m) => ({ default: m.TripsPage })));
const FinanceToday = lazy(() => import("./desks/Finance").then((m) => ({ default: m.FinanceToday })));
const Billing = lazy(() => import("./billing/Billing").then((m) => ({ default: m.Billing })));
const Accounts = lazy(() => import("./desks/Accounts").then((m) => ({ default: m.Accounts })));
const ConsignmentsScreen = lazy(() => import("./consignments/ConsignmentsScreen"));
const Nominations = lazy(() => import("./desks/Nominations").then((m) => ({ default: m.Nominations })));
const Maintenance = lazy(() => import("./desks/Maintenance").then((m) => ({ default: m.Maintenance })));
const MastersScreen = lazy(() => import("./masters/MastersScreen").then((m) => ({ default: m.MastersScreen })));
const Overview = lazy(() => import("./desks/Overview").then((m) => ({ default: m.Overview })));
const DriverDesk = lazy(() => import("./desks/DriverDesk").then((m) => ({ default: m.DriverDesk })));
const Tracking = lazy(() => import("./tracking/Tracking"));

type View = "overview" | "today" | "trips" | "consignments" | "nominations" | "accounts" | "billing" | "maintenance" | "masters" | "driver";
interface Session {
  /** The company desk (#73) by key; `role` is the built-in desk it acts as, or "driver". */
  desk?: string;
  role?: Role;
  driverId?: string;
  view?: View;
  tripId?: string;
  stage?: string;
  accountDriverId?: string;
  masterEntity?: string;
}
const readSession = (): Session => {
  const params = new URLSearchParams(location.search);
  const desk = params.get("desk") as Role | null;
  if (desk && ["operations", "finance", "owner", "driver"].includes(desk)) {
    const session: Session = desk === "driver" ? { role: desk, driverId: params.get("driver") ?? undefined } : { role: desk, desk };
    sessionStorage.setItem(DESK_SESSION, JSON.stringify(session));
    history.replaceState(null, "", location.pathname);
    return session;
  }
  try {
    const session = JSON.parse(sessionStorage.getItem(DESK_SESSION) ?? "{}") as Session;
    // A shared link to a filtered audit log opens Masters, which opens the log.
    return wantsAuditLog() ? { ...session, view: "masters" } : session;
  } catch {
    return {};
  }
};

/** `short` is the label in the phone tab bar, where there is room for one word. */
type NavItem = { id: View; label: string; short?: string; icon: typeof Truck };

/** The icons a company can give its desks; the keys match the server's DESK_ICONS. */
const DESK_ICON: Record<string, typeof Truck> = {
  gauge: Gauge, grid: LayoutGrid, wallet: Wallet, wrench: Wrench, truck: Truck, clipboard: ClipboardList, users: Users, map: MapIcon,
};

/** The screens a desk can list, named in the company's words. A screen this build doesn't have yet is left out. */
function viewItem(data: AppData, desk: WorkspaceDesk, id: string): NavItem | undefined {
  switch (id) {
    case "overview": return { id, label: "Overview", icon: Gauge };
    case "today": return { id, label: "Approvals", icon: Inbox };
    case "trips": return { id, label: w(data, "trip", true), icon: Truck };
    case "consignments": return { id, label: w(data, "consignment", true), icon: Package };
    case "nominations": return { id, label: w(data, "nomination", true), icon: ClipboardList };
    case "accounts":
      return desk.actsAs === "finance"
        ? { id, label: w(data, "settlement", true), icon: Wallet }
        : { id, label: `${w(data, "driver")} accounts`, short: "Accounts", icon: Wallet };
    case "billing": return { id, label: "Billing", icon: Receipt };
    case "maintenance": return { id, label: "Maintenance", icon: Wrench };
    case "masters": return { id, label: "Masters", icon: Settings2 };
    default: return undefined;
  }
}
/** A desk's views. Consignments sit after Trips (#135); until the server's desks list it, it is put there for every desk that has Trips. */
const withConsignments = (views: string[]) => (views.includes("consignments") || !views.includes("trips") ? views : views.flatMap((v) => (v === "trips" ? ["trips", "consignments"] : [v])));
const deskItems = (data: AppData, desk: WorkspaceDesk) => withConsignments(desk.views).map((v) => viewItem(data, desk, v)).filter((i): i is NavItem => Boolean(i));
const DRIVER_NAV: NavItem[] = [{ id: "driver", label: "My trip", icon: Truck }];

/** The office desks the person's permissions allow. Loaded after sign-in, so drivers and the sign-in screen never download it. */
export default function Desks({ me }: { me: Me }) {
  const { data: shared, approvers, perform, refreshReference, error } = useSharedData(me);
  const [session, setSessionState] = useState<Session>(readSession);
  const [overlay, setOverlay] = useState<Overlay>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const areaOn = useAreas();
  // A desk whose work is switched off for the company isn't offered (#56); Overview and Masters always are.
  const allowed = useMemo(() => desksFor(me, approvers).filter((d) => (d === "finance" ? areaOn("finance") : d === "operations" ? areaOn("trips") : d === "driver" ? areaOn("driver-app") : true)), [me, approvers, areaOn]);
  // The company's desks (#73): a built-in kind follows the permissions above; a desk the company added names its roles.
  // An administrator sees every desk, to set them up.
  const desks = useMemo(
    () =>
      shared
        ? shared.settings.desks.filter(
            (d) =>
              (d.kind === "roles" ? can(me, "*", "create") || (d.roleKeys ?? []).some((k) => me.roles.includes(k)) : allowed.includes(d.kind)) &&
              deskItems(shared, d).length > 0,
          )
        : [],
    [shared, allowed, me],
  );
  const driverDesk = allowed.includes("driver");
  const setSession = useCallback((patch: Session) => {
    setSessionState((current) => {
      const next = { ...current, ...patch };
      sessionStorage.setItem(DESK_SESSION, JSON.stringify(next));
      return next;
    });
  }, []);
  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === "error" ? 5200 : 2800);
  }, []);
  // With a single desk there is nothing to choose: open it. A session from before #73 kept only the role, which was the desk's key.
  const deskKey = session.desk ?? (session.role !== "driver" ? session.role : undefined);
  const desk = session.role === "driver" ? undefined : desks.find((d) => d.key === deskKey) ?? (desks.length === 1 && !driverDesk ? desks[0] : undefined);
  const role: Role | undefined = session.role === "driver" && driverDesk ? "driver" : desk?.actsAs;
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
  // A record to open in Masters, for this visit only: leaving or reloading doesn't reopen it.
  const [masterId, setMasterId] = useState<string>();
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
      if (target.view === "masters" && role !== "driver") {
        setMasterId(target.masterId);
        setSession({ view: "masters", masterEntity: target.masterEntity });
      }
      if (target.view === "maintenance" && role !== "driver") setSession({ view: "maintenance" });
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
          desks={desks}
          drivers={driverDesk ? data.drivers : []}
          onDesk={(next) => setSession({ desk: next.key, role: next.actsAs, driverId: undefined, view: wantsAuditLog() ? "masters" : deskItems(data, next)[0]?.id })}
          onDriver={(driverId) => setSession({ desk: undefined, role: "driver", driverId, view: "driver" })}
        />
        <Toasts toasts={toasts} />
      </>
    );

  const items = role === "driver" || !desk ? DRIVER_NAV : deskItems(data, desk);
  const view = session.view && items.some((n) => n.id === session.view) ? session.view : items[0].id;
  return (
    <AppProvider value={ctx}>
      <SimProvider>
        <Shell
          role={role}
          items={items}
          deskName={desk?.name ?? "Driver"}
          view={view}
          person={role === "driver" ? data.drivers.find((d) => d.id === session.driverId)?.name ?? "Driver" : me.name}
          canSwitch={desks.length + (driverDesk ? 1 : 0) > 1}
          onView={(next) => {
            setMasterId(undefined);
            setSession({ view: next });
          }}
          onSwitch={() => setSession({ desk: undefined, role: undefined, driverId: undefined })}
          onSignOut={() => void signOut()}
          me={me}
        >
          <Suspense fallback={<p className="screen-loading muted">Loading…</p>}>
            {view === "trips" && (
              <TripsPage
                tripId={session.tripId}
                stage={session.stage}
                onSelect={(tripId, stage) => setSession({ tripId, stage })}
              />
            )}
            {view === "today" && <FinanceToday />}
            {view === "overview" && <Overview />}
            {view === "consignments" && <ConsignmentsScreen />}
            {view === "nominations" && <Nominations />}
            {view === "accounts" && (
              <Accounts driverId={session.accountDriverId} onDriver={(id) => setSession({ accountDriverId: id })} />
            )}
            {view === "billing" && <Billing />}
            {view === "maintenance" && <Maintenance />}
            {view === "masters" && <MastersScreen key={`${session.masterEntity || "masters"}-${masterId ?? ""}`} initialEntity={session.masterEntity} initialId={masterId} />}
            {view === "driver" && <DriverDesk />}
          </Suspense>
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

function RolePicker({
  company,
  office,
  me,
  desks,
  drivers,
  onDesk,
  onDriver,
}: {
  company: string;
  office: string;
  me: Me;
  desks: WorkspaceDesk[];
  drivers: { id: string; name: string; phone: string }[];
  onDesk: (desk: WorkspaceDesk) => void;
  onDriver: (driverId: string) => void;
}) {
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
        <p className="picker-company">{company}{office ? ` · ${office}` : ""}</p>
      </aside>
      <main className="picker-main">
        <h1>Which desk, {me.name.split(" ")[0]}?</h1>
        <div className="picker-desks">
          {desks.map((desk) => {
            const Icon = DESK_ICON[desk.icon] ?? LayoutGrid;
            return (
              <button key={desk.key} className="picker-desk" onClick={() => onDesk(desk)}>
                <span className="picker-icon">
                  <Icon size={20} />
                </span>
                <span className="picker-text">
                  <strong>{desk.name}</strong>
                </span>
                <ChevronRight size={18} className="picker-chev" />
              </button>
            );
          })}
        </div>
        {drivers.length > 0 && (
          <>
            <h2>Simulated driver phones</h2>
            <div className="picker-drivers">
              {drivers.slice(0, 8).map((driver) => (
                <button key={driver.id} className="picker-driver" onClick={() => onDriver(driver.id)}>
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

function Shell({
  role,
  items: deskViews,
  deskName,
  view,
  person,
  canSwitch,
  onView,
  onSwitch,
  onSignOut,
  me,
  children,
}: {
  me: Me;
  role: Role;
  items: NavItem[];
  deskName: string;
  view: View;
  person: string;
  canSwitch: boolean;
  onView: (view: View) => void;
  onSwitch: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [more, setMore] = useState(false);
  const [account, setAccount] = useState(false);
  const areaOn = useAreas();
  const items = deskViews.filter((i) => !VIEW_AREA[i.id] || areaOn(VIEW_AREA[i.id]!));
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
          <div className="side-user">
            <Avatar name={person} tone="dark" size={34} />
            <span>
              <strong title={person}>{person}</strong>
              <span>{deskName}</span>
            </span>
          </div>
          {canSwitch && (
            <button className="side-reset" onClick={onSwitch}>
              <ArrowRightLeft size={14} /> Switch desk
            </button>
          )}
          <button className="side-reset" onClick={() => setAccount(true)}>
            <KeyRound size={14} /> Your account
          </button>
          <button className="side-reset" onClick={onSignOut}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>
      <main className="main" ref={main}>
        {role !== "driver" && (
          <header className="topbar">
            <h1>
              <span className="title-long">{current?.label}</span>
              {current?.short && <span className="title-short">{current.short}</span>}
            </h1>
            <PhoneButton />
          </header>
        )}
        <div className={`page page-${view}`}>{children}</div>
      </main>
      {role !== "driver" && (
        <nav className="tabbar" aria-label="Main">
          {items.slice(0, 4).map((item) => (
            <NavButton key={item.id} item={item} active={item.id === view} onClick={() => onView(item.id)} role={role} compact />
          ))}
          <button className={`tab ${items.slice(4).some((i) => i.id === view) ? "on" : ""}`} onClick={() => setMore(true)}>
            <MoreHorizontal />
            <span>More</span>
          </button>
        </nav>
      )}
      <Modal open={more} title="More" onClose={() => setMore(false)}>
        <div className="more-person">
          <Avatar name={person} size={36} />
          <span>
            <strong>{person}</strong>
            <span>{deskName}</span>
          </span>
        </div>
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
          <button onClick={() => { setMore(false); setAccount(true); }}>
            <KeyRound size={18} /> Your account
          </button>
          <button onClick={onSignOut}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </Modal>
      {account && <AccountDialog me={me} onClose={() => setAccount(false)} />}
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
  item: NavItem;
  active: boolean;
  onClick: () => void;
  role: Role;
  compact?: boolean;
}) {
  const count = useQueueCount(role, item.id);
  return (
    <button className={compact ? `tab ${active ? "on" : ""}` : `side-link ${active ? "on" : ""}`} onClick={onClick} aria-current={active}>
      <item.icon size={compact ? 20 : 18} />
      <span>{compact ? item.short ?? item.label : item.label}</span>
      {count > 0 && <b className="nav-count">{count}</b>}
    </button>
  );
}

/** The number beside a desk's tab: only what this person may do now, matching "Needs me". */
function useQueueCount(role: Role, view: View) {
  const { data } = useApp();
  const mineFor = useMine();
  const may = useMay();
  if (!data || role === "driver") return 0;
  const yours = (item: QueueItem) => {
    // Finance's request items: paying needs the permission; deciding needs the approval policy to name this person.
    const request = data.requests.find((r) => r.id === item.key);
    if (request) return item.move === "issue" ? may("request.issue") : Boolean(request.mayDecide);
    // A new driver document or message: Operations files it or sends it back.
    if (item.move === "receipt") return may("doc.return");
    // Judge the item by its own move, not only the trip's next step.
    const trip = data.trips.find((t) => t.id === item.tripId);
    return trip ? mineFor(trip, { ...nextStep(data, trip), actor: role as Desk, move: item.move }) : true;
  };
  const queue = queueFor(data, role as Desk).filter(yours);
  if (view === "today" || view === "overview") return queue.length;
  // Trips: one per trip, the same trips "Needs me" lists.
  if (view === "trips" && role === "operations") return new Set(queue.filter((q) => q.tripId).map((q) => q.tripId)).size;
  if (view === "nominations" && role !== "finance" && may("nomination.convert"))
    return data.nominations.filter((n) => n.status === "accepted").length;
  return 0;
}

function PhoneButton() {
  const { data, role, overlay, setOverlay } = useApp();
  const unread = data.messages.filter(
    (m) => (m.thread === role || m.thread.startsWith("customer:")) && m.from !== "me" && m.at > (data.reads[role] ?? ""),
  ).length;
  return (
    <button className={`phone-btn ${overlay.phone ? "on" : ""}`} onClick={() => setOverlay({ ...overlay, phone: !overlay.phone })} aria-pressed={!!overlay.phone}>
      {overlay.phone ? <X size={18} /> : <MessageCircle size={18} />}
      <span>{overlay.phone ? "Close" : "WhatsApp"}</span>
      {unread > 0 && !overlay.phone && <b>{unread}</b>}
    </button>
  );
}
