import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBrand, Wordmark } from "../ui/brand";
import { Button, Field, Modal } from "../ui/kit";
import type { Action, Role } from "../domain/types";
import { useApp } from "../store";
import { api, ApiError, hasSession, onSignedOut, setTokens, type Tokens } from "./client";

/** The desk, view and trip this browser tab has open (the office desks keep it; signing out forgets it). */
export const DESK_SESSION = "fleet.tripdesk.session";

export interface Permission { resource: string; actions: string[] }
export interface Me {
  /** The password came from someone else: nothing opens until it's replaced. */
  mustChangePassword?: boolean;
  id: string;
  name: string;
  email: string;
  roles: string[];
  permissions: Permission[];
  /** Set when this account is a driver's own: they get the driver app, not the desks. */
  driverId?: string;
  /** Whether this installation allows the simulators (simulated phones, drive and camera). */
  simulators: boolean;
}

export const can = (me: Me | undefined, resource: string, action: string) =>
  Boolean(me?.permissions.some((p) => (p.resource === "*" || p.resource === resource) && (p.actions.includes("*") || p.actions.includes(action))));

/**
 * The permission each action needs, as `operations.router.ts` checks it, so a screen offers only what the
 * API would accept. Deciding a money request or an expense also needs the approval policy to name the
 * person for a waiting level: that is `mayDecide` on the record, not a permission.
 */
export const ACTION_PERMISSION: Record<Action["type"], [resource: string, action: string]> = {
  "nomination.save": ["nominations", "create"],
  "nomination.send": ["nominations", "update"],
  "nomination.accept": ["nominations", "update"],
  "customer.reply": ["nominations", "update"],
  "nomination.cancel": ["nominations", "update"],
  "nomination.convert": ["trips", "create"],
  "trip.create": ["trips", "create"],
  "trip.update": ["trips", "update"],
  "trip.cancel": ["trips", "update"],
  "trip.dispatch": ["trips", "update"],
  "trip.ping": ["trips", "update"],
  "trip.arrive": ["trips", "update"],
  "trip.end": ["trips", "update"],
  "trip.stop": ["trips", "update"],
  "trip.undelivered": ["trips", "update"],
  "writeoff.decide": ["consignments", "read"],
  "trip.remind": ["messages", "create"],
  "request.create": ["fund-requests", "create"],
  "request.decide": ["fund-requests", "read"],
  "request.issue": ["payments", "create"],
  "request.cancel": ["fund-requests", "update"],
  "doc.send": ["driver-documents", "create"],
  "doc.return": ["driver-documents", "update"],
  "doc.done": ["driver-documents", "update"],
  "load.record": ["consignments", "create"],
  "delivery.record": ["consignments", "update"],
  "shortage.decide": ["shortage-decisions", "create"],
  "expense.record": ["expenses", "create"],
  "expense.decide": ["expenses", "read"],
  "settlement.request": ["settlement-requests", "create"],
  "settlement.post": ["settlements", "create"],
  "settlement.reverse": ["settlements", "create"],
  "chat.send": ["messages", "create"],
  "thread.read": ["messages", "read"],
};

/** May the signed-in person take this action? Screens use it to decide which buttons to show. */
export function useMay() {
  const { me } = useApp();
  return (type: Action["type"]) => can(me, ...ACTION_PERMISSION[type]);
}

interface MeResponse { simulators?: boolean; user: { id: string; name: string; email: string; driverId?: string; mustChangePassword?: boolean }; roles: { key: string; permissions: Permission[] }[] }
const toMe = (r: MeResponse): Me => ({
  id: r.user.id, name: r.user.name, email: r.user.email, driverId: r.user.driverId ?? undefined, simulators: r.simulators !== false,
  mustChangePassword: Boolean(r.user.mustChangePassword),
  roles: r.roles.map((x) => x.key), permissions: r.roles.flatMap((x) => x.permissions ?? []),
});

/**
 * A driver's account is kept on the phone, so the driver app opens with no signal (the trip and the outbox
 * are kept too). Staff desks always load the account fresh.
 */
const KEPT_ME = "fleet.driver.me";
const keptMe = () => {
  try {
    const raw = localStorage.getItem(KEPT_ME);
    return raw && hasSession() ? toMe(JSON.parse(raw) as MeResponse) : undefined;
  } catch {
    return undefined;
  }
};
onSignedOut(() => localStorage.removeItem(KEPT_ME));

export function useMe(signedIn: boolean) {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const raw = await api<MeResponse>("/auth/me");
      try {
        if (raw.user.driverId) localStorage.setItem(KEPT_ME, JSON.stringify(raw));
        else localStorage.removeItem(KEPT_ME);
      } catch { /* private mode */ }
      return toMe(raw);
    },
    enabled: signedIn && hasSession(),
    staleTime: 60_000,
    initialData: keptMe,
    initialDataUpdatedAt: 0,
  });
}

export interface Approver { level: number; roleKey?: string; userId?: string }

/**
 * The desks a person may open, from their permissions and the approval policies, never from a role's name:
 * - Operations for anyone who plans or runs trips;
 * - Finance for anyone who approves, pays or settles (or is a first-level approver in a policy);
 * - the overview and approvals desk for anyone named at a higher policy level, or who holds every permission;
 * - the simulated driver phones for anyone who may file driver documents, where the installation allows simulators.
 * Someone with none of these reads the Operations desk.
 */
export function desksFor(me: Me, approvers: Approver[] = []): Role[] {
  const named = (a: Approver) => (a.userId ? a.userId === me.id : Boolean(a.roleKey && me.roles.includes(a.roleKey)));
  const desks: Role[] = [];
  if (can(me, "*", "create") || approvers.some((a) => a.level > 1 && named(a))) desks.push("owner");
  if (["trips", "nominations", "consignments", "fund-requests"].some((r) => can(me, r, "create"))) desks.push("operations");
  if (["fund-approvals", "payments", "expense-approvals", "settlements", "shortage-decisions"].some((r) => can(me, r, "create")) || approvers.some((a) => a.level === 1 && named(a))) desks.push("finance");
  if (!desks.length) desks.push("operations");
  if (me.simulators && can(me, "driver-documents", "create")) desks.push("driver");
  return desks;
}

export async function signOut() {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    /* the session is gone either way */
  }
  setTokens(null);
}

/** Drivers sign in with their phone number; everyone else with their e-mail. */
const looksLikePhone = (value: string) => /^\+?[\d\s-]{7,}$/.test(value.trim());

interface SignInOptions { company: string | null; firstOwner: boolean; signUp: boolean; demo?: boolean; trialEnds?: string | null; mail?: boolean }

/** A "#reset=…" link from an invitation or reset e-mail opens the "choose your password" form. */
const resetTokenInLink = () => (location.hash.startsWith("#reset=") ? decodeURIComponent(location.hash.slice(7)) : "");

export function SignIn({ company, onSignedIn }: { company?: string; onSignedIn: () => void }) {
  const [token] = useState(resetTokenInLink);
  const [mode, setMode] = useState<"in" | "up" | "forgot" | "reset">(token ? "reset" : "in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const options = useQuery({ queryKey: ["sign-in-options"], queryFn: () => api<SignInOptions>("/auth/options", { anonymous: true }), retry: false });
  const go = (next: typeof mode) => { setMode(next); setError(""); setNotice(""); };
  // A new copy has nobody to sign in yet: it opens on making the first account, once the server has said so.
  const firstAccount = options.data?.firstOwner;
  useEffect(() => { if (firstAccount && !token) setMode("up"); }, [firstAccount, token]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "forgot") {
        await api("/auth/forgot-password", { method: "POST", body: { email: email.trim() }, anonymous: true });
        setNotice("If an account uses this e-mail, a link to choose a new password is on its way. It works once.");
        return;
      }
      if (mode === "reset") {
        await api("/auth/reset-password", { method: "POST", body: { token, password }, anonymous: true });
        history.replaceState(null, "", location.pathname + location.search);
        setPassword("");
        go("in");
        setNotice("Your password is set. Sign in with it.");
        return;
      }
      const tokens = mode === "in"
        ? await api<Tokens>("/auth/login", { method: "POST", body: { ...(looksLikePhone(email) ? { phone: email.replace(/[\s-]/g, "") } : { email: email.trim() }), password }, anonymous: true })
        : await api<Tokens>("/auth/register", { method: "POST", body: { name, email, password }, anonymous: true });
      setTokens(tokens);
      queryClient.clear();
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server. Is the API running?");
    } finally {
      setBusy(false);
    }
  };
  const signUp = options.data?.signUp ?? false;
  const brand = useBrand();
  const heading = { in: "Sign in", up: options.data?.firstOwner ? "Set up the first account" : "Create account", forgot: "Forgot your password", reset: "Choose your password" }[mode];
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
        <p className="picker-company">{company ?? options.data?.company ?? brand.companyName ?? ""}</p>
      </aside>
      <main className="picker-main">
        <h1>{heading}</h1>
        {options.data?.demo && <p className="signin-demo" role="note">This copy holds made-up data, for showing and trying the app.</p>}
        {(() => {
          // A trial says how long it has left from three days before its last day (#95); nothing is enforced.
          const ends = options.data?.trialEnds;
          const days = ends ? Math.ceil((Date.parse(`${ends}T23:59:59Z`) - Date.now()) / 86_400_000) : null;
          return days !== null && days <= 3 ? <p className="signin-demo" role="note">{days > 0 ? `This trial ends on ${ends}: ${days} ${days === 1 ? "day" : "days"} left.` : `This trial ended on ${ends}.`}</p> : null;
        })()}
        <form className="signin" onSubmit={submit}>
          {mode === "up" && (
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </Field>
          )}
          {mode !== "reset" && (
            <Field label={mode === "in" ? "E-mail or phone number" : "E-mail"}>
              <input type={mode === "in" ? "text" : "email"} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={mode === "in" ? "username" : "email"} inputMode={mode === "in" && looksLikePhone(email) ? "tel" : undefined} required />
            </Field>
          )}
          {mode !== "forgot" && (
            <Field label={mode === "reset" ? "New password" : "Password"} hint={mode === "in" ? undefined : "At least 8 characters, with a letter and a digit."}>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "in" ? "current-password" : "new-password"} required minLength={8} />
            </Field>
          )}
          {error && <p className="signin-error" role="alert">{error}</p>}
          {notice && <p className="signin-notice" role="status">{notice}</p>}
          <div className="signin-actions">
            <Button tone="primary" type="submit" busy={busy}>
              {{ in: "Sign in", up: "Create account", forgot: "Send the link", reset: "Set password" }[mode]}
            </Button>
            {mode === "in" && <Button tone="quiet" type="button" onClick={() => go("forgot")}>Forgot password?</Button>}
            {mode === "in" && signUp && <Button tone="quiet" type="button" onClick={() => go("up")}>Create an account</Button>}
            {mode !== "in" && <Button tone="quiet" type="button" onClick={() => go("in")}>Back to sign in</Button>}
          </div>
          {mode === "up" && options.data?.firstOwner && <p className="muted">This first account becomes the Owner. The set-up opens next.</p>}
          {mode === "forgot" && (options.data?.mail === false
            ? <p className="muted">This copy has no e-mail server, so no link can be sent. Ask your Owner to set a new password under Users. If you are the only Owner, whoever runs this copy can get you back in by setting OWNER_PASSWORD_RESET and restarting it.</p>
            : <p className="muted">Drivers who sign in with a phone number: ask the office to set a new password.</p>)}
        </form>
      </main>
    </div>
  );
}

/** The signed-in person's own account: change the password, or sign out on every device. */
export function AccountDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState<"" | "password" | "all">("");
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const attempt = async (key: "password" | "all", work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await work();
      setMessage({ text: done });
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "That didn't go through.", bad: true });
    } finally {
      setBusy("");
    }
  };
  const change = (event: FormEvent) => {
    event.preventDefault();
    void attempt("password", async () => {
      const tokens = await api<Partial<Tokens>>("/auth/change-password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      // Changing the password ends other sessions; when the API hands back fresh tokens, keep this one going.
      if (tokens?.accessToken && tokens.refreshToken) setTokens(tokens as Tokens);
      setCurrent("");
      setNext("");
    }, "Password changed. Other devices were signed out.");
  };
  return (
    <Modal open title="Your account" onClose={onClose}>
      <div className="account">
        <p className="account-who"><strong>{me.name}</strong><span className="muted">{me.email}</span></p>
        <form className="signin" onSubmit={change}>
          <Field label="Current password">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 8 characters, with a letter and a digit.">
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={8} />
          </Field>
          <div className="signin-actions">
            <Button tone="primary" type="submit" busy={busy === "password"}>Change password</Button>
            <Button tone="quiet" type="button" busy={busy === "all"} onClick={() => void attempt("all", async () => { await api("/auth/logout-all", { method: "POST" }); setTokens(null); location.reload(); }, "Signed out everywhere.")}>
              Sign out on every device
            </Button>
          </div>
          {message && <p className={message.bad ? "signin-error" : "signin-notice"} role={message.bad ? "alert" : "status"}>{message.text}</p>}
        </form>
      </div>
    </Modal>
  );
}

/** The first thing someone sees when their password came from a settings file or an administrator. */
export function ChooseNewPassword({ me, onDone }: { me: Me; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = Boolean(again) && next !== again;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) return;
    setBusy(true);
    setError("");
    try {
      const tokens = await api<Partial<Tokens>>("/auth/change-password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      if (tokens?.accessToken && tokens.refreshToken) setTokens(tokens as Tokens);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
      </aside>
      <main className="picker-main">
        <h1>Choose your own password</h1>
        <p className="muted">{me.email}. The password you just used was set by someone else, so it needs replacing before you carry on.</p>
        <form className="signin" onSubmit={(e) => void submit(e)}>
          <Field label="The password you just used"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus /></Field>
          <Field label="New password" hint="At least 8 characters, with a letter and a digit."><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={8} /></Field>
          <Field label="New password again" hint={mismatch ? "These don't match yet." : undefined}><input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required /></Field>
          {error && <p className="signin-error" role="alert">{error}</p>}
          <div className="signin-actions">
            <Button tone="primary" type="submit" busy={busy} disabled={mismatch || !next}>Save and carry on</Button>
            <Button tone="quiet" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </form>
      </main>
    </div>
  );
}
