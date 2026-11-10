import type { Readable } from 'node:stream';
import type { z } from 'zod';

/**
 * Every outside service this installation can talk to, by kind (#55, pattern 2). A kind is what the system
 * needs (send an e-mail, fetch today's rates, store a file); a provider is one service that does it.
 */
export const KINDS = ['email', 'sms', 'whatsapp', 'gps', 'fleet-exchange', 'rates', 'routing', 'storage', 'accounting', 'fuel-cards', 'payouts'] as const;
export type Kind = (typeof KINDS)[number];

/** What each kind does, in words for the Connections screen, and what happens while nothing is connected. */
export const KIND_INFO: Record<Kind, { label: string; description: string; whenNone: string }> = {
  email: { label: 'E-mail', description: 'Trip, money and account e-mails.', whenNone: "The server's own SMTP settings, if it has them; otherwise e-mails are simulated." },
  sms: { label: 'SMS', description: 'Text messages to drivers and staff.', whenNone: 'Simulated: messages are kept in the outbox, not sent.' },
  whatsapp: { label: 'WhatsApp', description: 'WhatsApp messages and the replies to them.', whenNone: 'Simulated: messages show on the in-app phone, not sent.' },
  gps: { label: 'GPS trackers', description: "Trucks' positions from their trackers.", whenNone: 'Simulated: positions come from the drive simulator.' },
  'fleet-exchange': { label: 'Fleet data exchange', description: 'Send trips, trucks and places to a GPS or fleet-analytics platform; take back positions and geofence events.', whenNone: 'Simulated: nothing leaves this server; the simulated partner keeps what would have been sent.' },
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
/**
 * How a WhatsApp message goes out (#112), worked out by the messaging module: as written with reply buttons
 * (inside the 24 hours), or as an approved template with its values. `needed` names the template to get
 * approved, for the outbox when WhatsApp refuses free text.
 */
export interface WhatsAppDelivery {
  buttons?: string[];
  template?: { name: string; language: string; header: string[]; body: string[]; buttons: number };
  needed?: string;
}
export interface OutgoingMessage { to: string; subject?: string; text: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>; whatsapp?: WhatsAppDelivery }

/** A template as the messaging module asks a WhatsApp service to approve it (Meta's own shape). */
export interface TemplateDefinition { name: string; category: string; language: string; components: unknown[] }
export interface TemplateStanding { name: string; language: string; status: string; reason?: string; id?: string }
/** WhatsApp services that keep templates themselves: submit one for approval, and read where each stands. */
export interface TemplateManager {
  submit(definition: TemplateDefinition): Promise<{ id?: string; status: string }>;
  standings(): Promise<TemplateStanding[]>;
}
export interface MessageSender {
  send(message: OutgoingMessage): Promise<{ providerRef?: string; simulated?: boolean }>;
  /** WhatsApp services with templates of their own (#112). */
  templates?: TemplateManager;
  /** A photo or file someone sent, fetched with the connection's key (#112). */
  media?(ref: string): Promise<{ body: Buffer; mime: string }>;
}
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
/**
 * One reading from a tracker. `id` is the service's own event id, when it gives one (repeats are dropped by it);
 * `registration` is the truck's plate, when the service knows it; `source` says what produced the reading.
 */
export interface Position {
  deviceId: string; lat: number; lng: number; at: Date; speedKmh?: number; heading?: number;
  id?: string; registration?: string; externalId?: string; odometerKm?: number; ignition?: boolean; accuracyM?: number;
  source?: PositionOrigin;
}
/** What produced a position: the truck's tracker, the platform's own fusion, the driver's phone, or the simulator. */
export const POSITION_SOURCES = ['device', 'partner', 'phone', 'simulator'] as const;
export type PositionOrigin = (typeof POSITION_SOURCES)[number];
export interface PositionSource { positions(signal?: AbortSignal): Promise<Position[]> }
export interface ExportFile { name: string; mime: string; body: Buffer }
export interface AccountingExport { export(input: { name: string; columns: string[]; rows: Array<Record<string, unknown>> }): Promise<ExportFile & { sent: boolean }> }
export interface FuelCardTransaction { cardNumber: string; at: Date; litres: number; amountMinor: number; currency: string; station?: string; reference: string }
export interface FuelCardSource { transactions(since: Date, signal?: AbortSignal): Promise<FuelCardTransaction[]> }
export interface PayoutSender { pay(input: { to: string; amountMinor: number; currency: string; reference: string }): Promise<{ providerRef: string; simulated: boolean }> }

/* Fleet data exchange (#136): trips, trucks and places out to a GPS or fleet-analytics platform; its events back in. */

/** The versioned canonical schema every fleet-exchange message is written in. */
export const FLEET_SCHEMA = 'marichi.fleet-exchange/1';
export const FLEET_OUT_TYPES = ['trip.upsert', 'trip.cancel', 'trip.close', 'place.upsert', 'place.delete', 'vehicle.upsert', 'vehicle.status', 'sync.snapshot'] as const;
export type FleetOutType = (typeof FLEET_OUT_TYPES)[number];
export const FLEET_IN_TYPES = ['position', 'geofence.enter', 'geofence.exit', 'ignition', 'odometer', 'halt', 'trip.metrics', 'device.status'] as const;
export type FleetInType = (typeof FLEET_IN_TYPES)[number];

/** What a platform can do with what we send, so the exchange sends only what it can use. */
export interface FleetExchangeCapabilities {
  /** It can hold geofences. */
  places: boolean;
  /** It stores a trip (job, order, route) natively, as notes, or not at all. */
  trips: 'native' | 'as-notes' | 'none';
  /** It accepts our truck status. */
  vehicleStatus: boolean;
  inbound: 'push' | 'pull' | 'both' | 'none';
  /** It works out geofence entry and exit itself. */
  geofenceEvents: boolean;
  /** The most messages it takes in one call. */
  maxBatch: number;
}
/** One canonical message, as the outbox hands it over: the envelope is already built. */
export interface PushItem { key: string; type: FleetOutType; entityId: string; envelope: Record<string, unknown>; attempt: number }
/** What happened to one item. `retryable` says a later attempt may work (a timeout, 429, 5xx). */
export interface PushOutcome { key: string; ok: boolean; vendorRef?: string; retryable?: boolean; message?: string; simulated?: boolean; status?: number }
/** One event from a platform, in the canonical shape (an adapter turns the platform's own shape into this). */
export interface FleetInboundEvent {
  id?: string;
  type: FleetInType;
  at: Date;
  vehicle?: { registration?: string; deviceId?: string; externalId?: string };
  place?: { code?: string; externalId?: string };
  tripNumber?: string;
  lat?: number; lng?: number; speedKmh?: number; heading?: number; odometerKm?: number; ignition?: boolean; accuracyM?: number;
  source?: PositionOrigin;
  /** Anything else the event carried (halt minutes, trip metrics, device state), kept as sent. */
  extra?: Record<string, unknown>;
}
export interface FleetExchangeClient {
  capabilities: FleetExchangeCapabilities;
  /** Sends a batch; one outcome per item. Never throws for one item's refusal. */
  push(items: PushItem[], signal?: AbortSignal): Promise<PushOutcome[]>;
  /** Pull-style platforms: events since the cursor. */
  poll?(cursor: string | undefined, signal?: AbortSignal): Promise<{ events: FleetInboundEvent[]; cursor: string }>;
}

export interface Capabilities {
  'fleet-exchange': FleetExchangeClient;
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
export interface InboundMessage {
  from: string; text?: string; at: Date; providerRef?: string; kind?: 'text' | 'button' | 'photo' | 'other';
  /** A photo or file in the message: the service's reference for `media()`, its caption and file type. */
  media?: { ref: string; mime?: string; caption?: string; filename?: string };
}

/** What a call to a connection's webhook brought in, for whoever listens to that kind (#60 for trackers). */
export interface InboundResult { accepted: number; positions?: Position[]; messages?: InboundMessage[]; events?: FleetInboundEvent[]; note?: string }
/**
 * What a feature listening to calls did with one (#136): counts added to the webhook's answer, so a sender
 * sees how many were new, repeats, or for a truck nobody has matched yet.
 */
export interface InboundCounts { stored?: number; duplicate?: number; unmatched?: number; rejected?: number; notes?: string[] }

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
