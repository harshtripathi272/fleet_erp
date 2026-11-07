import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, resetSync } from "./store";
import { api, hasSession, onSignedOut } from "./api/client";
import { ChooseNewPassword, DESK_SESSION, SignIn, can, useMe } from "./api/session";
import { DriverPortal } from "./driver/DriverPortal";
import { Waiting } from "./ui/brand";

// The office desks are a download of their own, after sign-in, so a driver never loads them. The driver app is
// small and comes with the sign-in screen: drivers are on the slowest networks, where another round trip
// costs more than its bytes (#27).
const loadOffice = () => import("./Office");
const Office = lazy(loadOffice);
// "Set up a company" (#96) has its own address and its own page, outside the desks.
const SetUp = lazy(() => import("./setup/SetUp"));
const PackagePage = lazy(() => import("./setup/PackagePage"));
const onSetUpAddress = (hash: string) => hash.startsWith("#set-up") || hash.startsWith("#package");

// Which app this browser last opened. A returning office user's desks download while their account loads.
const LAST_APP = "fleet.app";
const SETUP_LATER = "fleet.setup.later";
try {
  if (hasSession() && localStorage.getItem(LAST_APP) === "office") void loadOffice();
} catch {
  /* storage blocked: the desks load once the account is known */
}

// A tab left open across a deploy asks for screens by their old file names, which are gone: load the new
// version instead. Once a minute at most, so a network that is really down shows the error, not a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem("fleet.reloaded") ?? 0);
  if (Date.now() - last < 60_000) return;
  sessionStorage.setItem("fleet.reloaded", String(Date.now()));
  event.preventDefault();
  location.reload();
});

/** One screen failing says so and offers a way back, rather than leaving a blank page. */
class ScreenFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="su-wait">
        <h1>This screen ran into a problem</h1>
        <p className="muted">Nothing you saved was lost. Going back usually clears it.</p>
        <button type="button" className="btn btn-primary" onClick={() => { history.replaceState(null, "", location.pathname); sessionStorage.removeItem(DESK_SESSION); location.reload(); }}>Back to the start</button>
      </div>
    );
  }
}

/** Signed out: the sign-in screen. Signed in: the driver app, or the desks the person's permissions allow. */
export default function App() {
  // A password link opens the sign-in screen's "choose your password" form, even in a browser already signed in.
  const [signedIn, setSignedIn] = useState(() => hasSession() && !location.hash.startsWith("#reset="));
  useEffect(
    () =>
      onSignedOut(() => {
        resetSync();
        queryClient.clear();
        sessionStorage.removeItem(DESK_SESSION);
        setSignedIn(false);
      }),
    [],
  );
  const me = useMe(signedIn);
  const [hash, setHash] = useState(location.hash);
  const settingUp = onSetUpAddress(hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // A copy with no company yet opens on the set-up, once, for whoever may do it. "Save and leave" is honoured until the next visit.
  const mayChange = Boolean(me.data && !me.data.driverId && !me.data.mustChangePassword && can(me.data, "company", "update"));
  const status = useQuery({
    queryKey: ["setup-status"], enabled: signedIn && mayChange && !settingUp, staleTime: 60_000, retry: false,
    queryFn: () => api<{ hasCompany: boolean; finished: boolean }>("/setup-kit/status"),
  });
  useEffect(() => {
    if (status.data && !status.data.hasCompany && !sessionStorage.getItem(SETUP_LATER)) location.hash = "#set-up";
  }, [status.data]);
  const app = me.data ? (me.data.driverId ? "driver" : "office") : undefined;
  useEffect(() => {
    try {
      if (app) localStorage.setItem(LAST_APP, app);
    } catch {
      /* only a head start next time */
    }
  }, [app]);
  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
  if (!me.data) return <Waiting text={me.error ? `Could not load your account: ${(me.error as Error).message}` : "Signing in…"} />;
  if (me.data.mustChangePassword) return <ChooseNewPassword me={me.data} onDone={() => void queryClient.invalidateQueries()} />;
  if (me.data.driverId) return <DriverPortal me={me.data} />;
  if (settingUp && mayChange) {
    const leave = () => {
      sessionStorage.setItem(SETUP_LATER, "1");
      history.replaceState(null, "", location.pathname);
      setHash("");
    };
    return (
      <Suspense fallback={<Waiting text="Opening the set-up…" />}>
        {hash.startsWith("#package") ? <PackagePage me={me.data} onLeave={leave} /> : <SetUp me={me.data} onLeave={leave} />}
      </Suspense>
    );
  }
  return (
    <ScreenFailed>
      <Suspense fallback={<Waiting text="Loading the desks…" />}>
        <Office me={me.data} />
      </Suspense>
    </ScreenFailed>
  );
}
