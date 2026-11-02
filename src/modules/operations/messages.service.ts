import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Action, Plain } from '../../core/masters/types.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Party } from '../parties/models/party.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { DriverDocument } from './models/cargo.model.js';
import { FundRequest } from './models/funding.model.js';
import { Activity, Message, ThreadRead } from './models/message.model.js';
import { Trip } from './models/trip.model.js';
import { OPERATIONS_RESOURCES } from './resources.js';
import { litres, need, post, present, type MessageButton, type OpsContext } from './support.js';
import type * as S from './operations.schema.js';

export interface Viewer { userId: string; roles: string[]; can: (resource: string, action: Action) => boolean }

/**
 * Which threads a person sees follows their permissions, not their role's name: the work queues of
 * every area they may act in, the approval threads of their roles, their own thread, and the
 * driver and customer conversations. Holders of every permission see everything.
 */
export function threadFilter(viewer: Viewer): Plain {
  if (viewer.can('*', 'create')) return {};
  const threads = [
    ...OPERATIONS_RESOURCES.filter((r) => viewer.can(r, 'create')).map((r) => `queue:${r}`),
    ...viewer.roles.map((key) => `role:${key}`),
    `user:${viewer.userId}`,
  ];
  return { $or: [{ thread: { $in: threads } }, { thread: { $regex: '^(driver|customer):' } }] };
}

/** Whether a person sees one thread (the same rule as threadFilter). */
export function matches(viewer: Viewer, thread: string) {
  if (viewer.can('*', 'create') || /^(driver|customer):/.test(thread)) return true;
  const [kind, value] = thread.split(':');
  return (kind === 'queue' && viewer.can(value!, 'create')) || (kind === 'role' && viewer.roles.includes(value!)) || (kind === 'user' && value === viewer.userId);
}

export async function listMessages(query: S.MessageListQuery, viewer: Viewer) {
  if (query.thread && !matches(viewer, query.thread)) throw new ForbiddenError('You do not see this conversation');
  const filter: Plain = { ...threadFilter(viewer) };
  if (query.thread) filter.thread = query.thread;
  if (query.since) filter.updatedAt = { $gt: query.since };
  const rows = await Message.find(filter).sort({ at: -1, _id: -1 }).limit(query.limit).lean();
  return rows.reverse().map(present);
}

/** Each thread the person sees, with its last message and how many they haven't read. */
export async function listThreads(viewer: Viewer) {
  const reads = new Map((await ThreadRead.find({ userId: viewer.userId }).lean()).map((r) => [String(r.thread), r.at as Date]));
  const threads = await Message.aggregate<{ _id: string; last: Plain }>([
    { $match: threadFilter(viewer) },
    { $sort: { at: -1 } },
    { $group: { _id: '$thread', last: { $first: '$$ROOT' } } },
  ]);
  return Promise.all(threads.map(async (t) => {
    const read = reads.get(t._id);
    const unread = await Message.countDocuments({ thread: t._id, from: { $ne: 'me' }, ...(read ? { at: { $gt: read } } : {}) });
    return { thread: t._id, last: present(t.last), readAt: read ?? null, unread };
  }));
}

export async function markRead(input: S.ReadInput, userId: string) {
  const at = new Date();
  await ThreadRead.updateOne({ userId, thread: input.thread }, { $set: { at } }, { upsert: true });
  return { thread: input.thread, at };
}

/** What waits in a work thread, for the reply when someone writes to it. */
async function waitingIn(thread: string): Promise<MessageButton[]> {
  const out: MessageButton[] = [];
  const requests = thread === 'queue:payments'
    ? await FundRequest.find({ status: 'approved' }).sort({ createdAt: 1 }).limit(3).lean()
    : await FundRequest.find({ status: 'pending', $expr: { $eq: [{ $arrayElemAt: ['$approval.levels.thread', '$approval.current'] }, thread] } }).sort({ createdAt: 1 }).limit(3).lean();
  for (const r of requests) {
    const trip = await Trip.findById(r.tripId).select('vehicleId').lean();
    const plate = trip ? (await Vehicle.findById(trip.vehicleId).select('registrationNumber').lean())?.registrationNumber : '';
    out.push({ label: `${r.kind === 'fuel' ? 'Fuel' : 'Advance'} ${r.kind === 'fuel' ? litres(Number(r.litres)) : r.number} · ${plate}`, nav: { tripId: String(r.tripId), view: 'funding' } });
  }
  if (thread === 'queue:consignments') {
    for (const d of await DriverDocument.find({ status: 'new', kind: { $in: ['loading', 'delivery'] } }).sort({ at: 1 }).limit(3).lean()) {
      const driver = await Driver.findById(d.driverId).select('name').lean();
      out.push({ label: `${d.kind === 'loading' ? 'Loading' : 'Delivery'} · ${driver?.name ?? ''}`, nav: { tripId: d.tripId ? String(d.tripId) : undefined, docId: String(d._id) } });
    }
  }
  return out;
}

/**
 * The office writes in a thread: to a customer, to a driver (delivered on WhatsApp), or in a work
 * thread, which answers with what is waiting there.
 */
export async function sendChat(input: S.ChatInput, ctx: OpsContext) {
  need(ctx, 'messages', 'create');
  const viewer: Viewer = { userId: ctx.actorId ?? '', roles: ctx.roles, can: ctx.can };
  if (!matches(viewer, input.thread)) throw new ForbiddenError('You do not see this conversation');
  const at = new Date();
  const [kind, id] = input.thread.split(':');
  if (kind === 'customer') {
    if (!(await Party.exists({ _id: id }))) throw new NotFoundError('Customer not found');
    await post(input.thread, at, { from: 'me', text: input.text }, ctx);
  } else if (kind === 'driver') {
    if (!(await Driver.exists({ _id: id }))) throw new NotFoundError('Driver not found');
    await post(input.thread, at, { from: 'bot', title: ctx.name, text: input.text }, ctx);
  } else {
    await post(input.thread, at, { from: 'me', text: input.text }, ctx);
    const open = await waitingIn(input.thread);
    await post(input.thread, at, { text: open.length ? "Here's what's waiting:" : "Nothing is waiting here right now. I'll message you when something comes in.", buttons: open }, ctx);
  }
  if (ctx.actorId) await markRead({ thread: input.thread }, ctx.actorId);
  return listMessages({ thread: input.thread, limit: 20 }, viewer);
}

export async function listActivity(query: S.ActivityListQuery) {
  const filter: Plain = {};
  if (query.tripId) filter.tripId = query.tripId;
  if (query.since) filter.updatedAt = { $gt: query.since };
  const rows = await Activity.find(filter).sort({ at: -1, _id: -1 }).limit(query.limit).lean();
  return rows.map(present);
}
