import type { Readable } from 'node:stream';
import type { z } from 'zod';

/**
 * Every outside service this installation can talk to, by kind (#55, pattern 2). A kind is what the system
 * needs (send an e-mail, fetch today's rates, store a file); a provider is one service that does it.
 */
export const KINDS = ['email', 'sms', 'whatsapp', 'gps', 'rates', 'routing', 'storage', 'accounting', 'fuel-cards', 'payouts'] as const;
export type Kind = (typeof KINDS)[number];

/** What each kind does, in words for the Connections screen, and what happens while nothing is connected. */
export const KIND_INFO: Record<Kind, { label: string; description: string; whenNone: string }> = {
  email: { label: 'E-mail', description: 'Trip, money and account e-mails.', whenNone: "The server's own SMTP settings, if it has them; otherwise e-mails are simulated." },
  sms: { label: 'SMS', description: 'Text messages to drivers and staff.', whenNone: 'Simulated: messages are kept in the outbox, not sent.' },
  whatsapp: { label: 'WhatsApp', description: 'WhatsApp messages and the replies to them.', whenNone: 'Simulated: messages show on the in-app phone, not sent.' },
  gps: { label: 'GPS trackers', description: "Trucks' positions from their trackers.", whenNone: 'Simulated: positions come from the drive simulator.' },
  rates: { label: 'Exchange rates', description: "The daily exchange-rate feed for the company's currencies.", whenNone: 'No feed: rates are typed in by hand.' },
  routing: { label: 'Map routing', description: 'Road distances, driving times and the lines drawn on maps.', whenNone: "Straight line × the company's road distance factor." },
  storage: { label: 'File storage', description: 'Where uploaded documents and printouts are kept.', whenNone: "The server's own storage setting (FILE_STORAGE)." },
  accounting: { label: 'Accounting export', description: 'Invoices, payments and settlements for the accounting system.', whenNone: 'Simulated: exports are built but not sent anywhere.' },
  'fuel-cards': { label: 'Fuel cards', description: 'Fuel bought on company cards, for matching to trips.', whenNone: 'Simulated: sample card transactions.' },
  payouts: { label: 'Mobile-money payouts', description: 'Advances and settlements paid to drivers by mobile money.', whenNone: 'Simulated: payouts are recorded, not paid.' },
};

/** What a provider is given for one connection: its settings, and its secrets read from the server. */
export interface ProviderContext {
  /** The connection's settings, already checked against the provider's fields. */
  settings: Record<string, unknown>;
  /** A secret's value from the environment. Throws, naming the variable, when a required one is not set. */
  secret(key: string): string | undefined;
  /** The connection's id, when there is one (not for the server defaults). */
  connectionId?: string;
}

export interface TestResult { ok: boolean; message: string }

/* What each kind can do. A provider of a kind supplies its kind's capability. */
export interface OutgoingMessage { to: string; subject?: string; text: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string }> }
export interface MessageSender { send(message: OutgoingMessage): Promise<{ providerRef?: string; simulated?: boolean }> }
export interface RateSource { fetch(input: { base: string; codes: string[]; signal?: AbortSignal }): Promise<{ perBase: Record<string, number>; asOf: Date }> }
export interface LatLng { lat: number; lng: number }
export interface RouteAnswer { km: number; hours?: number; shape: Array<[number, number]> }
export interface RouteFinder { route(points: LatLng[], signal?: AbortSignal): Promise<RouteAnswer> }
export interface FileStore {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}
export interface StorageBackend { store(): Promise<FileStore> }
export interface Position { deviceId: string; lat: number; lng: number; at: Date; speedKmh?: number; heading?: number }
export interface PositionSource { positions(signal?: AbortSignal): Promise<Position[]> }
export interface ExportFile { name: string; mime: string; body: Buffer }
export interface AccountingExport { export(input: { name: string; columns: string[]; rows: Array<Record<string, unknown>> }): Promise<ExportFile & { sent: boolean }> }
export interface FuelCardTransaction { cardNumber: string; at: Date; litres: number; amountMinor: number; currency: string; station?: string; reference: string }
export interface FuelCardSource { transactions(since: Date, signal?: AbortSignal): Promise<FuelCardTransaction[]> }
export interface PayoutSender { pay(input: { to: string; amountMinor: number; currency: string; reference: string }): Promise<{ providerRef: string; simulated: boolean }> }

export interface Capabilities {
  email: MessageSender;
  sms: MessageSender;
  whatsapp: MessageSender;
  gps: PositionSource;
  rates: RateSource;
  routing: RouteFinder;
  storage: StorageBackend;
  accounting: AccountingExport;
  'fuel-cards': FuelCardSource;
  payouts: PayoutSender;
}

/** A secret a provider needs: stored as the name of a server environment variable, never its value. */
export interface SecretSpec { key: string; label: string; required: boolean; hint?: string }

/** A message someone sent us through a service (a WhatsApp reply): from whom, and what. */
export interface InboundMessage { from: string; text?: string; at: Date; providerRef?: string; kind?: 'text' | 'button' | 'photo' | 'other' }

/** What a call to a connection's webhook brought in, for whoever listens to that kind (#60 for trackers). */
export interface InboundResult { accepted: number; positions?: Position[]; messages?: InboundMessage[]; note?: string }

/**
 * One step of a provider's guide (#98): how to get a value, with a link to the page that has it. `{webhookUrl}`
 * in the text stands for the connection's own address, filled in on screen.
 */
export interface GuideStep { text: string; link?: string }

/** A call to the webhook, for providers that check it their own way (Meta's or Twilio's signature, not ours). */
export interface InboundCall { headers: Record<string, string | undefined>; raw: Buffer; url: string }

/**
 * One provider: one file in core/connections/providers. Adding a service is a new file plus a test; the
 * Connections screen draws its form from `fields`, with `labels` and `hints`, and lists it under its kind.
 */
export interface Provider<K extends Kind = Kind> {
  key: string;
  kind: K;
  label: string;
  /** Shown under the provider's name: what it is and what to have ready. */
  description?: string;
  /**
   * A stand-in that reaches no outside service. Always labelled Simulated on screen. Every kind has one,
   * except storage: a simulated store would lose files, so storage falls back to the server's own.
   */
  simulated?: boolean;
  /** The provider's settings. Not secret: hosts, account names, bucket names. */
  fields: z.ZodObject;
  labels?: Record<string, string>;
  hints?: Record<string, string>;
  secrets?: SecretSpec[];
  /** What "Test connection" checks. Message kinds send a test message through the dispatcher instead. */
  test(ctx: ProviderContext): Promise<TestResult>;
  open(ctx: ProviderContext): Capabilities[K];
  /** For services that push to us (trackers, message replies): reads one signed call's body. */
  inbound?(ctx: ProviderContext, body: unknown): Promise<InboundResult>;
  /**
   * For services that sign their calls themselves: says why a call is refused, or nothing when it's genuine.
   * Such a provider needs no signing secret of ours. `inbound` then gets the body as the service sent it.
   */
  verifyInbound?(ctx: ProviderContext, call: InboundCall): string | undefined;
  /** For services that check the address before using it (Meta's GET with hub.challenge): the answer to send back. */
  handshake?(ctx: ProviderContext, query: Record<string, string | undefined>): string;
  /** Numbered steps to get each value, with links: shown beside the form and in the guided set-up. */
  guide?: GuideStep[];
  /** Listed so people know it is coming, but it can't be set up yet: says why. */
  comingSoon?: string;
}
