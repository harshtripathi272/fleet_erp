import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger/index.js';

export interface MailAttachment { filename: string; content: Buffer; contentType?: string }
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  /** What the message is about (for the outbox). Account e-mails leave it unset. */
  event?: string;
  /**
   * Holds a one-time link or anything else nobody else should read. Its text is never kept in the
   * outbox, and it is never resent. Account e-mails (resets, invitations) count as sensitive.
   */
  sensitive?: boolean;
}
export interface SentMail extends MailMessage { at: string; delivered: boolean; }

/** An SMTP server: the installation's own (SMTP_* settings) or one from a message connection. */
export interface SmtpSettings { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }

type TransportFactory = (settings: SmtpSettings) => Pick<Transporter, 'sendMail'>;
const nodemailerFactory: TransportFactory = (s) => nodemailer.createTransport({
  host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined,
});
let factory: TransportFactory = nodemailerFactory;
const transports = new Map<string, Pick<Transporter, 'sendMail'>>();

/** Lets tests stand in for an SMTP server. */
export function setSmtpTransportFactory(next: TransportFactory | null) {
  factory = next ?? nodemailerFactory;
  transports.clear();
}

/** The installation's SMTP server from its settings, or null when none is set. */
export function serverSmtp(): SmtpSettings | null {
  if (!env.SMTP_HOST) return null;
  return { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM };
}

/**
 * The name e-mails come from (#71): the company's brand, supplied by the company module so this core does not
 * depend on it. The address stays the configured one; only the name people see changes.
 */
let senderName: () => Promise<string | undefined> = async () => undefined;
export const setSenderName = (fn: () => Promise<string | undefined>) => { senderName = fn; };
const withName = (from: string, name: string) => `"${name.replace(/["\\]/g, '')}" <${(from.match(/<([^>]+)>/)?.[1] ?? from).trim()}>`;

/** Sends one message over the given SMTP server. Throws when the server refuses it. */
export async function sendOverSmtp(settings: SmtpSettings, message: MailMessage): Promise<{ providerRef?: string }> {
  const key = JSON.stringify([settings.host, settings.port, settings.secure, settings.user, settings.pass]);
  let transport = transports.get(key);
  if (!transport) { transport = factory(settings); transports.set(key, transport); }
  const name = await senderName().catch(() => undefined);
  const info = await transport.sendMail({
    from: name ? withName(settings.from, name) : settings.from, to: message.to, subject: message.subject, text: message.text, html: message.html, attachments: message.attachments,
  }) as { messageId?: string } | undefined;
  return { providerRef: info?.messageId };
}

/**
 * Where e-mail goes once the messaging area is loaded: its dispatcher picks the configured e-mail
 * connection and records the message in the outbox. Returns true when the message was sent.
 */
type MailRoute = (message: MailMessage) => Promise<boolean>;
let route: MailRoute | null = null;
export function routeMail(next: MailRoute | null) { route = next; }

const outbox: SentMail[] = [];

/** Sends an e-mail: through the messaging dispatcher when it is loaded, else over the server's SMTP settings. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  let delivered = false;
  if (route) {
    delivered = await route(message);
  } else {
    const smtp = serverSmtp();
    if (smtp) {
      try {
        await sendOverSmtp(smtp, message);
        delivered = true;
      } catch (err) {
        logger.error({ err, to: message.to, subject: message.subject }, 'E-mail delivery failed');
      }
    } else {
      logger.warn({ to: message.to, subject: message.subject }, 'SMTP not configured; e-mail not sent');
    }
  }
  if (env.NODE_ENV !== 'production') {
    outbox.unshift({ ...message, at: new Date().toISOString(), delivered });
    outbox.length = Math.min(outbox.length, 20);
  }
  return delivered;
}

/** Recent messages, kept outside production only so the test console can show them. */
export function recentMail(): SentMail[] { return [...outbox]; }
export function clearMail() { outbox.length = 0; }
