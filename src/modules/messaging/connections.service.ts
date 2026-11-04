import { env } from '../../config/env.js';
import { type MessageSender, type OutgoingMessage, providerFor, providersOf, scrub as scrubSecrets } from '../../core/connections/index.js';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { activeConnection, openConnection, using } from '../connections/connections.service.js';

/**
 * How each message channel sends, on top of connections (#59): its switched-on connection, else (e-mail)
 * the server's SMTP settings, else nothing (simulated, saying why).
 */
export const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?\d{7,15}$/;

/** Error text with the connection's secret values taken out, before it is stored or shown. */
export const scrub = (message: string, connection?: Plain) => scrubSecrets(message, connection as never);

/** How one message goes out: on a connection, the server's SMTP settings, or nowhere (simulated). */
export interface Sender {
  channel: Channel;
  connection?: Plain;
  /** Set when nothing will be sent, saying why. */
  simulated?: string;
  send?: (message: OutgoingMessage) => Promise<{ providerRef?: string; simulated?: boolean }>;
}

/**
 * Why nothing is sent, in words for the office. The server setting behind it goes to the log, once
 * per reason, for whoever runs the server.
 */
const REASON = {
  testSetup: 'This is a test setup: phone messages are simulated, not sent.',
  whatsapp: 'WhatsApp is not connected yet: messages are simulated, not sent.',
  noEmail: 'No e-mail connection is set up yet: e-mails are simulated, not sent.',
  noConnection: (channel: Channel) => `No ${CHANNEL_LABEL[channel]} connection is switched on: messages are simulated, not sent.`,
  noProvider: 'The service chosen for this connection is not available: messages are simulated, not sent.',
};
const logged = new Set<string>();
function simulatedBecause(reason: string, detail: Record<string, unknown>, why: string) {
  if (!logged.has(why)) { logged.add(why); logger.info(detail, why); }
  return reason;
}
const testSetup = () => simulatedBecause(REASON.testSetup, { setting: 'DRIVER_PHONE_SIMULATOR' }, 'Phone messages are simulated because DRIVER_PHONE_SIMULATOR is on');

/** The sender for a given connection, switched on or not (used by "send a test message"). */
export function senderOn(connection: Plain): Sender {
  const channel = connection.kind as Channel;
  if (channel !== 'email' && env.DRIVER_PHONE_SIMULATOR) return { channel, connection, simulated: testSetup() };
  const opened = openConnection<Channel>(connection);
  if (!opened) {
    const provider = String(connection.provider);
    return { channel, connection, simulated: simulatedBecause(REASON.noProvider, { channel, provider }, `Message provider "${provider}" is not registered in src/core/connections`) };
  }
  // Simulated WhatsApp is the in-app phone: nothing goes out, and the outbox says why.
  if (channel === 'whatsapp' && opened.provider.simulated) return { channel, connection, simulated: REASON.whatsapp };
  const sender = opened.capability as MessageSender;
  if (opened.provider.simulated) return { channel, connection, send: async (m) => ({ ...(await sender.send(m)), simulated: true }) };
  return { channel, connection, send: (m) => sender.send(m) };
}

/** The sender each channel uses now: its switched-on connection, else (e-mail) the server's SMTP settings, else simulated. */
export async function senderFor(channel: Channel): Promise<Sender> {
  const connection = await activeConnection(channel);
  if (connection) return senderOn(connection);
  if (channel === 'email') {
    const now = await using('email');
    if (now.via === 'server') return { channel, send: (m) => now.capability.send(m) };
    return { channel, simulated: simulatedBecause(REASON.noEmail, { setting: 'SMTP_HOST' }, 'E-mails are simulated: no e-mail connection is switched on and SMTP_HOST is not set') };
  }
  if (env.DRIVER_PHONE_SIMULATOR) return { channel, simulated: testSetup() };
  return { channel, simulated: REASON.noConnection(channel) };
}

/** Where each channel sends right now, and what it could use, for the messaging screen. */
export async function channelStatus() {
  return Promise.all(CHANNELS.map(async (channel) => {
    const sender = await senderFor(channel);
    const connection = sender.connection;
    return {
      channel, label: CHANNEL_LABEL[channel],
      via: connection ? 'connection' : sender.simulated ? 'simulated' : 'server-settings',
      connectionId: connection ? String(connection._id) : undefined,
      connectionName: connection?.name,
      provider: connection ? providerFor(channel, String(connection.provider))?.label : undefined,
      simulated: sender.simulated,
      providers: providersOf(channel).map((p) => ({ key: p.key, label: p.label, simulated: Boolean(p.simulated) })),
    };
  }));
}

export const isAddressFor = (channel: Channel, to: string) => (channel === 'email' ? EMAIL.test(to) : PHONE.test(to.replace(/[\s()-]/g, '')));
