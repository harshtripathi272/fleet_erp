import { z } from 'zod';
import { registerProvider, signBody } from '../registry.js';
import {
  FLEET_IN_TYPES, FLEET_SCHEMA, type FleetExchangeCapabilities, type FleetInboundEvent, type InboundResult, type Position, POSITION_SOURCES,
  type ProviderContext, type PushItem, type PushOutcome, type SecretSpec,
} from '../types.js';
import { basicAuth, CALL_TIMEOUT_MS } from './http.js';

/*
 * Fleet data exchange (#136): the vendor-neutral link to a GPS or fleet-analytics platform. We send trips,
 * trucks and places in our own small versioned schema (marichi.fleet-exchange/1) and take back positions and
 * geofence events in the same schema. A platform with its own API gets one adapter file here.
 */

/** What every fleet-exchange connection decides, whatever the platform: what to send, and what personal data goes with it. */
const exchangeFields = {
  sendTrips: z.boolean().default(true),
  sendPlaces: z.boolean().default(true),
  sendVehicles: z.boolean().default(true),
  includeCustomer: z.boolean().default(true),
  includeDriverName: z.boolean().default(true),
  includeDriverPhone: z.boolean().default(false),
  /** Calls a platform may make to the pull API in a minute. */
  pullPerMinute: z.number().int().min(1).max(600).default(60),
};
const exchangeLabels: Record<string, string> = {
  sendTrips: 'Send trips', sendPlaces: 'Send places (geofences)', sendVehicles: 'Send trucks',
  includeCustomer: "Include the customer's name", includeDriverName: "Include the driver's name", includeDriverPhone: "Include the driver's phone number",
  pullPerMinute: 'Pull API calls a minute',
};
const exchangeHints: Record<string, string> = {
  includeDriverPhone: 'Off unless the platform needs to call drivers',
  pullPerMinute: 'For a platform that fetches from us; more calls than this in a minute are refused',
};
/**
 * The pull API's tokens, held in server settings like every secret. Two, so a token can be changed with no
 * break: set the new one as the next token, move the platform over, then make it the token and clear the next.
 */
const pullSecrets: SecretSpec[] = [
  { key: 'pullToken', label: 'Pull API token', required: false, hint: 'Only for a platform that fetches from us' },
  { key: 'pullTokenNext', label: 'Next pull API token', required: false, hint: 'While changing tokens: both are accepted' },
];

/* Reading what a platform sends us */

const canonicalEvent = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  type: z.enum(FLEET_IN_TYPES),
  at: z.union([z.string(), z.number()]).transform((v) => new Date(typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v)).refine((d) => !Number.isNaN(d.getTime()), 'A date'),
  vehicle: z.object({
    registration: z.string().max(40).optional(),
    deviceId: z.union([z.string(), z.number()]).transform(String).optional(),
    externalId: z.union([z.string(), z.number()]).transform(String).optional(),
  }).optional(),
  place: z.object({ code: z.string().max(40).optional(), externalId: z.union([z.string(), z.number()]).transform(String).optional() }).optional(),
  tripNumber: z.string().max(60).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  speedKmh: z.number().min(0).max(400).optional(),
  heading: z.number().min(0).max(360).optional(),
  odometerKm: z.number().min(0).optional(),
  ignition: z.boolean().optional(),
  accuracyM: z.number().min(0).optional(),
  source: z.enum(POSITION_SOURCES).optional(),
}).passthrough();
const KNOWN = new Set(['id', 'type', 'at', 'vehicle', 'place', 'tripNumber', 'lat', 'lng', 'speedKmh', 'heading', 'odometerKm', 'ignition', 'accuracyM', 'source']);

/** Events in the canonical shape: `{ schema, events: [...] }`, or one event on its own. Unreadable ones are counted, not guessed. */
export function readCanonicalEvents(body: unknown): { events: FleetInboundEvent[]; rejected: number } {
  const list = body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : [body];
  const events: FleetInboundEvent[] = [];
  let rejected = 0;
  for (const item of list) {
    const parsed = canonicalEvent.safeParse(item);
    if (!parsed.success) { rejected += 1; continue; }
    const { id, type, at, vehicle, place, tripNumber, lat, lng, speedKmh, heading, odometerKm, ignition, accuracyM, source, ...rest } = parsed.data;
    if (type === 'position' && (lat === undefined || lng === undefined || !(vehicle?.deviceId || vehicle?.registration || vehicle?.externalId))) { rejected += 1; continue; }
    const extra = Object.fromEntries(Object.entries(rest).filter(([k]) => !KNOWN.has(k)));
    events.push({
      ...(id ? { id } : {}), type, at, ...(vehicle ? { vehicle } : {}), ...(place ? { place } : {}), ...(tripNumber ? { tripNumber } : {}),
      ...(lat !== undefined ? { lat } : {}), ...(lng !== undefined ? { lng } : {}), ...(speedKmh !== undefined ? { speedKmh } : {}), ...(heading !== undefined ? { heading } : {}),
      ...(odometerKm !== undefined ? { odometerKm } : {}), ...(ignition !== undefined ? { ignition } : {}), ...(accuracyM !== undefined ? { accuracyM } : {}),
      ...(source ? { source } : {}), ...(Object.keys(extra).length ? { extra } : {}),
    });
  }
  return { events, rejected };
}

/** The positions among canonical events, as the position store reads them. */
export function positionsOf(events: FleetInboundEvent[]): Position[] {
  return events.filter((e) => e.type === 'position').map((e) => ({
    deviceId: e.vehicle?.deviceId ?? '', lat: e.lat!, lng: e.lng!, at: e.at,
    ...(e.id ? { id: e.id } : {}), ...(e.vehicle?.registration ? { registration: e.vehicle.registration } : {}), ...(e.vehicle?.externalId ? { externalId: e.vehicle.externalId } : {}),
    ...(e.speedKmh !== undefined ? { speedKmh: e.speedKmh } : {}), ...(e.heading !== undefined ? { heading: e.heading } : {}),
    ...(e.odometerKm !== undefined ? { odometerKm: e.odometerKm } : {}), ...(e.ignition !== undefined ? { ignition: e.ignition } : {}),
    ...(e.accuracyM !== undefined ? { accuracyM: e.accuracyM } : {}), source: e.source ?? 'partner',
  }));
}

async function readInbound(_ctx: ProviderContext, body: unknown): Promise<InboundResult> {
  const { events, rejected } = readCanonicalEvents(body);
  const positions = positionsOf(events);
  return {
    accepted: events.length, events, positions,
    ...(rejected ? { note: `${rejected} event${rejected === 1 ? '' : 's'} could not be read in the ${FLEET_SCHEMA} shape` } : {}),
  };
}

/* Sending */

/** The headers every message goes with: what it is, its key for the receiver's own dedupe, and our signature. */
export function signedHeaders(input: { secret?: string; body: string; idempotencyKey: string; attempt: number; now?: number; userAgent?: string }): Record<string, string> {
  const ts = String(Math.floor((input.now ?? Date.now()) / 1000));
  return {
    'content-type': 'application/json',
    'idempotency-key': input.idempotencyKey,
    'x-marichi-attempt': String(input.attempt),
    'user-agent': input.userAgent ?? 'MarichiFleet/1',
    ...(input.secret ? { 'x-signature-timestamp': ts, 'x-signature': signBody(input.secret, ts, input.body) } : {}),
  };
}

/** Our answer to an HTTP status: 2xx and 409 (the platform already has it) worked; 408, 429 and 5xx are tried again; other 4xx are final. */
export const outcomeOfStatus = (status: number) => ({ ok: (status >= 200 && status < 300) || status === 409, retryable: status === 408 || status === 429 || status >= 500 });

/** The simulated partner keeps what it is sent; the outbox writes each one to the simulated partner's inbox. */
const SIMULATED_CAPABILITIES: FleetExchangeCapabilities = { places: true, trips: 'native', vehicleStatus: true, inbound: 'both', geofenceEvents: true, maxBatch: 50 };
/**
 * The simulated partner signs with this key, shown on screen, so a real platform's engineers can check our
 * signatures against the examples. It is not a secret and is never used for a real connection.
 */
export const SIMULATED_SIGNING_KEY = 'simulated-partner-public-test-key';

registerProvider({
  kind: 'fleet-exchange', key: 'simulated', label: 'Simulated partner', simulated: true,
  description: 'No platform: every message is built, signed and kept in the simulated partner inbox below, exactly as a real platform would get it. Nothing leaves this server.',
  fields: z.strictObject(exchangeFields),
  labels: exchangeLabels, hints: exchangeHints,
  secrets: pullSecrets,
  test: async () => ({ ok: true, message: 'The simulated partner keeps every message it is sent, with its signature, in the simulated partner inbox.' }),
  open: () => ({
    capabilities: SIMULATED_CAPABILITIES,
    push: async (items: PushItem[]) => items.map((i) => ({ key: i.key, ok: true, simulated: true, message: 'Kept by the simulated partner' })),
  }),
  inbound: readInbound,
});

const AUTH_STYLES = ['bearer', 'header', 'basic', 'none'] as const;
const marichiFields = z.strictObject({
  baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'An http or https address'),
  path: z.string().trim().regex(/^\/[\w\-./]*$/, 'A path starting with /').max(200).default('/marichi/fleet-exchange'),
  tripPath: z.string().trim().regex(/^\/[\w\-./]*$/, 'A path starting with /').max(200).optional(),
  placePath: z.string().trim().regex(/^\/[\w\-./]*$/, 'A path starting with /').max(200).optional(),
  vehiclePath: z.string().trim().regex(/^\/[\w\-./]*$/, 'A path starting with /').max(200).optional(),
  testPath: z.string().trim().regex(/^\/[\w\-./]*$/, 'A path starting with /').max(200).optional(),
  authStyle: z.enum(AUTH_STYLES).default('bearer'),
  headerName: z.string().trim().regex(/^[A-Za-z0-9-]{1,60}$/, 'A header name such as X-Api-Key').optional(),
  user: z.string().trim().max(200).optional(),
  maxBatch: z.number().int().min(1).max(500).default(1),
  ...exchangeFields,
}).refine((s) => s.authStyle !== 'header' || s.headerName, { path: ['headerName'], message: 'Name the header the key goes in' })
  .refine((s) => s.authStyle !== 'basic' || s.user, { path: ['user'], message: 'The user name for basic sign-in' });
type MarichiSettings = z.infer<typeof marichiFields>;

const base = (s: MarichiSettings) => s.baseUrl.replace(/\/$/, '');
const pathFor = (s: MarichiSettings, type: string) => (type.startsWith('trip.') ? s.tripPath : type.startsWith('place.') ? s.placePath : type.startsWith('vehicle.') ? s.vehiclePath : undefined) ?? s.path;
function authHeader(ctx: ProviderContext, s: MarichiSettings): Record<string, string> {
  if (s.authStyle === 'none') return {};
  const token = ctx.secret('apiToken');
  if (!token) throw new Error('No API key is set for this connection');
  if (s.authStyle === 'bearer') return { authorization: `Bearer ${token}` };
  if (s.authStyle === 'basic') return { authorization: basicAuth(s.user ?? '', token) };
  return { [s.headerName!.toLowerCase()]: token };
}

/** One POST: the outcome for each item it carried. A network failure or timeout is tried again. */
async function post(ctx: ProviderContext, s: MarichiSettings, url: string, items: PushItem[], signal?: AbortSignal): Promise<PushOutcome[]> {
  const single = items.length === 1;
  const body = JSON.stringify(single ? items[0]!.envelope : { schema: FLEET_SCHEMA, messages: items.map((i) => i.envelope) });
  const key = single ? items[0]!.key : `batch:${items.map((i) => i.key).join(',')}`.slice(0, 500);
  let res: Response;
  try {
    const headers = { ...signedHeaders({ secret: ctx.secret('signingSecret'), body, idempotencyKey: key, attempt: Math.max(...items.map((i) => i.attempt)) }), ...authHeader(ctx, s) };
    res = await fetch(url, { method: 'POST', body, headers, signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (err) {
    return items.map((i) => ({ key: i.key, ok: false, retryable: true, message: (err as Error).message }));
  }
  const text = await res.text().catch(() => '');
  let answer: Record<string, unknown> = {};
  try { answer = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* not JSON */ }
  const { ok, retryable } = outcomeOfStatus(res.status);
  const said = String(answer.message ?? answer.error ?? text.slice(0, 200));
  // The platform's own id for what it stored: `id` for one message, `refs[key]` for a batch.
  const refs = (answer.refs ?? {}) as Record<string, unknown>;
  const refOf = (key: string) => {
    const ref = single ? answer.id ?? answer.externalId : refs[key];
    return typeof ref === 'string' || typeof ref === 'number' ? String(ref) : undefined;
  };
  return items.map((i) => {
    const vendorRef = ok ? refOf(i.key) : undefined;
    return {
      key: i.key, ok, retryable: !ok && retryable, status: res.status,
      ...(ok ? {} : { message: `The platform answered ${res.status}${said ? `: ${said}` : ''}` }),
      ...(vendorRef ? { vendorRef } : {}),
    };
  });
}

registerProvider({
  kind: 'fleet-exchange', key: 'marichi-json', label: 'Any platform that takes our format',
  description: `For a platform whose engineers accept our own ${FLEET_SCHEMA} messages (or put a small translation in front of them): each message is a signed JSON POST to the address below, and its events come back to this connection's web address in the same format.`,
  fields: marichiFields,
  labels: {
    ...exchangeLabels, baseUrl: 'Platform address', path: 'Path for messages', tripPath: 'Path for trips', placePath: 'Path for places', vehiclePath: 'Path for trucks',
    testPath: 'Path to test', authStyle: 'How we sign in', 'authStyle.bearer': 'Bearer token', 'authStyle.header': 'Key in a header', 'authStyle.basic': 'User name and password',
    'authStyle.none': 'No sign-in', headerName: 'Header for the key', user: 'User name', maxBatch: 'Messages in one call',
  },
  hints: {
    ...exchangeHints, baseUrl: 'e.g. https://api.platform.com', path: 'Used for every kind of message unless a path below is set',
    testPath: 'A GET that answers when the address and key are right; empty to skip', maxBatch: 'More than 1 sends {"schema", "messages": [...]} in one call',
  },
  secrets: [
    { key: 'signingSecret', label: 'Signing secret', required: true, hint: 'The platform checks our X-Signature with it' },
    { key: 'apiToken', label: 'API key', required: false, hint: 'Unless the platform needs no sign-in' },
    ...pullSecrets,
  ],
  async test(ctx) {
    const s = marichiFields.parse(ctx.settings);
    ctx.secret('signingSecret');
    if (!s.testPath) return { ok: true, message: 'Settings are complete. Nothing is sent until a trip, truck or place changes, or you press Resync.' };
    const res = await fetch(`${base(s)}${s.testPath}`, { headers: { accept: 'application/json', ...authHeader(ctx, s) }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The platform answered ${res.status} at ${s.testPath}`);
    return { ok: true, message: `The platform answered ${res.status} at ${s.testPath}.` };
  },
  open: (ctx) => {
    const s = marichiFields.parse(ctx.settings);
    return {
      capabilities: { places: true, trips: 'native', vehicleStatus: true, inbound: 'push', geofenceEvents: true, maxBatch: s.maxBatch },
      async push(items, signal) {
        const byPath = new Map<string, PushItem[]>();
        for (const item of items) byPath.set(pathFor(s, item.type), [...(byPath.get(pathFor(s, item.type)) ?? []), item]);
        const out: PushOutcome[] = [];
        for (const [path, group] of byPath) {
          for (let i = 0; i < group.length; i += s.maxBatch) out.push(...await post(ctx, s, `${base(s)}${path}`, group.slice(i, i + s.maxBatch), signal));
        }
        return out;
      },
    };
  },
  inbound: readInbound,
});
