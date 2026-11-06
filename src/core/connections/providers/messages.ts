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

/**
 * Where each common mail service's SMTP server is, so choosing one fills the host, port and security, and
 * its guide says where to get the password. "Other" is any server: its host is typed.
 */
export const SMTP_PRESETS = {
  google: { label: 'Google Workspace or Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
  microsoft: { label: 'Microsoft 365 or Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  ses: { label: 'Amazon SES', host: 'email-smtp.{region}.amazonaws.com', port: 587, secure: false },
  zoho: { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 587, secure: false },
  other: { label: 'Another server', host: '', port: 587, secure: false },
} as const;
export type SmtpPreset = keyof typeof SMTP_PRESETS;

interface SmtpFields { preset?: SmtpPreset; host?: string; port?: number; secure?: boolean; region?: string; user?: string; from: string }
/** The server to use: the preset's, with any host, port or security typed over it. */
export function smtpServer(s: SmtpFields) {
  const preset = SMTP_PRESETS[s.preset ?? 'other'];
  return {
    host: s.host || preset.host.replace('{region}', s.region ?? 'eu-west-1'),
    port: s.port ?? preset.port,
    secure: s.secure ?? preset.secure,
  };
}

registerProvider({
  kind: 'email', key: 'smtp', label: 'SMTP server',
  description: 'A mail account the company already has: Google Workspace, Microsoft 365, Amazon SES, Zoho or any other server.',
  fields: z.strictObject({
    preset: z.enum(Object.keys(SMTP_PRESETS) as [SmtpPreset, ...SmtpPreset[]]).default('other'),
    host: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, 'A host name, e.g. smtp.gmail.com').optional(),
    region: z.string().trim().regex(/^[a-z]{2}-[a-z]+-\d$/, 'An AWS region, e.g. eu-west-1').optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().trim().max(200).optional(),
    from: z.string().trim().min(3).max(200),
  }).superRefine((s, ctx) => {
    if (s.preset === 'other' && !s.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'The SMTP server, e.g. smtp.company.com' });
    if (s.preset === 'ses' && !s.region) ctx.addIssue({ code: 'custom', path: ['region'], message: 'The AWS region the SES account is in, e.g. eu-west-1' });
    if (s.preset && s.preset !== 'other' && !s.user) ctx.addIssue({ code: 'custom', path: ['user'], message: 'The account that signs in: an e-mail address, or the SES SMTP user name' });
  }),
  labels: {
    preset: 'Mail service', host: 'SMTP server', region: 'AWS region', secure: 'Encrypted from the start (port 465)', user: 'User name', from: 'From address',
    ...Object.fromEntries(Object.entries(SMTP_PRESETS).map(([k, v]) => [`preset.${k}`, v.label])),
  },
  hints: {
    host: 'Only for "Another server"; the others fill it in', region: 'Only for Amazon SES', from: 'e.g. Acme Haulage <fleet@company.com>',
    port: '587 for most servers, 465 when encrypted from the start', user: 'Usually the mailbox address; for SES, the SMTP user name',
  },
  secrets: [{ key: 'password', label: 'Password', required: false, hint: "The app password or SMTP password, not the account's own where an app password exists" }],
  guide: [
    { text: 'Choose the mail service the company uses. Use a mailbox made for the app, such as fleet@company.com.' },
    { text: 'Google Workspace or Gmail: switch on 2-Step Verification for that mailbox, then make an app password and keep it for the password setting.', link: 'https://myaccount.google.com/apppasswords' },
    { text: "Microsoft 365: an administrator switches on Authenticated SMTP for that mailbox (admin center → Users → the mailbox → Mail → Manage email apps). The password is the mailbox's, or an app password when multi-factor sign-in is on.", link: 'https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission' },
    { text: 'Amazon SES: verify the sending domain, then make SMTP credentials (SES console → SMTP settings → Create SMTP credentials). Use the user name and password it shows, not your AWS keys.', link: 'https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html' },
    { text: 'Zoho Mail: make an app-specific password (Zoho Accounts → Security → App passwords). Accounts in the EU use smtp.zoho.eu: choose "Another server" and type it.', link: 'https://accounts.zoho.com/home#security/app_password' },
    { text: 'Put the password in the server setting shown below, restart, then test: a test e-mail goes to the address you give.' },
  ],
  test: ready,
  open: (ctx) => ({
    async send(m) {
      const s = ctx.settings as unknown as SmtpFields;
      return sendOverSmtp({ ...smtpServer(s), user: s.user, pass: s.user ? ctx.secret('password') : undefined, from: s.from }, { to: m.to, subject: m.subject ?? '', text: m.text, attachments: m.attachments });
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
  guide: [
    { text: "Sign up at Africa's Talking and open your team's app, or the sandbox to try it first.", link: 'https://account.africastalking.com/' },
    { text: "Account user name: the app's user name, on its dashboard. For the sandbox it is sandbox." },
    { text: 'API key: Settings → API Key → generate one. It is shown once: keep it for the server setting below.' },
    { text: 'Sender name: request an alphanumeric sender ID (SMS → Sender IDs) or a short code. Left empty, the default sender is used.' },
    { text: 'Top up the account, put the key in the server setting below, restart, then send a test SMS.' },
  ],
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

/** The first steps of every Twilio guide: the account SID and auth token. */
export const TWILIO_GUIDE_START = [
  { text: 'Sign in to the Twilio Console. On its home page, under Account info, copy the Account SID (AC…).', link: 'https://console.twilio.com/' },
  { text: 'Auth token: next to it (click to show). Keep it for the server setting below; never paste it into the app.' },
];

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
  guide: [
    ...TWILIO_GUIDE_START,
    { text: "From number: buy a number that can send SMS to your drivers' country (Phone Numbers → Buy a number), or make a messaging service and use its SID (MG…).", link: 'https://console.twilio.com/us1/develop/phone-numbers/manage/search' },
    { text: 'Put the auth token in the server setting below, restart, then send a test SMS.' },
  ],
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

/** Until a WhatsApp service is connected, WhatsApp goes to the in-app simulated phone. */
registerProvider({
  kind: 'whatsapp', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Messages show on the in-app phone and in the outbox, marked Simulated, and nothing is sent.',
  fields: z.strictObject({}), test: ready,
  open: () => ({ send: async (m) => keep('whatsapp', m) }),
});
