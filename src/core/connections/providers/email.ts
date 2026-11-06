import { z } from 'zod';
import { registerProvider } from '../registry.js';
import type { OutgoingMessage, ProviderContext } from '../types.js';
import { basicAuth, callJson, CALL_TIMEOUT_MS } from './http.js';

/*
 * E-mail through a sending service's HTTP API (#98): SendGrid, Resend and Mailgun, with no library. Each
 * needs a sending domain verified with the service and an API key in a server setting.
 */

const from = z.string().trim().min(3).max(200);
const fromHint = 'An address on the domain verified with the service, e.g. Acme Haulage <fleet@company.com>';

/** "Acme <fleet@acme.example>" → its name and address. */
export function splitAddress(value: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m ? { ...(m[1] ? { name: m[1].replace(/^"|"$/g, '') } : {}), email: m[2]!.trim() } : { email: value.trim() };
}

const attachmentsOf = (m: OutgoingMessage) => (m.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content.toString('base64'), type: a.contentType ?? 'application/octet-stream' }));
const sendSettled = async () => ({ ok: true, message: 'Settings are complete. Send a test e-mail to check it arrives.' });

/** SendGrid answers 202 with no body; the message id is a header. */
async function sendGrid(ctx: ProviderContext, m: OutgoingMessage) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { authorization: `Bearer ${ctx.secret('apiKey')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: m.to }] }],
      from: splitAddress(String(ctx.settings.from)),
      subject: m.subject ?? '',
      content: [{ type: 'text/plain', value: m.text }],
      ...(m.attachments?.length ? { attachments: attachmentsOf(m).map((a) => ({ ...a, disposition: 'attachment' })) } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { errors?: Array<{ message?: string }> };
    throw new Error(`SendGrid answered ${res.status}: ${body.errors?.map((e) => e.message).join('; ') || res.statusText}`);
  }
  return { providerRef: res.headers.get('x-message-id') ?? undefined };
}

registerProvider({
  kind: 'email', key: 'sendgrid', label: 'SendGrid',
  description: 'E-mail through SendGrid (Twilio). Needs a sender or domain verified in SendGrid.',
  fields: z.strictObject({ from }),
  labels: { from: 'From address' },
  hints: { from: fromHint },
  secrets: [{ key: 'apiKey', label: 'API key', required: true }],
  guide: [
    { text: 'Sign in to SendGrid and verify the sending domain (Settings → Sender Authentication → Authenticate your domain), or a single sender address to start.', link: 'https://app.sendgrid.com/settings/sender_auth' },
    { text: 'Make an API key with "Mail Send" access (Settings → API Keys → Create API Key → Restricted access → Mail Send: Full). It is shown once.', link: 'https://app.sendgrid.com/settings/api_keys' },
    { text: 'Put the key in the server setting below, restart, then send a test e-mail.' },
  ],
  async test(ctx) {
    const body = await callJson<{ scopes?: string[] }>('SendGrid', 'https://api.sendgrid.com/v3/scopes', { headers: { authorization: `Bearer ${ctx.secret('apiKey')}` } });
    const canSend = body.scopes?.includes('mail.send');
    return { ok: Boolean(canSend), message: canSend ? 'The key works and may send mail. Send a test e-mail to check it arrives.' : 'The key works but has no "Mail Send" access: give it that, or make a new one.' };
  },
  open: (ctx) => ({ send: (m) => sendGrid(ctx, m) }),
});

registerProvider({
  kind: 'email', key: 'resend', label: 'Resend',
  description: 'E-mail through Resend. Needs a domain verified in Resend.',
  fields: z.strictObject({ from }),
  labels: { from: 'From address' },
  hints: { from: fromHint },
  secrets: [{ key: 'apiKey', label: 'API key', required: true }],
  guide: [
    { text: 'Sign in to Resend and add the sending domain (Domains → Add domain), then add the DNS records it shows until it says Verified.', link: 'https://resend.com/domains' },
    { text: 'Make an API key with "Sending access" (API Keys → Create API key). It is shown once and starts re_.', link: 'https://resend.com/api-keys' },
    { text: 'Put the key in the server setting below, restart, then send a test e-mail.' },
  ],
  test: sendSettled,
  open: (ctx) => ({
    async send(m) {
      const body = await callJson<{ id?: string }>('Resend', 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.secret('apiKey')}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: ctx.settings.from, to: [m.to], subject: m.subject ?? '', text: m.text,
          ...(m.attachments?.length ? { attachments: attachmentsOf(m).map((a) => ({ filename: a.filename, content: a.content })) } : {}),
        }),
      });
      return { providerRef: body.id };
    },
  }),
});

const mailgunHost = (s: Record<string, unknown>) => (s.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net');

registerProvider({
  kind: 'email', key: 'mailgun', label: 'Mailgun',
  description: 'E-mail through Mailgun, from a domain set up in Mailgun.',
  fields: z.strictObject({
    domain: z.string().trim().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/i, 'The sending domain, e.g. mg.company.com'),
    region: z.enum(['us', 'eu']).default('us'),
    from,
  }),
  labels: { domain: 'Sending domain', region: 'Region', 'region.us': 'United States', 'region.eu': 'Europe', from: 'From address' },
  hints: { domain: 'As listed in Mailgun under Sending → Domains', from: fromHint },
  secrets: [{ key: 'apiKey', label: 'API key', required: true }],
  guide: [
    { text: 'Sign in to Mailgun and add the sending domain (Sending → Domains → Add new domain); add the DNS records it shows until it is verified. Note whether the account is in the US or the EU region.', link: 'https://app.mailgun.com/mg/sending/domains' },
    { text: 'Make a sending key for that domain (Sending → Domain settings → Sending keys), or use the account\'s private API key (API Security).', link: 'https://app.mailgun.com/settings/api_security' },
    { text: 'Put the key in the server setting below, restart, then send a test e-mail.' },
  ],
  async test(ctx) {
    const s = ctx.settings as { domain: string };
    const body = await callJson<{ domain?: { state?: string } }>('Mailgun', `${mailgunHost(ctx.settings)}/v3/domains/${encodeURIComponent(s.domain)}`, { headers: { authorization: basicAuth('api', ctx.secret('apiKey')!) } });
    const state = body.domain?.state ?? 'unknown';
    return { ok: state === 'active', message: state === 'active' ? `${s.domain} is active. Send a test e-mail to check it arrives.` : `${s.domain} is ${state} in Mailgun: finish its DNS records first.` };
  },
  open: (ctx) => ({
    async send(m) {
      const s = ctx.settings as { domain: string; from: string };
      const form = new FormData();
      form.set('from', s.from);
      form.set('to', m.to);
      form.set('subject', m.subject ?? '');
      form.set('text', m.text);
      for (const a of m.attachments ?? []) form.append('attachment', new Blob([new Uint8Array(a.content)], { type: a.contentType ?? 'application/octet-stream' }), a.filename);
      const body = await callJson<{ id?: string }>('Mailgun', `${mailgunHost(ctx.settings)}/v3/${encodeURIComponent(s.domain)}/messages`, { method: 'POST', body: form, headers: { authorization: basicAuth('api', ctx.secret('apiKey')!) } });
      return { providerRef: body.id };
    },
  }),
});
