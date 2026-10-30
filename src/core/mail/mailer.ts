import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger/index.js';

export interface MailMessage { to: string; subject: string; text: string; html?: string; }
export interface SentMail extends MailMessage { at: string; delivered: boolean; }

let transporter: Transporter | null = null;
const outbox: SentMail[] = [];

function transport(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

/** Sends through the configured SMTP credentials; without SMTP the message is only logged. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const smtp = transport();
  let delivered = false;
  if (smtp) {
    try {
      await smtp.sendMail({ from: env.SMTP_FROM, ...message });
      delivered = true;
    } catch (err) {
      logger.error({ err, to: message.to, subject: message.subject }, 'E-mail delivery failed');
    }
  } else {
    logger.warn({ to: message.to, subject: message.subject }, 'SMTP not configured; e-mail not sent');
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
