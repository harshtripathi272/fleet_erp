import { lazy, Suspense, useEffect, useState } from "react";
import { queryClient, resetSync } from "./store";
import { hasSession, onSignedOut } from "./api/client";
import { DESK_SESSION, SignIn, useMe } from "./api/session";
import { Waiting } from "./ui/brand";

// Each person downloads only their own part of the app, after signing in: a driver never loads the office desks.
const Office = lazy(() => import("./Office"));
const DriverPortal = lazy(() => import("./driver/DriverPortal").then((m) => ({ default: m.DriverPortal })));

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
  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
  if (!me.data) return <Waiting text={me.error ? `Could not load your account: ${(me.error as Error).message}` : "Signing in…"} />;
  return (
    <Suspense fallback={<Waiting text="Loading…" />}>
      {me.data.driverId ? <DriverPortal me={me.data} /> : <Office me={me.data} />}
    </Suspense>
  );
}
