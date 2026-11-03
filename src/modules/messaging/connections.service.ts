import { z } from 'zod';
import { env } from '../../config/env.js';
import { ValidationError } from '../../core/errors/index.js';
import { type MailMessage, sendOverSmtp, serverSmtp, type SmtpSettings } from '../../core/mail/mailer.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import type { Plain } from '../../core/masters/types.js';
import { baseShape, code, integer, name, text, toUpdateSchema } from '../../core/masters/zod.js';
import { getSmsAdapter } from '../../core/sms/index.js';
import { MessageConnection, providersFor, SECRET_ENV } from './models/connection.model.js';

export const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' };

export const connectionShape = {
  code, name, description: text(500).optional(),
  channel: z.enum(CHANNELS),
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/, 'A provider key, e.g. smtp or simulated'),
  enabled: z.boolean().optional(),
  host: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, 'A host name, e.g. smtp.gmail.com').optional(),
  port: integer(1, 65535).optional(),
  secure: z.boolean().optional(),
  user: text(200).optional(),
  from: text(200).optional(),
  senderId: text(20).optional(),
  secretEnv: z.string().trim().regex(SECRET_ENV, 'SMTP_PASS, or a name starting with MESSAGING_, e.g. MESSAGING_SMTP_PASS').optional(),
  ...baseShape,
};
export const createConnectionSchema = z.strictObject(connectionShape);
export const updateConnectionSchema = toUpdateSchema(connectionShape);
export const testConnectionSchema = z.strictObject({ to: z.string().trim().min(3).max(254) });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?\d{7,15}$/;
const FIELDS_BY_CHANNEL: Record<Channel, string[]> = {
  email: ['host', 'port', 'secure', 'user', 'from', 'secretEnv'],
  sms: ['user', 'senderId', 'secretEnv'],
  whatsapp: [],
};

/** The value behind `secretEnv`, read from the environment at send time. Never stored, never returned. */
function secretOf(connection: Plain): string | undefined {
  const key = connection.secretEnv as string | undefined;
  if (!key) return undefined;
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set on the server`);
  return value;
}

/** Error text with any secret value taken out, before it is stored or shown. */
export function scrub(message: string, connection?: Plain): string {
  let out = message.slice(0, 500);
  const key = connection?.secretEnv as string | undefined;
  const value = key ? process.env[key] : undefined;
  if (value && value.length >= 4) out = out.split(value).join('[hidden]');
  return out;
}

export const connectionDefinition = defineMaster({
  key: 'message-connections', label: 'Message connections', singular: 'Message connection', group: GROUPS.messaging,
  description: 'How this installation sends each channel: an SMTP server for e-mail, an SMS provider, WhatsApp. One switched on per channel. Passwords and keys stay in server settings; a connection names the setting that holds it.',
  model: MessageConnection, createSchema: createConnectionSchema, updateSchema: updateConnectionSchema,
  searchFields: ['code', 'name', 'channel', 'provider', 'host'],
  columns: ['name', 'channel', 'provider', 'enabled'],
  filters: {
    channel: { schema: z.enum(CHANNELS), apply: (v: string) => ({ channel: v }), description: 'Channel' },
    enabled: { schema: z.enum(['true', 'false']), apply: (v: string) => ({ enabled: v === 'true' }), description: 'Switched on' },
  },
  async prepare(data: Plain) {
    const channel = data.channel as Channel;
    const errors: Record<string, string[]> = {};
    const add = (key: string, message: string) => { (errors[key] ??= []).push(message); };
    const providers = providersFor(channel);
    if (!providers.includes(String(data.provider))) add('provider', `For ${CHANNEL_LABEL[channel]}, use ${providers.join(' or ')}`);
    for (const key of ['host', 'port', 'secure', 'user', 'from', 'senderId', 'secretEnv']) {
      if (data[key] !== undefined && !FIELDS_BY_CHANNEL[channel].includes(key)) add(key, `Not used for ${CHANNEL_LABEL[channel]}`);
    }
    if (channel === 'email') {
      if (!data.host) add('host', 'The SMTP server, e.g. smtp.gmail.com');
      if (!data.from) add('from', 'The From address, e.g. Marichi Fleet <fleet@company.com>');
      if (data.user && !data.secretEnv) add('secretEnv', 'Name the server setting that holds the SMTP password');
    }
    if (Object.keys(errors).length) throw new ValidationError('Connection is not valid', errors);
    return data;
  },
  /** What the screen needs to know about the secret: its setting's name and whether the server has it. */
  present: (doc: Plain) => ({ secretSet: doc.secretEnv ? Boolean(process.env[String(doc.secretEnv)]) : undefined }),
});

/** How one message goes out: on a connection, the server's SMTP settings, or nowhere (simulated). */
export interface Sender {
  channel: Channel;
  connection?: Plain;
  /** Set when nothing will be sent, saying why. */
  simulated?: string;
  send?: (message: { to: string; subject?: string; text: string; attachments?: MailMessage['attachments'] }) => Promise<{ providerRef?: string; simulated?: boolean }>;
}

const smtpFrom = (connection: Plain): SmtpSettings => ({
  host: String(connection.host), port: Number(connection.port ?? 587), secure: Boolean(connection.secure),
  user: connection.user as string | undefined, pass: secretOf(connection), from: String(connection.from),
});

/** The sender for a given connection, switched on or not (used by "send a test message"). */
export function senderOn(connection: Plain): Sender {
  const channel = connection.channel as Channel;
  if (channel !== 'email' && env.DRIVER_PHONE_SIMULATOR) return { channel, connection, simulated: 'Simulators are on (DRIVER_PHONE_SIMULATOR), so phones get nothing' };
  if (channel === 'email') {
    return { channel, connection, send: (m) => sendOverSmtp(smtpFrom(connection), { to: m.to, subject: m.subject ?? '', text: m.text, attachments: m.attachments }) };
  }
  if (channel === 'whatsapp') return { channel, connection, simulated: 'WhatsApp goes to the simulator until Marichi Talks is connected (#10)' };
  const adapter = getSmsAdapter(String(connection.provider));
  if (!adapter) return { channel, connection, simulated: `SMS provider "${String(connection.provider)}" is not available on this server` };
  if (adapter.simulated) return { channel, connection, send: async (m) => ({ ...(await adapter.send({ to: m.to, text: m.text }, {})), simulated: true }) };
  return {
    channel, connection,
    send: (m) => adapter.send({ to: m.to, text: m.text }, { account: connection.user as string | undefined, senderId: connection.senderId as string | undefined, secret: secretOf(connection) }),
  };
}

/** The sender each channel uses now: its switched-on connection, else (e-mail) the server's SMTP settings, else simulated. */
export async function senderFor(channel: Channel): Promise<Sender> {
  const connection = await MessageConnection.findOne({ channel, enabled: true, status: 'active' }).lean() as Plain | null;
  if (connection) return senderOn(connection);
  if (channel === 'email') {
    const smtp = serverSmtp();
    if (smtp) return { channel, send: (m) => sendOverSmtp(smtp, { to: m.to, subject: m.subject ?? '', text: m.text, attachments: m.attachments }) };
    return { channel, simulated: 'No e-mail connection, and the server has no SMTP settings' };
  }
  if (env.DRIVER_PHONE_SIMULATOR) return { channel, simulated: 'Simulators are on (DRIVER_PHONE_SIMULATOR), so phones get nothing' };
  return { channel, simulated: `No ${CHANNEL_LABEL[channel]} connection is switched on` };
}

/** Where each channel sends right now, for the settings screen. */
export async function channelStatus() {
  return Promise.all(CHANNELS.map(async (channel) => {
    const sender = await senderFor(channel);
    const connection = sender.connection;
    return {
      channel, label: CHANNEL_LABEL[channel],
      via: connection ? 'connection' : sender.simulated ? 'simulated' : 'server-settings',
      connectionId: connection ? String(connection._id) : undefined,
      connectionName: connection?.name,
      simulated: sender.simulated,
    };
  }));
}

export const isAddressFor = (channel: Channel, to: string) => (channel === 'email' ? EMAIL.test(to) : PHONE.test(to.replace(/[\s()-]/g, '')));
