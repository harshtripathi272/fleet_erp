import { randomUUID } from 'node:crypto';

/**
 * SMS behind one interface. Each provider is an adapter registered here; an installation picks one in
 * its message connection (a setting, never code). Until the first client chooses a provider, only the
 * simulated adapter exists: it sends nothing and says so.
 *
 * Adding a provider (Africa's Talking, Twilio, ...) is one file that calls `registerSmsAdapter`.
 */
export interface SmsMessage { to: string; text: string }

/** What a connection gives its adapter. `secret` comes from the environment, never the database. */
export interface SmsConfig { account?: string; senderId?: string; secret?: string }

export interface SmsResult {
  /** The provider's id for the message, for tracing it in their console. */
  providerRef?: string;
  /** True when nothing was actually sent. */
  simulated: boolean;
}

export interface SmsAdapter {
  key: string;
  label: string;
  /** A simulated adapter never sends; its messages are marked Simulated in the outbox. */
  simulated: boolean;
  send(message: SmsMessage, config: SmsConfig): Promise<SmsResult>;
}

const adapters = new Map<string, SmsAdapter>();

export function registerSmsAdapter(adapter: SmsAdapter) {
  adapters.set(adapter.key, adapter);
}

export const getSmsAdapter = (key: string) => adapters.get(key);
export const smsAdapters = () => [...adapters.values()].map(({ key, label, simulated }) => ({ key, label, simulated }));

/** Messages the simulated adapter "sent", newest first, so tests and the console can show them. */
const simulatedSent: Array<SmsMessage & { at: string; providerRef: string }> = [];
export const simulatedSms = () => [...simulatedSent];

export const SIMULATED_SMS = 'simulated';

registerSmsAdapter({
  key: SIMULATED_SMS,
  label: 'Simulated (sends nothing)',
  simulated: true,
  async send(message) {
    const providerRef = `sim-${randomUUID()}`;
    simulatedSent.unshift({ ...message, at: new Date().toISOString(), providerRef });
    simulatedSent.length = Math.min(simulatedSent.length, 50);
    return { providerRef, simulated: true };
  },
});
