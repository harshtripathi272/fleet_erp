import { lazy, Suspense, useEffect, useState } from "react";
import { queryClient, resetSync } from "./store";
import { hasSession, onSignedOut } from "./api/client";
import { DESK_SESSION, SignIn, useMe } from "./api/session";
import { DriverPortal } from "./driver/DriverPortal";
import { Waiting } from "./ui/brand";

// The office desks are a download of their own, after sign-in, so a driver never loads them. The driver app is
// small and comes with the sign-in screen: drivers are on the slowest networks, where another round trip
// costs more than its bytes (#27).
const loadOffice = () => import("./Office");
const Office = lazy(loadOffice);

// Which app this browser last opened. A returning office user's desks download while their account loads.
const LAST_APP = "marichi.app";
try {
  if (hasSession() && localStorage.getItem(LAST_APP) === "office") void loadOffice();
} catch {
  /* storage blocked: the desks load once the account is known */
}

// A tab left open across a deploy asks for screens by their old file names, which are gone: load the new
// version instead. Once a minute at most, so a network that is really down shows the error, not a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem("marichi.reloaded") ?? 0);
  if (Date.now() - last < 60_000) return;
  sessionStorage.setItem("marichi.reloaded", String(Date.now()));
  event.preventDefault();
  location.reload();
});

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
  if (me.data.driverId) return <DriverPortal me={me.data} />;
  return (
    <Suspense fallback={<Waiting text="Loading the desks…" />}>
      <Office me={me.data} />
    </Suspense>
  );
}
