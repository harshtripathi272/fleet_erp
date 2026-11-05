import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, UserX } from "lucide-react";
import { api, ApiError } from "../api/client";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Field, Status } from "../ui/kit";
import { stamp, phonePlaceholder } from "../ui/format";

interface Access { userId: string; phone: string | null; email: string | null; status: string; lastLoginAt: string | null }

/**
 * The driver's own sign-in for the driver web app (issue #5), kept on the driver's record:
 * a phone number (or e-mail) and a password the office sets, which the driver can use on their phone.
 */
export function DriverAccess({ driverId, phone: driverPhone }: { driverId: string; phone?: string }) {
  const { me, toast } = useApp();
  const client = useQueryClient();
  const key = ["driver-access", driverId];
  const access = useQuery({ queryKey: key, queryFn: () => api<{ access: Access | null }>(`/users/driver-access/${driverId}`), enabled: can(me, "users", "read") });
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  if (!can(me, "users", "read")) return null;
  const current = access.data?.access;
  const active = current?.status === "active";
  const editable = can(me, "users", "update");
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast(done);
      setPassword("");
      await client.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(
    () => api(`/users/driver-access/${driverId}`, { method: "PUT", body: { ...(phone.trim() ? { phone: phone.replace(/[\s()-]/g, "") } : {}), ...(password ? { password } : {}) } }),
    active ? "Driver app sign-in updated." : "The driver can now sign in to the driver app.",
  );
  return (
    <fieldset className="form-group extra">
      <legend>Driver app access</legend>
      {access.isLoading ? <p className="muted">Loading…</p> : (
        <p className="muted">
          {active
            ? <>Signs in with <strong>{current!.phone ?? current!.email}</strong>{current!.lastLoginAt ? `, last on ${stamp(current!.lastLoginAt)}` : ", not signed in yet"}. <Status tone="ok">Active</Status></>
            : current ? <>Access removed. <Status tone="mute">Inactive</Status></> : "No access yet."}
        </p>
      )}
      {editable && (
        <>
          <div className="grid-2">
            <Field label="Phone number to sign in with">
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={current?.phone ?? driverPhone ?? phonePlaceholder()} inputMode="tel" />
            </Field>
            <Field label={active ? "New password" : "Password"}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} />
            </Field>
          </div>
          <div className="row-actions">
            <Button size="sm" busy={busy} disabled={!active && !password} onClick={() => void save()}>
              <KeyRound size={15} /> {active ? "Update sign-in" : "Give access"}
            </Button>
            {active && (
              <Button size="sm" tone="danger" disabled={busy} onClick={() => void act(() => api(`/users/driver-access/${driverId}`, { method: "DELETE" }), "Access removed; the driver is signed out.")}>
                <UserX size={15} /> Remove access
              </Button>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
