import { NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Party } from '../parties/models/party.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { DriverDocument } from './models/cargo.model.js';
import { FundRequest } from './models/funding.model.js';
import { Activity, Message, ThreadRead } from './models/message.model.js';
import { Trip } from './models/trip.model.js';
import { litres, need, post, present, refuse, type MessageButton, type OpsContext } from './support.js';
import type * as S from './operations.schema.js';

export const DESK_THREADS = ['owner', 'operations', 'finance'];

export async function listMessages(query: S.MessageListQuery) {
  const filter: Plain = {};
  if (query.thread) filter.thread = query.thread;
  if (query.since) filter.updatedAt = { $gt: query.since };
  const rows = await Message.find(filter).sort({ at: -1, _id: -1 }).limit(query.limit).lean();
  return rows.reverse().map(present);
}

/** Each thread with its last message and how many the user hasn't read. */
export async function listThreads(userId: string) {
  const reads = new Map((await ThreadRead.find({ userId }).lean()).map((r) => [String(r.thread), r.at as Date]));
  const threads = await Message.aggregate<{ _id: string; last: Plain }>([
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

/** What is waiting at a desk, for the reply when someone writes to the desk's WhatsApp. */
async function waitingFor(desk: string): Promise<MessageButton[]> {
  const out: MessageButton[] = [];
  if (desk === 'finance' || desk === 'owner') {
    for (const r of await FundRequest.find({ status: desk === 'owner' ? 'owner' : 'pending' }).sort({ createdAt: 1 }).limit(3).lean()) {
      const trip = await Trip.findById(r.tripId).select('vehicleId').lean();
      const plate = trip ? (await Vehicle.findById(trip.vehicleId).select('registrationNumber').lean())?.registrationNumber : '';
      out.push({ label: `${r.kind === 'fuel' ? 'Fuel' : 'Advance'} ${r.kind === 'fuel' ? litres(Number(r.litres)) : r.number} · ${plate}`, nav: { tripId: String(r.tripId), view: 'funding' } });
    }
  }
  if (desk === 'operations') {
    for (const d of await DriverDocument.find({ status: 'new', kind: { $in: ['loading', 'delivery'] } }).sort({ at: 1 }).limit(3).lean()) {
      const driver = await Driver.findById(d.driverId).select('name').lean();
      out.push({ label: `${d.kind === 'loading' ? 'Loading' : 'Delivery'} · ${driver?.name ?? ''}`, nav: { tripId: d.tripId ? String(d.tripId) : undefined, docId: String(d._id) } });
    }
  }
  return out;
}

/**
 * The office writes in a thread: to a customer, to a driver (delivered on WhatsApp), or to a desk's own
 * WhatsApp, which answers with what is waiting there.
 */
export async function sendChat(input: S.ChatInput, ctx: OpsContext) {
  need(ctx, 'messages', 'create');
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
    const open = await waitingFor(input.thread);
    await post(input.thread, at, { text: open.length ? "Here's what's waiting for you:" : "Nothing is waiting for you right now. I'll message you when something comes in.", buttons: open }, ctx);
  }
  if (ctx.actorId) await markRead({ thread: input.thread }, ctx.actorId);
  return listMessages({ thread: input.thread, limit: 20 });
}

export async function listActivity(query: S.ActivityListQuery) {
  const filter: Plain = {};
  if (query.tripId) filter.tripId = query.tripId;
  if (query.since) filter.updatedAt = { $gt: query.since };
  const rows = await Activity.find(filter).sort({ at: -1, _id: -1 }).limit(query.limit).lean();
  return rows.map(present);
}

export function assertThread(thread: string) {
  if (!DESK_THREADS.includes(thread) && !/^(driver|customer):[0-9a-f]{24}$/.test(thread)) throw refuse('Unknown thread.');
}
