import { logger } from '../../core/logger/index.js';
import { deliverWhatsApp } from '../messaging/whatsapp/service.js';
import type { WaUse } from '../messaging/whatsapp/templates.js';

/**
 * Outbound WhatsApp from the desks: a driver's or customer's thread, an approver's buttons. Through the
 * company's WhatsApp connection when it has a real one (#112: Meta or Twilio, with each message's template);
 * otherwise only logged, as the simulated phone shows them.
 */
export interface OutboundWhatsApp {
  to: string;
  text: string;
  title?: string;
  buttons?: string[];
  /** One-time answer tokens, one per button, returned by the webhook when tapped. */
  tokens?: string[];
  /** The message's WhatsApp template and its values, for after the 24 hours. */
  use?: WaUse;
}

export interface Delivery { channel: 'whatsapp'; to: string; status: 'logged' | 'sent' | 'failed'; providerRef?: string; error?: string }

let deliver = async (message: OutboundWhatsApp): Promise<Delivery> => {
  const sent = await deliverWhatsApp({ to: message.to, title: message.title, text: message.text, buttons: message.buttons, use: message.use });
  if (sent) return { channel: 'whatsapp', to: message.to, status: sent.status, providerRef: sent.status === 'sent' ? sent.providerRef : undefined, error: sent.status === 'failed' ? sent.error : undefined };
  logger.info({ to: message.to, title: message.title, buttons: message.buttons }, 'WhatsApp message logged (no WhatsApp connection)');
  return { channel: 'whatsapp', to: message.to, status: 'logged' };
};

/** Lets tests (and later the real client) replace the transport. */
export const setWhatsAppTransport = (fn: typeof deliver) => { deliver = fn; };

export async function sendWhatsApp(message: OutboundWhatsApp): Promise<Delivery> {
  try {
    return await deliver(message);
  } catch (err) {
    logger.error({ err, to: message.to }, 'WhatsApp delivery failed');
    return { channel: 'whatsapp', to: message.to, status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
