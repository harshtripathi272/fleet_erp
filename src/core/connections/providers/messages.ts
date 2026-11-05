import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sendOverSmtp } from '../../mail/mailer.js';
import { registerProvider } from '../registry.js';
import type { OutgoingMessage } from '../types.js';
import { basicAuth, callJson } from './http.js';

/*
 * E-mail, SMS and WhatsApp providers. "Test connection" on these sends a real test message through the
 * dispatcher (it lands in the outbox), so `test()` here only checks the settings are complete.
 */

const ready = async () => ({ ok: true, message: 'Settings are complete. Send a test message to check it reaches someone.' });

/** Messages a simulated provider "sent", newest first, so tests and the console can show them. */
const simulatedSent: Array<OutgoingMessage & { kind: string; at: string; providerRef: string }> = [];
export const simulatedMessages = () => [...simulatedSent];
const keep = (kind: string, message: OutgoingMessage) => {
  const providerRef = `sim-${randomUUID()}`;
  simulatedSent.unshift({ ...message, kind, at: new Date().toISOString(), providerRef });
  simulatedSent.length = Math.min(simulatedSent.length, 50);
  return { providerRef, simulated: true };
};

registerProvider({
  kind: 'email', key: 'smtp', label: 'SMTP server',
  description: 'Any mail server that accepts SMTP: Google Workspace, Microsoft 365, or your own.',
  fields: z.strictObject({
    host: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, 'A host name, e.g. smtp.gmail.com'),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().trim().max(200).optional(),
    from: z.string().trim().min(3).max(200),
  }),
  labels: { host: 'SMTP server', secure: 'Encrypted from the start (port 465)', user: 'User name', from: 'From address' },
  hints: { host: 'e.g. smtp.gmail.com', from: 'e.g. Acme Haulage <fleet@company.com>', port: '587 for most servers, 465 when encrypted from the start' },
  secrets: [{ key: 'password', label: 'SMTP password', required: false, hint: 'Needed when the server asks for a user name' }],
  test: ready,
  open: (ctx) => ({
    async send(m) {
      const s = ctx.settings as { host: string; port?: number; secure?: boolean; user?: string; from: string };
      return sendOverSmtp({ host: s.host, port: s.port ?? 587, secure: Boolean(s.secure), user: s.user, pass: s.user ? ctx.secret('password') : undefined, from: s.from }, { to: m.to, subject: m.subject ?? '', text: m.text, attachments: m.attachments });
    },
  }),
});

registerProvider({
  kind: 'email', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Keeps each e-mail in the outbox, marked Simulated, and sends nothing.',
  fields: z.strictObject({}), test: ready,
  open: () => ({ send: async (m) => keep('email', m) }),
});

registerProvider({
  kind: 'sms', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Keeps each SMS in the outbox, marked Simulated, and sends nothing.',
  fields: z.strictObject({ senderId: z.string().trim().max(20).optional() }),
  labels: { senderId: 'Sender name' },
  test: ready,
  open: () => ({ send: async (m) => keep('sms', m) }),
});

/** Africa's Talking: SMS across East and Southern Africa, including Zambia and Tanzania. */
registerProvider({
  kind: 'sms', key: 'africastalking', label: "Africa's Talking",
  description: "SMS through Africa's Talking. Use the sandbox while trying it out.",
  fields: z.strictObject({
    username: z.string().trim().min(1).max(100),
    senderId: z.string().trim().max(20).optional(),
    sandbox: z.boolean().default(false),
  }),
  labels: { username: 'Account user name', senderId: 'Sender name', sandbox: 'Sandbox (test account)' },
  hints: { username: '"sandbox" for the test account', senderId: 'A registered sender ID or short code; left empty, the default one' },
  secrets: [{ key: 'apiKey', label: 'API key', required: true }],
  async test(ctx) {
    const s = ctx.settings as { username: string; sandbox?: boolean };
    const host = s.sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = await callJson<{ UserData?: { balance?: string } }>("Africa's Talking", `https://${host}/version1/user?username=${encodeURIComponent(s.username)}`, { headers: { apiKey: ctx.secret('apiKey')! } });
    return { ok: true, message: `Signed in. Balance: ${body.UserData?.balance ?? 'not shown'}.` };
  },
  open: (ctx) => ({
    async send(m) {
      const s = ctx.settings as { username: string; senderId?: string; sandbox?: boolean };
      const host = s.sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
      const form = new URLSearchParams({ username: s.username, to: m.to, message: m.text, ...(s.senderId ? { from: s.senderId } : {}) });
      const body = await callJson<{ SMSMessageData?: { Recipients?: Array<{ messageId?: string; status?: string }> } }>("Africa's Talking", `https://${host}/version1/messaging`, {
        method: 'POST', body: form, headers: { apiKey: ctx.secret('apiKey')!, 'content-type': 'application/x-www-form-urlencoded' },
      });
      const recipient = body.SMSMessageData?.Recipients?.[0];
      if (!recipient || (recipient.status && recipient.status !== 'Success')) throw new Error(`Africa's Talking did not accept the message: ${recipient?.status ?? 'no recipient in the answer'}`);
      return { providerRef: recipient.messageId };
    },
  }),
});

registerProvider({
  kind: 'sms', key: 'twilio', label: 'Twilio',
  description: 'SMS through Twilio, from a Twilio number or a messaging service.',
  fields: z.strictObject({
    accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/, 'An account SID, starting AC'),
    from: z.string().trim().min(3).max(40),
  }),
  labels: { accountSid: 'Account SID', from: 'From number or messaging service' },
  hints: { from: 'A Twilio number such as +15551234567, or a messaging service SID starting MG' },
  secrets: [{ key: 'authToken', label: 'Auth token', required: true }],
  async test(ctx) {
    const s = ctx.settings as { accountSid: string };
    const body = await callJson<{ friendly_name?: string; status?: string }>('Twilio', `https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}.json`, { headers: { authorization: basicAuth(s.accountSid, ctx.secret('authToken')!) } });
    return { ok: body.status !== 'suspended', message: `Account "${body.friendly_name ?? s.accountSid}" is ${body.status ?? 'reachable'}.` };
  },
  open: (ctx) => ({
    async send(m) {
      const s = ctx.settings as { accountSid: string; from: string };
      const form = new URLSearchParams({ To: m.to, Body: m.text, ...(s.from.startsWith('MG') ? { MessagingServiceSid: s.from } : { From: s.from }) });
      const body = await callJson<{ sid?: string }>('Twilio', `https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`, {
        method: 'POST', body: form, headers: { authorization: basicAuth(s.accountSid, ctx.secret('authToken')!), 'content-type': 'application/x-www-form-urlencoded' },
      });
      return { providerRef: body.sid };
    },
  }),
});

/** Until Marichi Talks is connected (#10), WhatsApp goes to the in-app simulated phone. */
registerProvider({
  kind: 'whatsapp', key: 'simulated', label: 'Simulated (Marichi Talks)', simulated: true,
  description: 'Messages show on the in-app phone and in the outbox, marked Simulated. Marichi Talks replaces it once connected.',
  fields: z.strictObject({}), test: ready,
  open: () => ({ send: async (m) => keep('whatsapp', m) }),
});
