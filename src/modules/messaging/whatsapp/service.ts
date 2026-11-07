import type { Types } from 'mongoose';
import type { MessageSender, TemplateManager } from '../../../core/connections/index.js';
import { logger } from '../../../core/logger/index.js';
import type { Plain } from '../../../core/masters/types.js';
import { productName } from '../../company/brand.service.js';
import { activeConnection, openConnection, recordError, recordUse } from '../../connections/connections.service.js';
import { WaTemplateState, noteInbound, planDelivery, type TemplateStatus } from './state.js';
import { CARRIER, HEADER_SAMPLE, WA_TEMPLATES, type WaTemplate, type WaUse, fill, metaDefinition, waTemplate } from './templates.js';

/**
 * WhatsApp through the company's connection (#112): every message the app sends, with its template, and the
 * templates' standing at Meta. Messages to drivers and customers from the desks come here as well as the
 * outbox's, so a real WhatsApp connection reaches them; with none, or the Simulated one, nothing is sent.
 */

/** The WhatsApp connection in use, when it is a real service; null for none or the Simulated one. */
async function inUse() {
  const connection = await activeConnection('whatsapp');
  const opened = connection ? openConnection<'whatsapp'>(connection) : undefined;
  if (!connection || !opened || opened.provider.simulated || opened.provider.comingSoon) return null;
  return { connection, provider: opened.provider, sender: opened.capability as MessageSender };
}

const asText = (title: string | undefined, text: string) => (title ? `*${title}*\n${text}` : text);

/**
 * One message from a desk (a driver's or customer's thread, an approver's buttons): planned against the
 * 24-hour window and the approved templates, then sent. Null when there is no real WhatsApp connection.
 */
export async function deliverWhatsApp(message: { to: string; title?: string; text: string; buttons?: string[]; use?: WaUse }) {
  const live = await inUse();
  if (!live) return null;
  const text = asText(message.title, message.text);
  const plan = await planDelivery({ connectionId: live.connection._id, to: message.to, text, buttons: message.buttons, use: message.use, company: await productName() });
  try {
    const sent = await live.sender.send({ to: message.to, text, whatsapp: plan });
    await recordUse(live.connection._id);
    return { status: 'sent' as const, providerRef: sent.providerRef, ...(plan.template ? { template: plan.template.name } : {}) };
  } catch (err) {
    const error = (err as Error).message;
    await recordError(live.connection._id, error);
    return { status: 'failed' as const, error };
  }
}

/** The plan for an outbox message (company templates, #19), for the dispatcher. */
export async function outboxPlan(connectionId: unknown, to: string, text: string, use?: WaUse) {
  return planDelivery({ connectionId, to, text, use, company: await productName() });
}

/**
 * A company template on WhatsApp may name one of the pack's (its provider template, e.g. advance_request):
 * its values are worked out from the same placeholders, so it can go out after the 24 hours.
 */
export function useForCompanyTemplate(providerTemplateId: unknown, render: (text: string) => string): WaUse | undefined {
  if (!providerTemplateId) return undefined;
  const id = String(providerTemplateId);
  const t = waTemplate(id) ?? waTemplate(id.replace(/_v\d+$/, ''));
  if (!t?.placeholders) return undefined;
  return { template: t.name as WaUse['template'], values: t.placeholders.map(render) };
}

/** A reply opens the sender's 24 hours. */
export const noteReply = (phone: string, at?: Date) => noteInbound(phone, at);

/* ---------- The templates ---------- */

async function manager(): Promise<{ connection: Plain; templates: TemplateManager } | null> {
  const live = await inUse();
  return live?.sender.templates ? { connection: live.connection, templates: live.sender.templates } : null;
}

const STATUS_FROM_META: Record<string, TemplateStatus> = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled', PENDING_DELETION: 'disabled' };

/** Every template, as the person will read it (samples filled in), with what sends it and where it stands. */
export async function listTemplates() {
  const live = await inUse();
  const states = live ? await WaTemplateState.find({ connectionId: live.connection._id as Types.ObjectId }).lean<Plain[]>() : [];
  const company = await productName();
  return {
    connection: live ? { id: String(live.connection._id), name: live.connection.name, provider: live.provider.label, canSubmit: Boolean(live.sender.templates) } : null,
    templates: WA_TEMPLATES.map((t: WaTemplate) => {
      const state = states.find((s) => s.name === t.name && s.language === t.language);
      return {
        name: t.name, category: t.category, language: t.language, audience: t.audience, trigger: t.trigger,
        header: fill(t.header, [company || HEADER_SAMPLE]), body: t.body, preview: fill(t.body, t.samples), footer: t.footer, buttons: t.buttons ?? [], samples: t.samples,
        carrier: t.name === CARRIER,
        status: (state?.status as TemplateStatus | undefined) ?? 'not_submitted', reason: state?.reason, submittedAt: state?.submittedAt, checkedAt: state?.checkedAt,
      };
    }),
  };
}

/** Submits templates to Meta through the connection's own key; one refused doesn't stop the rest. */
export async function submitTemplates(names?: string[]) {
  const m = await manager();
  if (!m) throw new Error('Connect WhatsApp through the Cloud API (Meta) first: templates are submitted with its key');
  const results: Array<{ name: string; ok: boolean; status?: string; message?: string }> = [];
  for (const t of WA_TEMPLATES.filter((x) => !names?.length || names.includes(x.name))) {
    try {
      const made = await m.templates.submit(metaDefinition(t));
      const status = STATUS_FROM_META[made.status.toUpperCase()] ?? 'pending';
      await WaTemplateState.updateOne({ connectionId: m.connection._id as Types.ObjectId, name: t.name, language: t.language }, { $set: { status, metaId: made.id, submittedAt: new Date(), checkedAt: new Date() }, $unset: { reason: 1 } }, { upsert: true });
      results.push({ name: t.name, ok: true, status });
    } catch (err) {
      results.push({ name: t.name, ok: false, message: (err as Error).message });
    }
  }
  // A template already at Meta can't be submitted twice: its standing is read instead.
  if (results.some((r) => !r.ok)) await refreshTemplates().catch(() => undefined);
  return results;
}

/** Reads each template's standing from Meta: Approved, Pending, Rejected (with the reason) or Paused. */
export async function refreshTemplates() {
  const m = await manager();
  if (!m) return { refreshed: 0 };
  const standings = await m.templates.standings();
  let refreshed = 0;
  for (const t of WA_TEMPLATES) {
    const found = standings.find((s) => s.name === t.name && s.language === t.language);
    if (!found) continue;
    await WaTemplateState.updateOne({ connectionId: m.connection._id as Types.ObjectId, name: t.name, language: t.language }, {
      $set: { status: STATUS_FROM_META[found.status.toUpperCase()] ?? 'pending', metaId: found.id, checkedAt: new Date(), ...(found.reason ? { reason: found.reason } : {}) },
      ...(found.reason ? {} : { $unset: { reason: 1 } }),
    }, { upsert: true });
    refreshed++;
  }
  return { refreshed };
}

/** The pack for someone submitting it by hand: Meta's own JSON. */
export const templatesJson = () => WA_TEMPLATES.map(metaDefinition);

/** The pack as a document a business can read and type into WhatsApp Manager. */
export function templatesDocument(company = 'the company') {
  const lines = [
    `# WhatsApp message templates for ${company}`,
    '',
    "Submit each one in WhatsApp Manager → Message templates → Create template. All are category Utility, language English. Type the text exactly as below: {{1}}, {{2}} are the variables, and the samples are what Meta asks for under \"Add sample\".",
    '',
    'Within 24 hours of someone\'s last message the app writes freely. After that WhatsApp delivers only these.',
    '',
  ];
  for (const t of WA_TEMPLATES as readonly WaTemplate[]) {
    lines.push(`## ${t.name}`, '', `- **Sent when:** ${t.trigger}`, `- **Category:** ${t.category === 'UTILITY' ? 'Utility' : 'Authentication'} · **Language:** English (${t.language})`,
      `- **Header (text):** ${t.header} · sample for {{1}}: ${HEADER_SAMPLE}`, `- **Body:** ${t.body}`,
      ...t.samples.map((s, i) => `  - sample for {{${i + 1}}}: ${s}`),
      ...(t.footer ? [`- **Footer:** ${t.footer}`] : []),
      ...(t.buttons?.length ? [`- **Quick-reply buttons:** ${t.buttons.join(', ')}`] : []),
      `- **Reads as:** ${fill(t.body, t.samples)}`, '');
  }
  return lines.join('\n');
}

let timer: NodeJS.Timeout | undefined;
/** Inside the server (IN_PROCESS_JOBS): reads the templates' standing once a day. */
export function startTemplateRefresh() {
  const tick = async () => {
    try { await refreshTemplates(); } catch (err) { logger.warn({ err }, 'WhatsApp template statuses could not be read'); }
  };
  timer = setInterval(() => void tick(), 24 * 3600_000);
  timer.unref();
}
export const stopTemplateRefresh = () => { if (timer) clearInterval(timer); timer = undefined; };
