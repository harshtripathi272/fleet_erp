import { logger } from '../../core/logger/index.js';

/**
 * Outbound WhatsApp through Marichi Talks, the parent company's messaging service. Its API details and
 * credentials are not known yet, so messages are only logged. Replacing `deliver` is the only change
 * needed when they arrive.
 */
export interface OutboundWhatsApp {
  to: string;
  text: string;
  title?: string;
  buttons?: string[];
}

export interface Delivery { channel: 'whatsapp'; to: string; status: 'logged' | 'sent' | 'failed'; providerRef?: string; error?: string }

let deliver = async (message: OutboundWhatsApp): Promise<Delivery> => {
  logger.info({ to: message.to, title: message.title, buttons: message.buttons }, 'WhatsApp message logged (Marichi Talks not configured)');
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
