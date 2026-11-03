import { useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Wordmark } from "../ui/brand";
import { Button, Field } from "../ui/kit";
import type { Role } from "../domain/types";
import { api, ApiError, hasSession, setTokens, type Tokens } from "./client";

export interface Permission { resource: string; actions: string[] }
export interface Me {
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

interface MeResponse { simulators?: boolean; user: { id: string; name: string; email: string; driverId?: string }; roles: { key: string; permissions: Permission[] }[] }
const toMe = (r: MeResponse): Me => ({
  id: r.user.id, name: r.user.name, email: r.user.email, driverId: r.user.driverId ?? undefined, simulators: r.simulators !== false,
  roles: r.roles.map((x) => x.key), permissions: r.roles.flatMap((x) => x.permissions ?? []),
});

export function useMe(signedIn: boolean) {
  return useQuery({ queryKey: ["me"], queryFn: async () => toMe(await api<MeResponse>("/auth/me")), enabled: signedIn && hasSession(), staleTime: 60_000 });
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

export function SignIn({ company, onSignedIn }: { company?: string; onSignedIn: () => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
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
  return (
    <div className="picker">
      <aside className="picker-side">
        <Wordmark />
        <p className="picker-company">{company ?? "Marichi Fleet"}</p>
      </aside>
      <main className="picker-main">
        <h1>{mode === "in" ? "Sign in" : "Create account"}</h1>
        <form className="signin" onSubmit={submit}>
          {mode === "up" && (
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </Field>
          )}
          <Field label={mode === "in" ? "E-mail or phone number" : "E-mail"}>
            <input type={mode === "in" ? "text" : "email"} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={mode === "in" ? "username" : "email"} inputMode={mode === "in" && looksLikePhone(email) ? "tel" : undefined} required />
          </Field>
          <Field label="Password">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "in" ? "current-password" : "new-password"} required minLength={8} />
          </Field>
          {error && <p className="signin-error" role="alert">{error}</p>}
          <div className="signin-actions">
            <Button tone="primary" type="submit" disabled={busy}>{mode === "in" ? "Sign in" : "Create account"}</Button>
            <Button tone="quiet" type="button" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(""); }}>
              {mode === "in" ? "Create an account" : "I have an account"}
            </Button>
          </div>
          {mode === "up" && <p className="muted">On a new database the first account is the Owner.</p>}
        </form>
      </main>
    </div>
  );
}
