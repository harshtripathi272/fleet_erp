import { z } from 'zod';
import { registerProvider } from '../registry.js';
import type { Position } from '../types.js';
import { basicAuth, callJson } from './http.js';

/*
 * GPS trackers: where each truck is. A tracker service either pushes positions to the connection's signed
 * webhook (`inbound`) or is asked for them (`positions`). #60 matches devices to trucks and trips.
 */

registerProvider({
  kind: 'gps', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'No trackers: positions come from the drive simulator on each trip, marked Simulated.',
  fields: z.strictObject({}),
  test: async () => ({ ok: true, message: 'The drive simulator moves trucks along their routes.' }),
  open: () => ({ positions: async () => [] }),
});

/** Reads a dotted path such as "position.lat" from a JSON object. */
const pick = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);

const mappingFields = z.strictObject({
  listPath: z.string().trim().max(100).optional(),
  deviceField: z.string().trim().min(1).max(100).default('deviceId'),
  latField: z.string().trim().min(1).max(100).default('lat'),
  lngField: z.string().trim().min(1).max(100).default('lng'),
  timeField: z.string().trim().min(1).max(100).default('time'),
  speedField: z.string().trim().max(100).optional(),
  headingField: z.string().trim().max(100).optional(),
});
type Mapping = z.infer<typeof mappingFields>;

/** Positions from any JSON a tracker service sends, read with the connection's field mapping. */
export function readPositions(body: unknown, mapping: Partial<Mapping>): Position[] {
  const m = mappingFields.parse(mapping);
  const listed = m.listPath ? pick(body, m.listPath) : body;
  const items = Array.isArray(listed) ? listed : [listed];
  const out: Position[] = [];
  for (const item of items) {
    const lat = Number(pick(item, m.latField));
    const lng = Number(pick(item, m.lngField));
    const deviceId = pick(item, m.deviceField);
    const time = pick(item, m.timeField);
    const at = typeof time === 'number' ? new Date(time < 1e12 ? time * 1000 : time) : new Date(String(time ?? ''));
    if (deviceId === undefined || deviceId === null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || Number.isNaN(at.getTime())) continue;
    const speed = m.speedField ? Number(pick(item, m.speedField)) : NaN;
    const heading = m.headingField ? Number(pick(item, m.headingField)) : NaN;
    out.push({ deviceId: String(deviceId), lat, lng, at, ...(Number.isFinite(speed) ? { speedKmh: speed } : {}), ...(Number.isFinite(heading) ? { heading } : {}) });
  }
  return out;
}

registerProvider({
  kind: 'gps', key: 'webhook', label: 'Any tracker service (webhook)',
  description: "For a tracker service that can send each position as JSON to a web address. Map its field names below; the call must be signed with this connection's signing secret.",
  fields: mappingFields,
  labels: { listPath: 'List of positions at', deviceField: 'Device ID field', latField: 'Latitude field', lngField: 'Longitude field', timeField: 'Time field', speedField: 'Speed field (km/h)', headingField: 'Heading field' },
  hints: { listPath: 'Empty when each call carries one position; e.g. "positions" when it carries a list', timeField: 'An ISO date, or seconds or milliseconds since 1970', deviceField: 'Dots reach inside objects, e.g. "device.imei"' },
  test: async () => ({ ok: true, message: 'Waiting for signed calls to the web address above.' }),
  open: () => ({ positions: async () => [] }),
  async inbound(ctx, body) {
    const positions = readPositions(body, ctx.settings as Partial<Mapping>);
    return { accepted: positions.length, positions, ...(positions.length ? {} : { note: 'No position could be read with the field mapping' }) };
  },
});

/** Traccar: open-source tracking server that speaks to most tracker brands. Asked for positions. */
registerProvider({
  kind: 'gps', key: 'traccar', label: 'Traccar',
  description: 'A Traccar server, your own or hosted. Positions are fetched from it.',
  fields: z.strictObject({ baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'An http or https address'), user: z.string().trim().min(1).max(200) }),
  labels: { baseUrl: 'Server address', user: 'User name' },
  hints: { baseUrl: 'e.g. https://traccar.company.com', user: 'A Traccar user who can see every device' },
  secrets: [{ key: 'password', label: 'Password', required: true }],
  async test(ctx) {
    const devices = await callJson<unknown[]>('Traccar', `${url(ctx.settings)}/api/devices`, { headers: auth(ctx) });
    return { ok: true, message: `Signed in. ${devices.length} device${devices.length === 1 ? '' : 's'} visible.` };
  },
  open: (ctx) => ({
    async positions(signal) {
      const list = await callJson<Array<{ deviceId: number; latitude: number; longitude: number; fixTime: string; speed?: number; course?: number }>>('Traccar', `${url(ctx.settings)}/api/positions`, { headers: auth(ctx), signal });
      // Traccar gives speed in knots.
      return list.map((p) => ({ deviceId: String(p.deviceId), lat: p.latitude, lng: p.longitude, at: new Date(p.fixTime), ...(p.speed !== undefined ? { speedKmh: Math.round(p.speed * 1.852) } : {}), ...(p.course !== undefined ? { heading: p.course } : {}) }));
    },
  }),
});

const url = (s: Record<string, unknown>) => String(s.baseUrl).replace(/\/$/, '');
const auth = (ctx: { settings: Record<string, unknown>; secret(k: string): string | undefined }) => ({ authorization: basicAuth(String(ctx.settings.user), ctx.secret('password')!) });
