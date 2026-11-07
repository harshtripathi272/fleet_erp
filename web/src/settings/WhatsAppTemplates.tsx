import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { api } from "../api/client";
import { downloadPdf } from "../api/files";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Empty, Status } from "../ui/kit";
import { stamp } from "../ui/format";
import "./settings.css";

/**
 * Masters → Connections → WhatsApp templates (#112). Within 24 hours of someone's last message the app writes
 * freely; after that WhatsApp delivers only templates the business has had approved. Every message the app
 * sends has one here: what it says (with sample values), what sends it, and where it stands at Meta.
 */
type TemplateStatus = "not_submitted" | "pending" | "approved" | "rejected" | "paused" | "disabled";
interface Template {
  name: string; category: string; language: string; audience: string; trigger: string;
  header: string; preview: string; footer?: string; buttons: string[]; carrier: boolean;
  status: TemplateStatus; reason?: string; submittedAt?: string; checkedAt?: string;
}
interface Listing { connection: { id: string; name: string; provider: string; canSubmit: boolean } | null; templates: Template[] }

const STATUS: Record<TemplateStatus, { label: string; tone: "ok" | "wait" | "bad" | "mute" | "info" }> = {
  not_submitted: { label: "Not submitted", tone: "mute" },
  pending: { label: "Waiting for Meta", tone: "wait" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
  paused: { label: "Paused by Meta", tone: "bad" },
  disabled: { label: "Disabled by Meta", tone: "bad" },
};
const AUDIENCE: Record<string, string> = { driver: "To the driver", customer: "To the customer", approver: "To the approver", finance: "To Finance", anyone: "To anyone" };

export default function WhatsAppTemplates({ onBack }: { onBack: () => void }) {
  const { me, toast } = useApp();
  const client = useQueryClient();
  const listing = useQuery({ queryKey: ["whatsapp-templates"], queryFn: () => api<Listing>("/whatsapp-templates") });
  const writable = can(me, "connections", "update");
  const keep = (data: Listing) => client.setQueryData(["whatsapp-templates"], data);
  const submit = useMutation({
    mutationFn: (names?: string[]) => api<Listing & { results: Array<{ name: string; ok: boolean; message?: string }> }>("/whatsapp-templates/submit", { method: "POST", body: names ? { names } : {} }),
    onSuccess: (r) => { keep(r); const refused = r.results.filter((x) => !x.ok); toast(refused.length ? `${r.results.length - refused.length} sent to Meta; ${refused.length} not: ${refused[0]!.message}` : `${r.results.length} sent to Meta for approval`, refused.length ? "error" : "ok"); },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const refresh = useMutation({
    mutationFn: () => api<Listing & { refreshed: number }>("/whatsapp-templates/refresh", { method: "POST" }),
    onSuccess: (r) => { keep(r); toast(r.refreshed ? `Read ${r.refreshed} from Meta` : "Nothing to read yet"); },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const data = listing.data;
  const approved = data?.templates.filter((t) => t.status === "approved").length ?? 0;
  return (
    <div className="desk whatsapp-templates">
      <button className="link-btn" onClick={onBack}><ChevronLeft size={16} /> Connections</button>
      <header className="masters-head">
        <div className="masters-title">
          <h2>WhatsApp templates</h2>
          <p>Within 24 hours of someone's last message the app writes to them freely. After that, WhatsApp delivers only templates the business has had approved, so every message the app sends has one here. Submit them once; Meta usually answers within minutes, sometimes a day.</p>
        </div>
        <div className="wa-actions">
          {data?.connection?.canSubmit && writable && <Button tone="primary" busy={submit.isPending} onClick={() => submit.mutate(undefined)}>Submit all to Meta</Button>}
          {data?.connection?.canSubmit && <Button busy={refresh.isPending} onClick={() => refresh.mutate()}>Check with Meta</Button>}
          <Button onClick={() => void downloadPdf("/whatsapp-templates/export.md", "whatsapp-templates.md")}>Download as a document</Button>
          <Button tone="quiet" onClick={() => void downloadPdf("/whatsapp-templates/export.json", "whatsapp-templates.json")}>Download as JSON</Button>
        </div>
      </header>
      {listing.isLoading && <p className="muted">Loading…</p>}
      {listing.error && <Empty title="Could not load the templates">{(listing.error as Error).message}</Empty>}
      {data && (
        <p className="wa-standing">
          {data.connection
            ? <>Through <strong>{data.connection.name}</strong> ({data.connection.provider}). {approved} of {data.templates.length} approved.{!data.connection.canSubmit && " This service takes templates in its own console: download them and submit them there."}</>
            : "No real WhatsApp connection yet: connect the Cloud API (Meta) to submit them from here, or download them to submit by hand in WhatsApp Manager."}
        </p>
      )}
      <div className="wa-list">
        {(data?.templates ?? []).map((t) => (
          <article key={t.name} className="wa-template">
            <header>
              <div>
                <code>{t.name}</code>
                <span className="muted"> · {AUDIENCE[t.audience] ?? t.audience} · Utility · English</span>
              </div>
              <Status tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Status>
            </header>
            <p className="wa-trigger">{t.carrier ? "Any message the company wrote itself, with no template of its own. " : ""}{t.trigger}</p>
            <div className="wa-bubble">
              <strong>{t.header}</strong>
              <p>{t.preview}</p>
              {t.footer && <small>{t.footer}</small>}
              {t.buttons.length > 0 && <div className="wa-buttons">{t.buttons.map((b) => <span key={b}>{b}</span>)}</div>}
            </div>
            {t.reason && <p className="connection-error">Meta's reason: {t.reason}</p>}
            {(t.checkedAt || (data?.connection?.canSubmit && writable && (t.status === "not_submitted" || t.status === "rejected"))) && (
              <footer>
                {t.checkedAt && <span className="muted">Checked {stamp(t.checkedAt)}</span>}
                {data?.connection?.canSubmit && writable && (t.status === "not_submitted" || t.status === "rejected") && (
                  <Button size="sm" busy={submit.isPending && submit.variables?.[0] === t.name} onClick={() => submit.mutate([t.name])}>{t.status === "rejected" ? "Submit again" : "Submit"}</Button>
                )}
              </footer>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
