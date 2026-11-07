import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { registerProvider } from '../registry.js';
import type { InboundMessage, OutgoingMessage, ProviderContext } from '../types.js';
import { basicAuth, callJson, CALL_TIMEOUT_MS } from './http.js';
import { TWILIO_GUIDE_START } from './messages.js';

/*
 * WhatsApp (#98). A business may message someone freely for 24 hours after that person last wrote to it;
 * outside that window WhatsApp delivers only templates approved in advance. The app's messages are written
 * by the company (Masters → Message templates), so they can't each be approved: instead one approved
 * template carries any message as its single variable. Within the window every message goes as written;
 * outside it, through that template if the connection names one, or it fails saying why.
 */

/** The one template to get approved, word for word, so every app message can go out after the 24 hours. */
export const CARRIER_TEMPLATE = {
  name: 'fleet_update',
  category: 'UTILITY',
  body: 'New message from your fleet office: {{1}} Reply here if you have a question.',
};

/** Template variables may not hold line breaks or long runs of spaces (Meta's rule), so the text is joined up. */
export const asTemplateText = (text: string) => text.replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, '   ').slice(0, 1024);

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const digits = (phone: string) => phone.replace(/[^\d]/g, '');
const templateSteps = (where: string, link: string) => [
  { text: `For messages more than 24 hours after a driver last wrote: submit this template in ${where}, category Utility, language English, named ${CARRIER_TEMPLATE.name}, body exactly: "${CARRIER_TEMPLATE.body}". Approval usually takes minutes to a day.`, link },
  { text: 'Without it, messages still go to anyone who wrote in the last 24 hours; the others fail and the outbox says why.' },
];

/* ---------- Meta WhatsApp Cloud API ---------- */

interface MetaSettings { phoneNumberId: string; businessAccountId: string; apiVersion: string; templateName?: string; templateLanguage: string }
interface MetaError { error?: { code?: number; message?: string; error_data?: { details?: string } } }

/** One call to the Graph API; its error code is kept, since 131047 means "outside the 24 hours". */
async function graph(ctx: ProviderContext, path: string, init: RequestInit = {}) {
  const s = ctx.settings as unknown as MetaSettings;
  const res = await fetch(`https://graph.facebook.com/${s.apiVersion}/${path}`, {
    ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { authorization: `Bearer ${ctx.secret('accessToken')}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown> & MetaError;
  if (!res.ok) throw Object.assign(new Error(`WhatsApp (Meta) answered ${res.status}: ${body.error?.error_data?.details ?? body.error?.message ?? res.statusText}`), { code: body.error?.code });
  return body;
}

export const OUTSIDE_WINDOW = 'Outside the 24 hours since this person last wrote, WhatsApp delivers only approved templates';

async function metaSend(ctx: ProviderContext, m: OutgoingMessage) {
  const s = ctx.settings as unknown as MetaSettings;
  const path = `${s.phoneNumberId}/messages`;
  const to = digits(m.to);
  try {
    const sent = await graph(ctx, path, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: m.text.slice(0, 4096) } }) }) as { messages?: Array<{ id: string }> };
    return { providerRef: sent.messages?.[0]?.id };
  } catch (err) {
    if ((err as { code?: number }).code !== 131047) throw err;
    if (!s.templateName) throw new Error(`${OUTSIDE_WINDOW}: get the ${CARRIER_TEMPLATE.name} template approved and name it on this connection.`);
    const sent = await graph(ctx, path, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: s.templateName, language: { code: s.templateLanguage }, components: [{ type: 'body', parameters: [{ type: 'text', text: asTemplateText(m.text) }] }] },
      }),
    }) as { messages?: Array<{ id: string }> };
    return { providerRef: sent.messages?.[0]?.id };
  }
}

/** The messages in a Meta webhook call (statuses and other changes are left out). */
export function metaMessages(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = ((body as { entry?: unknown[] })?.entry ?? []) as Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, any>> } }> }>;
  for (const change of entries.flatMap((e) => e.changes ?? [])) {
    for (const m of change.value?.messages ?? []) {
      const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? m.document?.caption;
      out.push({
        from: `+${digits(String(m.from ?? ''))}`, text, providerRef: m.id, at: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000),
        kind: m.type === 'text' ? 'text' : m.type === 'button' || m.type === 'interactive' ? 'button' : m.type === 'image' || m.type === 'document' ? 'photo' : 'other',
      });
    }
  }
  return out;
}

registerProvider({
  kind: 'whatsapp', key: 'meta', label: 'WhatsApp Cloud API (Meta)',
  description: "WhatsApp straight from Meta, on the company's own WhatsApp Business number. Replies come back to the app.",
  fields: z.strictObject({
    phoneNumberId: z.string().trim().regex(/^\d{5,20}$/, 'The phone number ID: digits, from WhatsApp → API Setup'),
    businessAccountId: z.string().trim().regex(/^\d{5,20}$/, 'The WhatsApp Business Account ID: digits'),
    apiVersion: z.string().trim().regex(/^v\d{2}\.\d$/, 'A Graph API version, e.g. v21.0').default('v21.0'),
    templateName: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'The approved template\'s name, e.g. fleet_update').optional(),
    templateLanguage: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'A language code, e.g. en or en_US').default('en'),
  }),
  labels: { phoneNumberId: 'Phone number ID', businessAccountId: 'WhatsApp Business Account ID', apiVersion: 'API version', templateName: 'Template for after 24 hours', templateLanguage: 'Template language' },
  hints: { templateName: `${CARRIER_TEMPLATE.name} once Meta approves it; see the guide`, apiVersion: 'Leave as it is unless Meta retires it' },
  secrets: [
    { key: 'accessToken', label: 'Access token', required: true, hint: "A system user's permanent token, not the 24-hour test token" },
    { key: 'appSecret', label: 'App secret', required: true, hint: "Checks that replies really come from Meta" },
    { key: 'verifyToken', label: 'Verify token', required: true, hint: 'Any long random text; you type the same into Meta when adding the webhook' },
  ],
  guide: [
    { text: 'In Meta for Developers, make an app of type Business and add the WhatsApp product to it.', link: 'https://developers.facebook.com/apps/' },
    { text: 'WhatsApp → API Setup: add the company\'s phone number (it must not be in use on the WhatsApp app). Copy the Phone number ID and the WhatsApp Business Account ID shown there.', link: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started' },
    { text: 'Access token: in Meta Business Settings → System users, add a system user, give it the app and the WhatsApp account, and generate a token with whatsapp_business_messaging and whatsapp_business_management. The token on API Setup lasts only 24 hours.', link: 'https://business.facebook.com/settings/system-users' },
    { text: 'App secret: App settings → Basic → App secret (Show).' },
    { text: 'Verify token: make up a long random text (for example openssl rand -hex 24) for the verify token setting.' },
    { text: 'Put the three values in the server settings below and restart. Then, in WhatsApp → Configuration → Webhook, set the callback URL to {webhookUrl}, the verify token to the same text, and subscribe to "messages".', link: 'https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks' },
    ...templateSteps('WhatsApp Manager → Message templates', 'https://business.facebook.com/wa/manage/message-templates/'),
    { text: 'Test: send a test message to your own WhatsApp number. Reply to it: the reply reaches the app.' },
  ],
  async test(ctx) {
    const s = ctx.settings as unknown as MetaSettings;
    const number = await graph(ctx, `${s.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`) as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
    return { ok: true, message: `Connected to ${number.display_phone_number ?? s.phoneNumberId}${number.verified_name ? ` (${number.verified_name})` : ''}. Send a test message to check it reaches someone.` };
  },
  open: (ctx) => ({ send: (m) => metaSend(ctx, m) }),
  verifyInbound(ctx, call) {
    const given = call.headers['x-hub-signature-256'];
    if (!given) return 'The call has no X-Hub-Signature-256, so it is not from Meta.';
    const expected = `sha256=${createHmac('sha256', ctx.secret('appSecret')!).update(call.raw).digest('hex')}`;
    return sameText(expected, given) ? undefined : "The signature does not match the app secret: check it's this app's secret.";
  },
  handshake(ctx, query) {
    if (query['hub.mode'] !== 'subscribe' || !query['hub.challenge']) throw new Error('Not a webhook check');
    if (!sameText(String(query['hub.verify_token'] ?? ''), ctx.secret('verifyToken')!)) throw new Error('The verify token does not match');
    return String(query['hub.challenge']);
  },
  async inbound(_ctx, body) {
    const messages = metaMessages(body);
    return { accepted: messages.length, messages };
  },
});

/* ---------- Twilio WhatsApp ---------- */

interface TwilioSettings { accountSid: string; from: string; contentSid?: string }

async function twilioSend(ctx: ProviderContext, m: OutgoingMessage) {
  const s = ctx.settings as unknown as TwilioSettings;
  const post = async (fields: Record<string, string>) => {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`, {
      method: 'POST', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { authorization: basicAuth(s.accountSid, ctx.secret('authToken')!), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ To: `whatsapp:+${digits(m.to)}`, From: `whatsapp:+${digits(s.from)}`, ...fields }),
    });
    const body = await res.json().catch(() => ({})) as { sid?: string; code?: number; message?: string };
    if (!res.ok) throw Object.assign(new Error(`Twilio answered ${res.status}: ${body.message ?? res.statusText}`), { code: body.code });
    return { providerRef: body.sid };
  };
  try {
    return await post({ Body: m.text.slice(0, 1600) });
  } catch (err) {
    // 63016: outside the 24 hours, only an approved template (a content SID) goes.
    if ((err as { code?: number }).code !== 63016) throw err;
    if (!s.contentSid) throw new Error(`${OUTSIDE_WINDOW}: get the ${CARRIER_TEMPLATE.name} template approved in Twilio and name its content SID on this connection.`);
    return post({ ContentSid: s.contentSid, ContentVariables: JSON.stringify({ 1: asTemplateText(m.text) }) });
  }
}

/** Twilio's signature: HMAC-SHA1 of the address it called plus each field name and value, sorted by name. */
export function twilioSignature(authToken: string, url: string, fields: Record<string, string>) {
  const data = url + Object.keys(fields).sort().map((k) => k + fields[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}
const formFields = (raw: Buffer) => Object.fromEntries(new URLSearchParams(raw.toString('utf8')));

registerProvider({
  kind: 'whatsapp', key: 'twilio', label: 'Twilio WhatsApp',
  description: 'WhatsApp through Twilio, on a number Twilio has registered with WhatsApp. Replies come back to the app.',
  fields: z.strictObject({
    accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/, 'An account SID, starting AC'),
    from: z.string().trim().regex(/^\+?\d{7,15}$/, 'The WhatsApp sender number, e.g. +14155238886'),
    contentSid: z.string().trim().regex(/^HX[0-9a-f]{32}$/, 'A content SID, starting HX').optional(),
  }),
  labels: { accountSid: 'Account SID', from: 'WhatsApp sender number', contentSid: 'Template for after 24 hours (content SID)' },
  hints: { from: "Twilio's sandbox number, or the company's number once registered", contentSid: `The ${CARRIER_TEMPLATE.name} template's SID once approved; see the guide` },
  secrets: [{ key: 'authToken', label: 'Auth token', required: true }],
  guide: [
    ...TWILIO_GUIDE_START,
    { text: 'To try it first: Messaging → Try it out → Send a WhatsApp message, and join the sandbox from your phone. Its number is the sender.', link: 'https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn' },
    { text: "For the company's own number: Messaging → Senders → WhatsApp senders → register it with the company's Meta business account.", link: 'https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders' },
    { text: 'Put the auth token in the server setting below and restart. Then set the sender\'s "When a message comes in" webhook to {webhookUrl} (HTTP POST), so replies reach the app.' },
    ...templateSteps('Twilio Content Template Builder (then "Submit for WhatsApp approval")', 'https://console.twilio.com/us1/develop/sms/content-template-builder'),
    { text: 'Test: send a test message to your own WhatsApp number and reply to it.' },
  ],
  async test(ctx) {
    const s = ctx.settings as unknown as TwilioSettings;
    const body = await callJson<{ friendly_name?: string; status?: string }>('Twilio', `https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}.json`, { headers: { authorization: basicAuth(s.accountSid, ctx.secret('authToken')!) } });
    return { ok: body.status !== 'suspended', message: `Account "${body.friendly_name ?? s.accountSid}" is ${body.status ?? 'reachable'}. Send a test message to check it reaches someone.` };
  },
  open: (ctx) => ({ send: (m) => twilioSend(ctx, m) }),
  verifyInbound(ctx, call) {
    const given = call.headers['x-twilio-signature'];
    if (!given) return 'The call has no X-Twilio-Signature, so it is not from Twilio.';
    return sameText(twilioSignature(ctx.secret('authToken')!, call.url, formFields(call.raw)), given) ? undefined : 'The signature does not match the auth token and this address.';
  },
  async inbound(_ctx, body) {
    const f = body as Record<string, string>;
    if (!f.From) return { accepted: 0, note: 'No message in the call' };
    const message: InboundMessage = {
      from: `+${digits(f.From)}`, text: f.Body || f.ButtonText || undefined, providerRef: f.MessageSid, at: new Date(),
      kind: f.ButtonText ? 'button' : Number(f.NumMedia ?? 0) > 0 ? 'photo' : 'text',
    };
    return { accepted: 1, messages: [message] };
  },
});

/* ---------- Marichi Talks ---------- */

/**
 * The group's own messaging service, connected like any other: its address and key. Its API isn't published yet, so
 * this states exactly what the app sends and expects (the guide below says the same), and the address is a setting,
 * so nothing here is fixed to one server.
 */
interface TalksSettings { address: string; sender?: string }
const talksAddress = (ctx: ProviderContext) => (ctx.settings as unknown as TalksSettings).address.replace(/\/$/, '');
const talksHeaders = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.secret('apiKey')!}`, 'content-type': 'application/json' });

registerProvider({
  kind: 'whatsapp', key: 'marichi-talks', label: 'Marichi Talks',
  description: "WhatsApp through the group's own messaging service. Replies come back to the app.",
  fields: z.strictObject({
    address: z.url().refine((u) => /^https:\/\//.test(u), 'An https address'),
    sender: z.string().trim().min(1).max(60).optional(),
  }),
  labels: { address: 'Service address', sender: 'Send as' },
  hints: { address: 'From Marichi Talks, e.g. https://talks.example.com/api', sender: 'The number or name to send from, if the service asks for one' },
  secrets: [{ key: 'apiKey', label: 'API key', required: true, hint: 'From Marichi Talks' }],
  guide: [
    { text: 'Ask Marichi Talks for this service address and an API key.' },
    { text: 'Put the key in the server setting named below, and restart.' },
    { text: 'Give Marichi Talks {webhookUrl} as the address for replies, with the signing secret named below. It signs each call the same way as any other service here.' },
    { text: 'Send a test message. The app sends POST <address>/messages with to, text, title and sender, using the key as a Bearer token, and expects an id back. Replies come as { messages: [{ from, text, id }] }.' },
  ],
  inbound: async (_ctx, body) => {
    const list = ((body as { messages?: unknown[] }).messages ?? []) as Array<{ from?: string; text?: string; id?: string; kind?: InboundMessage['kind'] }>;
    const messages: InboundMessage[] = list.filter((m) => m.from).map((m) => ({ from: `+${digits(String(m.from))}`, text: m.text, providerRef: m.id, kind: m.kind ?? 'text', at: new Date() }));
    return { accepted: messages.length, messages };
  },
  async test(ctx) {
    const res = await fetch(`${talksAddress(ctx)}/health`, { headers: talksHeaders(ctx), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    return res.ok ? { ok: true, message: 'Marichi Talks answered.' } : { ok: false, message: `Marichi Talks answered ${res.status}${res.status === 401 || res.status === 403 ? ': check the API key' : ''}.` };
  },
  open: (ctx) => ({
    async send(m: OutgoingMessage) {
      const s = ctx.settings as unknown as TalksSettings;
      const body = await callJson<{ id?: string }>('Marichi Talks', `${talksAddress(ctx)}/messages`, {
        method: 'POST', headers: talksHeaders(ctx),
        body: JSON.stringify({ to: m.to, text: m.text, ...(m.subject ? { title: m.subject } : {}), ...(s.sender ? { sender: s.sender } : {}) }),
      });
      return { providerRef: body.id };
    },
  }),
});
