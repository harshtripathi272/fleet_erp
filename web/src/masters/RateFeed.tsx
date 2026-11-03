import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Field, Status } from "../ui/kit";
import { stamp } from "../ui/format";

interface Run { id: string; at: string; outcome: "stored" | "failed" | "off"; stored: number; keptManual: number; missing: string[]; error?: string; trigger: string }
interface Feed { baseCurrencyId: string | null; provider: string; currencyIds: string[]; fetchAt: string; keyConfigured: boolean; providers: { key: string; label: string; needsKey: boolean }[]; runs: Run[] }

/**
 * Exchange rates → Rate feed (issue #22): where the day's rates come from, which currencies, when, and how the
 * last fetches went. The provider's key is a server secret; the screen only says whether it is set.
 */
export function RateFeed() {
  const { me, toast, refreshReference } = useApp();
  const client = useQueryClient();
  const feed = useQuery({ queryKey: ["rate-feed"], queryFn: () => api<Feed>("/exchange-rates/feed") });
  const currencies = useQuery({ queryKey: ["rate-feed-currencies"], queryFn: () => api<Rec[]>("/currencies", { query: { status: "active", limit: 100 } }) });
  const [draft, setDraft] = useState<Pick<Feed, "provider" | "currencyIds" | "fetchAt"> | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  useEffect(() => { if (feed.data) setDraft({ provider: feed.data.provider, currencyIds: feed.data.currencyIds, fetchAt: feed.data.fetchAt }); }, [feed.data]);
  if (!feed.data || !draft) return null;
  const editable = can(me, "exchange-rates", "update");
  const provider = feed.data.providers.find((p) => p.key === draft.provider);
  const last = feed.data.runs[0];
  const act = async (key: "save" | "run", work: () => Promise<unknown>, done: (r: unknown) => string) => {
    setBusy(key);
    try {
      const result = await work();
      toast(done(result));
      await client.invalidateQueries({ queryKey: ["rate-feed"] });
      await client.invalidateQueries({ queryKey: ["records", "exchange-rates"] });
      refreshReference();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string) => setDraft({ ...draft, currencyIds: draft.currencyIds.includes(id) ? draft.currencyIds.filter((x) => x !== id) : [...draft.currencyIds, id] });
  return (
    <fieldset className="form-group rate-feed" disabled={!editable}>
      <legend>Rate feed</legend>
      <p className="muted">
        {last
          ? last.outcome === "stored"
            ? <>Last fetched {stamp(last.at)}: {last.stored} stored{last.keptManual ? `, ${last.keptManual} kept as typed in` : ""}{last.missing.length ? `, none for ${last.missing.join(", ")}` : ""}. <Status tone="ok">Working</Status></>
            : last.outcome === "failed"
              ? <>Last attempt {stamp(last.at)} failed: {last.error}. Earlier rates stay in use. <Status tone="bad">Failed</Status></>
              : <>Off: rates are typed in by hand.</>
          : draft.provider === "manual" ? "Off: rates are typed in by hand." : "Not fetched yet."}
      </p>
      <div className="grid-2">
        <Field label="Where rates come from">
          <select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
            {feed.data.providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Fetch every day at" hint="Company time. The server's scheduler runs the fetch then.">
          <input type="time" value={draft.fetchAt} onChange={(e) => setDraft({ ...draft, fetchAt: e.target.value })} />
        </Field>
      </div>
      {provider?.needsKey && !feed.data.keyConfigured && <p className="signin-error">This provider needs an API key: the administrator sets RATE_FEED_API_KEY on the server.</p>}
      {draft.provider !== "manual" && (
        <Field label="Currencies" hint="None ticked: every active currency." wide>
          <span className="checks">
            {(currencies.data ?? []).filter((c) => c.id !== feed.data.baseCurrencyId).map((c) => <label key={c.id}><input type="checkbox" checked={draft.currencyIds.includes(c.id)} onChange={() => toggle(c.id)} /> {c.code}</label>)}
          </span>
        </Field>
      )}
      {editable && (
        <div className="row-actions">
          <Button size="sm" tone="primary" busy={busy === "save"} onClick={() => void act("save", () => api("/exchange-rates/feed", { method: "PUT", body: draft }), () => "Rate feed saved.")}>Save</Button>
          {draft.provider !== "manual" && can(me, "exchange-rates", "create") && (
            <Button size="sm" busy={busy === "run"} onClick={() => void act("run", () => api<Run>("/exchange-rates/feed/run", { method: "POST" }), (r) => {
              const run = r as Run;
              return run.outcome === "stored" ? `Stored ${run.stored} rate${run.stored === 1 ? "" : "s"}.` : `Fetch failed: ${run.error ?? "unknown"}`;
            })}><RefreshCw size={15} /> Fetch now</Button>
          )}
        </div>
      )}
    </fieldset>
  );
}
