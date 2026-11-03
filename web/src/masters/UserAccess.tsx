import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, LockOpen, LogOut, Mail } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Field } from "../ui/kit";
import { stamp } from "../ui/format";

/**
 * Signing in for someone else's account, kept on the user's record: set a password (when e-mail is not set up),
 * send a fresh invitation, sign them out everywhere, or lift a lock after too many wrong passwords.
 */
export function UserAccess({ userId, record }: { userId: string; record: Rec }) {
  const { me, toast } = useApp();
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!can(me, "users", "update") || userId === me.id) return null;
  const locked = Boolean(record.lockedUntil && new Date(String(record.lockedUntil)) > new Date());
  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await work();
      toast(done);
      setPassword("");
      await client.invalidateQueries({ queryKey: ["record", "users", userId] });
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <fieldset className="form-group extra">
      <legend>Signing in</legend>
      <p className="muted">
        {record.lastLoginAt ? `Last signed in ${stamp(String(record.lastLoginAt))}.` : "Has not signed in yet."}
        {locked ? ` Locked after too many wrong passwords until ${stamp(String(record.lockedUntil))}.` : ""}
      </p>
      <div className="grid-2">
        <Field label="New password" hint="They are signed out everywhere and use this from now on.">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} />
        </Field>
      </div>
      <div className="row-actions">
        <Button size="sm" busy={busy === "password"} disabled={!password || Boolean(busy)} onClick={() => void act("password", () => api(`/users/${userId}/password`, { method: "POST", body: { password } }), "Password set. They were signed out everywhere.")}>
          <KeyRound size={15} /> Set password
        </Button>
        {Boolean(record.email) && record.status === "active" && (
          <Button size="sm" busy={busy === "invite"} disabled={Boolean(busy)} onClick={() => void act("invite", async () => {
            const sent = await api<{ sent: boolean }>(`/users/${userId}/invitation`, { method: "POST" });
            if (!sent.sent) throw new ApiError("The invitation e-mail could not be sent. Set a password instead, or check the e-mail settings.", 503);
          }, `A new invitation went to ${String(record.email)}. Earlier links no longer work.`)}>
            <Mail size={15} /> Send a new invitation
          </Button>
        )}
        <Button size="sm" tone="quiet" busy={busy === "out"} disabled={Boolean(busy)} onClick={() => void act("out", () => api(`/users/${userId}/revoke-sessions`, { method: "POST" }), "Signed out on every device.")}>
          <LogOut size={15} /> Sign out everywhere
        </Button>
        {locked && (
          <Button size="sm" tone="quiet" busy={busy === "unlock"} disabled={Boolean(busy)} onClick={() => void act("unlock", () => api(`/users/${userId}/unlock`, { method: "POST" }), "Unlocked. They can sign in again.")}>
            <LockOpen size={15} /> Unlock
          </Button>
        )}
      </div>
    </fieldset>
  );
}
