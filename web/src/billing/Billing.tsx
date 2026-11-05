import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Send } from "lucide-react";
import { api, ApiError, authorizedFetch, request } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Empty, Field, FieldGroup, Modal, Rows, Segmented, Status } from "../ui/kit";
import { Card } from "../desks/stages";
import { baseCurrencyCode } from "../ui/format";
import { MoneySettings } from "./MoneySettings";

/**
 * Billing (#61): closed trips waiting for an invoice, invoices and credit notes from draft to paid, payments
 * received with their exchange gain or loss, and the money settings. Amounts come from the API in minor units.
 */

type Tab = "invoice" | "invoices" | "payments" | "settings";
const PAGE = 25;
/** An amount in an invoice's or payment's currency, or in the base currency (gains and losses). */
const money = (minor: unknown, of: Rec | "base") => {
  const units = of === "base" ? 2 : Number(of.minorUnits ?? 2);
  const code = of === "base" ? baseCurrencyCode() : String(of.currency ?? "");
  return `${(Number(minor ?? 0) / 10 ** units).toLocaleString("en-GB", { minimumFractionDigits: units, maximumFractionDigits: units })} ${code}`;
};
const day = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const STATE: Record<string, { tone: "ok" | "wait" | "bad" | "info" | "mute"; text: string }> = {
  draft: { tone: "info", text: "Draft" }, cancelled: { tone: "mute", text: "Cancelled" },
  unpaid: { tone: "wait", text: "Unpaid" }, part_paid: { tone: "wait", text: "Part paid" }, paid: { tone: "ok", text: "Paid" },
};
const stateOf = (i: Rec) => STATE[i.status === "approved" ? (i.kind === "credit_note" ? "paid" : String(i.paymentState)) : String(i.status)] ?? STATE.draft;

export function Billing() {
  const { me } = useApp();
  const [tab, setTab] = useState<Tab>("invoice");
  const [open, setOpen] = useState<string | null>(null);
  const tabs: { value: Tab; label: string }[] = [
    { value: "invoice", label: "To invoice" }, { value: "invoices", label: "Invoices" }, { value: "payments", label: "Payments received" },
    ...(can(me, "finance-settings", "read") ? [{ value: "settings" as Tab, label: "Settings" }] : []),
  ];
  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Billing</h2>
          <p>Invoices from closed trips at each customer's rates, payments received, and the exchange gain or loss on them.</p>
        </div>
      </header>
      <div className="desk-tools">
        <Segmented label="Billing" value={tab} options={tabs} onChange={setTab} />
      </div>
      {tab === "invoice" && <ToInvoice onOpen={(id) => { setTab("invoices"); setOpen(id); }} />}
      {tab === "invoices" && <Invoices onOpen={setOpen} />}
      {tab === "payments" && <Payments onOpen={setOpen} />}
      {tab === "settings" && <MoneySettings billing />}
      <InvoiceDrawer id={open} onClose={() => setOpen(null)} onOpen={setOpen} />
    </div>
  );
}

function useAct() {
  const { toast } = useApp();
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, work: () => Promise<{ message?: string }>, after?: () => void) => {
    setBusy(key);
    try {
      const result = await work();
      if (result.message) toast(result.message);
      await client.invalidateQueries({ queryKey: ["billing"] });
      after?.();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  };
  return { busy, act };
}

function ToInvoice({ onOpen }: { onOpen: (id: string) => void }) {
  const { me } = useApp();
  const trips = useQuery({ queryKey: ["billing", "unbilled"], queryFn: () => request<Rec[]>("/invoices/unbilled-trips", { query: { limit: 100 } }) });
  const { busy, act } = useAct();
  const writable = can(me, "invoices", "create");
  const [skipped, setSkipped] = useState<Rec[]>([]);
  const draft = (tripIds?: string[]) => act(tripIds ? tripIds[0]! : "all", async () => {
    const res = await request<{ drafted: Rec[]; skipped: Rec[] }>("/invoices/draft", { method: "POST", body: tripIds ? { tripIds } : {} });
    setSkipped(res.data.skipped);
    if (res.data.drafted.length === 1) onOpen(String(res.data.drafted[0]!.id));
    return res;
  });
  const rows = trips.data?.data ?? [];
  return (
    <Card title="Closed trips without an invoice" aside={writable && rows.length > 0 && <Button size="sm" tone="primary" busy={busy === "all"} onClick={() => void draft()}>Draft all</Button>}>
      {trips.isLoading && <p className="muted">Loading…</p>}
      {trips.error && <Empty title="Could not load the trips">{(trips.error as Error).message}</Empty>}
      {trips.data && !rows.length && <Empty title="Every closed trip is invoiced" />}
      {skipped.length > 0 && <ul className="muted">{skipped.map((s) => <li key={String(s.tripId)}>{String(s.reason)}</li>)}</ul>}
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>Trip</th><th>Customer</th><th>Closed</th><th>Rate</th><th /></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={String(t.id)}>
                <td className="mono">{String(t.number)}</td>
                <td>{String(t.customer)}</td>
                <td>{day(t.endedAt)}</td>
                <td>{t.problem ? <span className="muted">{String(t.problem)}</span> : <Status tone="ok">Priced</Status>}</td>
                <td className="right">{writable && !t.problem && <Button size="sm" busy={busy === t.id} onClick={() => void draft([String(t.id)])}>Draft invoice</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Invoices({ onOpen }: { onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<"open" | "draft" | "all">("open");
  const [page, setPage] = useState(1);
  const query = filter === "open" ? { open: "true" } : filter === "draft" ? { status: "draft" } : {};
  const list = useQuery({ queryKey: ["billing", "invoices", filter, page], queryFn: () => request<Rec[]>("/invoices", { query: { ...query, page, limit: PAGE } }) });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta?.total ?? 0;
  return (
    <Card title="Invoices and credit notes" aside={<Segmented label="Show" value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[{ value: "open", label: "Owed" }, { value: "draft", label: "Drafts" }, { value: "all", label: "All" }]} />}>
      {list.isLoading && <p className="muted">Loading…</p>}
      {list.error && <Empty title="Could not load the invoices">{(list.error as Error).message}</Empty>}
      {list.data && !rows.length && <Empty title={filter === "open" ? "Nothing is owed" : filter === "draft" ? "No drafts" : "No invoices yet"} />}
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>Number</th><th>Customer</th><th>Date</th><th>Due</th><th className="right">Total</th><th className="right">Owed</th><th>State</th></tr></thead>
          <tbody>
            {rows.map((i) => {
              const s = stateOf(i);
              return (
                <tr key={String(i.id)} className="clickable" onClick={() => onOpen(String(i.id))}>
                  <td className="mono">{String(i.title)}</td>
                  <td>{String(i.customer)}</td>
                  <td>{day(i.date)}</td>
                  <td>{i.kind === "credit_note" ? "Credit note" : day(i.dueDate)}</td>
                  <td className="right num">{money(i.totalMinor, i)}</td>
                  <td className="right num">{i.status === "approved" && i.kind === "invoice" ? money(i.openMinor, i) : "—"}</td>
                  <td><Status tone={s.tone}>{s.text}</Status></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {total > PAGE && (
        <div className="pager">
          <span className="muted">{total} · page {page} of {Math.ceil(total / PAGE)}</span>
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
          <Button size="sm" disabled={page * PAGE >= total} onClick={() => setPage(page + 1)}>Older</Button>
        </div>
      )}
    </Card>
  );
}

function InvoiceDrawer({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { me, toast } = useApp();
  const invoice = useQuery({ queryKey: ["billing", "invoice", id], enabled: Boolean(id), queryFn: () => api<Rec>(`/invoices/${id}`) });
  const { busy, act } = useAct();
  const [credit, setCredit] = useState(false);
  const i = invoice.data;
  const post = (path: string, body: object = {}) => () => request(`/invoices/${id}${path}`, { method: "POST", body });
  const download = async () => {
    try {
      const res = await authorizedFetch(`/invoices/${id}/pdf`);
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement("a"), { href: url, download: `${String(i?.title ?? "invoice").replace(/[\\/]/g, "-")}.pdf` }).click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "The download failed.", "error");
    }
  };
  const isDraft = i?.status === "draft";
  const footer = i && (
    <>
      <Button onClick={() => void download()}><Download size={16} /> PDF</Button>
      {isDraft && can(me, "invoices", "update") && <Button tone="danger" busy={busy === "cancel"} onClick={() => void act("cancel", post("/cancel", { version: i.version, reason: "Cancelled from the billing desk" }))}>Cancel draft</Button>}
      {isDraft && can(me, "invoices", "create") && <Button tone="primary" busy={busy === "approve"} onClick={() => void act("approve", post("/approve", { version: i.version }))}>Approve</Button>}
      {i.status === "approved" && can(me, "invoices", "update") && <Button busy={busy === "send"} onClick={() => void act("send", post("/send"))}><Send size={16} /> {i.sentAt ? "Send again" : "Send to customer"}</Button>}
      {i.status === "approved" && i.kind === "invoice" && Number(i.openMinor) > 0 && can(me, "invoices", "create") && <Button onClick={() => setCredit(true)}>Credit note</Button>}
    </>
  );
  const lines = (i?.lines ?? []) as Rec[];
  return (
    <Drawer open={Boolean(id)} title={i ? String(i.title) : "Invoice"} onClose={onClose} footer={footer} width={640}>
      {invoice.isLoading && <p className="muted">Loading…</p>}
      {invoice.error && <Empty title="Could not load it">{(invoice.error as Error).message}</Empty>}
      {i && (
        <>
          <Rows rows={[
            ["Customer", String(i.customer)],
            ["Date", day(i.date)],
            ...(i.kind === "invoice" ? [["Due", day(i.dueDate)] as [string, string]] : []),
            ["State", <Status key="s" tone={stateOf(i).tone}>{stateOf(i).text}</Status>],
            ...(i.rateToBase && i.rateToBase !== 1 ? [["Rate to base", `1 ${i.currency} = ${Number(i.rateToBase)}`] as [string, string]] : []),
            ...(i.sentAt ? [["Sent", day(i.sentAt)] as [string, string]] : []),
          ]} />
          <table className="table">
            <thead><tr><th>Line</th><th className="right">Quantity</th><th className="right">Price</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={String(l.id ?? l.description)}>
                  <td>{String(l.description)}</td>
                  <td className="right num">{Number(l.qty).toLocaleString("en-GB", { maximumFractionDigits: 3 })}{l.unit ? ` ${l.unit}` : ""}</td>
                  <td className="right num">{money(Math.round(Number(l.unitPriceMinor)), i)}</td>
                  <td className="right num">{money(l.amountMinor, i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Rows rows={[
            ["Before tax", money(i.netMinor, i)],
            ...(Number(i.taxMinor) ? [[String(i.taxLabel ?? "Tax"), money(i.taxMinor, i)] as [string, string]] : []),
            [i.kind === "credit_note" ? "Credited" : "Total", <strong key="t">{money(i.totalMinor, i)}</strong>],
            ...(i.status === "approved" && i.kind === "invoice" ? [["Still owed", money(i.openMinor, i)] as [string, string]] : []),
          ]} />
          {((i.payments ?? []) as Rec[]).length > 0 && (
            <>
              <h3>Payments</h3>
              <Rows rows={((i.payments ?? []) as Rec[]).map((p) => [`${String(p.number)} · ${day(p.date)}`, `${money(p.settledMinor, i)}${Number(p.gainLossBaseMinor) ? ` · exchange ${Number(p.gainLossBaseMinor) > 0 ? "gain" : "loss"} ${money(Math.abs(Number(p.gainLossBaseMinor)), "base")}` : ""}`] as [string, string])} />
            </>
          )}
          {((i.creditNotes ?? []) as Rec[]).length > 0 && (
            <>
              <h3>Credit notes</h3>
              <Rows rows={((i.creditNotes ?? []) as Rec[]).map((c) => [<button key="c" className="link-btn" onClick={() => onOpen(String(c.id))}>{String(c.title)}</button>, money(c.totalMinor, c)] as [ReactNode, string])} />
            </>
          )}
        </>
      )}
      {i && credit && <CreditNote invoice={i} onClose={() => setCredit(false)} onDone={(cid) => { setCredit(false); onOpen(cid); }} />}
    </Drawer>
  );
}

function CreditNote({ invoice, onClose, onDone }: { invoice: Rec; onClose: () => void; onDone: (id: string) => void }) {
  const { busy, act } = useAct();
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const whole = !Number(invoice.paidMinor) && !Number(invoice.creditedMinor);
  const [all, setAll] = useState(whole);
  const submit = () => act("credit", async () => {
    const body = all ? { reason } : { reason, lines: [{ kind: "other", description: reason, qty: 1, unitPriceMinor: Math.round(Number(amount) * 10 ** Number(invoice.minorUnits ?? 2)) }] };
    const res = await request<Rec>(`/invoices/${invoice.id}/credit-notes`, { method: "POST", body });
    onDone(String(res.data.id));
    return res;
  });
  return (
    <Modal open title={`Credit note against ${String(invoice.title)}`} onClose={onClose} footer={<Button tone="primary" busy={busy === "credit"} disabled={!reason || (!all && !(Number(amount) > 0))} onClick={() => void submit()}>Draft credit note</Button>}>
      <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {whole && <Segmented choice label="Credit" value={all ? "all" : "part"} onChange={(v) => setAll(v === "all")} options={[{ value: "all", label: "The whole invoice" }, { value: "part", label: "An amount" }]} />}
      {!all && <Field label={`Amount to credit, without tax (${String(invoice.currency)})`} hint={`Up to ${money(invoice.openMinor, invoice)} is owed.`}><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
    </Modal>
  );
}

function Payments({ onOpen }: { onOpen: (id: string) => void }) {
  const { me } = useApp();
  const [page, setPage] = useState(1);
  const [recording, setRecording] = useState(false);
  const list = useQuery({ queryKey: ["billing", "payments", page], queryFn: () => request<Rec[]>("/payments-received", { query: { page, limit: PAGE } }) });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta?.total ?? 0;
  return (
    <Card title="Payments received" aside={can(me, "payments-received", "create") && <Button size="sm" tone="primary" onClick={() => setRecording(true)}>Record a payment</Button>}>
      {list.isLoading && <p className="muted">Loading…</p>}
      {list.error && <Empty title="Could not load the payments">{(list.error as Error).message}</Empty>}
      {list.data && !rows.length && <Empty title="No payments recorded yet" />}
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>Receipt</th><th>Customer</th><th>Date</th><th className="right">Amount</th><th>Against</th><th className="right">Exchange</th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const amount = p.amount as Rec;
              const gain = Number(p.gainLossBaseMinor ?? 0);
              return (
                <tr key={String(p.id)}>
                  <td className="mono">{String(p.number)}</td>
                  <td>{String(p.customer)}</td>
                  <td>{day(p.date)}</td>
                  <td className="right num">{money(amount.amountMinor, p)}</td>
                  <td>{((p.allocations ?? []) as Rec[]).map((a) => <button key={String(a.invoiceId)} className="link-btn" onClick={() => onOpen(String(a.invoiceId))}>{String(a.invoiceNumber)}</button>)}{Number(p.unallocatedMinor) > 0 && <span className="muted"> · {money(p.unallocatedMinor, p)} not set against an invoice</span>}</td>
                  <td className="right num">{gain ? `${gain > 0 ? "Gain" : "Loss"} ${money(Math.abs(gain), "base")}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {total > PAGE && (
        <div className="pager">
          <span className="muted">{total} · page {page} of {Math.ceil(total / PAGE)}</span>
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
          <Button size="sm" disabled={page * PAGE >= total} onClick={() => setPage(page + 1)}>Older</Button>
        </div>
      )}
      {recording && <RecordPayment onClose={() => setRecording(false)} />}
    </Card>
  );
}

function RecordPayment({ onClose }: { onClose: () => void }) {
  const { busy, act } = useAct();
  const customers = useQuery({ queryKey: ["billing", "customers"], queryFn: () => api<Rec[]>("/parties", { query: { role: "customer", status: "active", limit: 100 } }) });
  const currencies = useQuery({ queryKey: ["money-currencies"], queryFn: () => api<Rec[]>("/currencies", { query: { status: "active", limit: 100 } }) });
  const methods = useQuery({ queryKey: ["billing", "methods"], queryFn: () => api<Rec[]>("/payment-methods", { query: { status: "active", limit: 100 } }) });
  const [form, setForm] = useState({ customerId: "", date: new Date().toISOString().slice(0, 10), amount: "", currencyId: "", paymentMethodId: "", reference: "" });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const currency = (currencies.data ?? []).find((c) => c.id === form.currencyId);
  const units = Number(currency?.minorUnits ?? 2);
  const ready = form.customerId && form.currencyId && Number(form.amount) > 0;
  const submit = () => act("pay", async () => {
    const res = await request("/payments-received", { method: "POST", body: {
      customerId: form.customerId, date: form.date, amount: { amountMinor: Math.round(Number(form.amount) * 10 ** units), currencyId: form.currencyId },
      ...(form.paymentMethodId ? { paymentMethodId: form.paymentMethodId } : {}), ...(form.reference ? { reference: form.reference } : {}),
    } });
    return res;
  }, onClose);
  return (
    <Modal open title="Record a payment" onClose={onClose} footer={<Button tone="primary" busy={busy === "pay"} disabled={!ready} onClick={() => void submit()}>Record</Button>}>
      <Field label="Customer">
        <select className="input" value={form.customerId} onChange={(e) => set({ customerId: e.target.value })}>
          <option value="">Choose…</option>
          {(customers.data ?? []).map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>)}
        </select>
      </Field>
      <Field label="Received on"><input className="input" type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} /></Field>
      <FieldGroup label="Amount" hint="Set against the customer's oldest invoices first. Each part records its exchange gain or loss.">
        <span className="range-inputs">
          <input className="input" inputMode="decimal" aria-label="Amount" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
          <select className="input" aria-label="Currency" value={form.currencyId} onChange={(e) => set({ currencyId: e.target.value })}>
            <option value="">Currency</option>
            {(currencies.data ?? []).map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.code)}</option>)}
          </select>
        </span>
      </FieldGroup>
      <Field label="How it was paid">
        <select className="input" value={form.paymentMethodId} onChange={(e) => set({ paymentMethodId: e.target.value })}>
          <option value="">Not said</option>
          {(methods.data ?? []).map((m) => <option key={String(m.id)} value={String(m.id)}>{String(m.name)}</option>)}
        </select>
      </Field>
      <Field label="Reference"><input className="input" value={form.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
    </Modal>
  );
}
