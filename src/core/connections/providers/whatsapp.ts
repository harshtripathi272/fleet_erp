import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { registerProvider } from '../registry.js';
import type { InboundMessage, OutgoingMessage, ProviderContext, TemplateDefinition, TemplateStanding } from '../types.js';
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

/** The message as Meta takes it: a template with its values, reply buttons, or plain text. */
function metaPayload(m: OutgoingMessage, to: string) {
  const t = m.whatsapp?.template;
  if (t) {
    return {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: t.name, language: { code: t.language },
        components: [
          ...(t.header.length ? [{ type: 'header', parameters: t.header.map((text) => ({ type: 'text', text })) }] : []),
          { type: 'body', parameters: t.body.map((text) => ({ type: 'text', text })) },
          // Quick replies come back with their button's text; no payload is needed.
          ...Array.from({ length: t.buttons }, (_, index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: `reply-${index}` }] })),
        ],
      },
    };
  }
  const buttons = (m.whatsapp?.buttons ?? []).slice(0, 3);
  if (buttons.length) {
    return {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'button', body: { text: m.text.slice(0, 1024) }, action: { buttons: buttons.map((title, i) => ({ type: 'reply', reply: { id: `b${i}`, title: title.slice(0, 20) } })) } },
    };
  }
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.text.slice(0, 4096) } };
}

async function metaSend(ctx: ProviderContext, m: OutgoingMessage) {
  const s = ctx.settings as unknown as MetaSettings;
  const path = `${s.phoneNumberId}/messages`;
  const to = digits(m.to);
  try {
    const sent = await graph(ctx, path, { method: 'POST', body: JSON.stringify(metaPayload(m, to)) }) as { messages?: Array<{ id: string }> };
    return { providerRef: sent.messages?.[0]?.id };
  } catch (err) {
    if ((err as { code?: number }).code !== 131047) throw err;
    // The messaging module chose free text, so nothing it needs is approved yet: say which template.
    if (m.whatsapp?.needed) throw new Error(`${OUTSIDE_WINDOW}: submit the ${m.whatsapp.needed} template (Connections → WhatsApp templates) and wait for Meta to approve it.`);
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
      const file = m.image ?? m.document;
      out.push({
        from: `+${digits(String(m.from ?? ''))}`, text, providerRef: m.id, at: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000),
        ...(file?.id ? { media: { ref: String(file.id), mime: file.mime_type, caption: file.caption, filename: file.filename } } : {}),
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
  open: (ctx) => ({
    send: (m) => metaSend(ctx, m),
    templates: {
      async submit(definition: TemplateDefinition) {
        const s = ctx.settings as unknown as MetaSettings;
        const made = await graph(ctx, `${s.businessAccountId}/message_templates`, { method: 'POST', body: JSON.stringify(definition) }) as { id?: string; status?: string };
        return { id: made.id, status: String(made.status ?? 'PENDING') };
      },
      async standings(): Promise<TemplateStanding[]> {
        const s = ctx.settings as unknown as MetaSettings;
        const list = await graph(ctx, `${s.businessAccountId}/message_templates?fields=name,status,language,rejected_reason,id&limit=250`) as { data?: Array<{ name: string; status: string; language: string; rejected_reason?: string; id?: string }> };
        return (list.data ?? []).map((t) => ({ name: t.name, language: t.language, status: t.status, id: t.id, ...(t.rejected_reason && t.rejected_reason !== 'NONE' ? { reason: t.rejected_reason } : {}) }));
      },
    },
    // A photo in a reply: its address first, then the file, both with the connection's token.
    async media(ref: string) {
      const found = await graph(ctx, encodeURIComponent(ref)) as { url?: string; mime_type?: string };
      if (!found.url) throw new Error('WhatsApp (Meta) gave no address for the photo');
      const res = await fetch(found.url, { headers: { authorization: `Bearer ${ctx.secret('accessToken')}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`WhatsApp (Meta) answered ${res.status} for the photo`);
      return { body: Buffer.from(await res.arrayBuffer()), mime: found.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream' };
    },
  }),
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
  // Templates go by content SID; this connection has one, the carrier (per-template SIDs are not wired yet).
  if (m.whatsapp?.template && s.contentSid) return post({ ContentSid: s.contentSid, ContentVariables: JSON.stringify({ 1: asTemplateText(m.text) }) });
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
  open: (ctx) => ({
    send: (m) => twilioSend(ctx, m),
    async media(ref: string) {
      const s = ctx.settings as unknown as TwilioSettings;
      const res = await fetch(ref, { headers: { authorization: basicAuth(s.accountSid, ctx.secret('authToken')!) }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Twilio answered ${res.status} for the photo`);
      return { body: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
  }),
  verifyInbound(ctx, call) {
    const given = call.headers['x-twilio-signature'];
    if (!given) return 'The call has no X-Twilio-Signature, so it is not from Twilio.';
    return sameText(twilioSignature(ctx.secret('authToken')!, call.url, formFields(call.raw)), given) ? undefined : 'The signature does not match the auth token and this address.';
  },
  async inbound(_ctx, body) {
    const f = body as Record<string, string>;
    if (!f.From) return { accepted: 0, note: 'No message in the call' };
    const photo = Number(f.NumMedia ?? 0) > 0 && f.MediaUrl0;
    const message: InboundMessage = {
      from: `+${digits(f.From)}`, text: f.Body || f.ButtonText || undefined, providerRef: f.MessageSid, at: new Date(),
      kind: f.ButtonText ? 'button' : photo ? 'photo' : 'text',
      ...(photo ? { media: { ref: f.MediaUrl0!, mime: f.MediaContentType0, caption: f.Body || undefined } } : {}),
    };
    return { accepted: 1, messages: [message] };
  },
});

/* ---------- Marichi Talks ---------- */

registerProvider({
  kind: 'whatsapp', key: 'marichi-talks', label: 'Marichi Talks',
  description: "The group's own messaging service.",
  comingSoon: 'Marichi Talks has no API to connect to yet. Until it has, use the WhatsApp Cloud API (Meta) or Twilio WhatsApp.',
  fields: z.strictObject({}),
  async test() { return { ok: false, message: 'Marichi Talks cannot be connected yet.' }; },
  open: () => ({ async send() { throw new Error('Marichi Talks cannot be connected yet.'); } }),
});
