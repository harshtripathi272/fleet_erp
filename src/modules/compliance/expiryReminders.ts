import { model, Schema } from 'mongoose';
import * as Fmt from '../../core/format/regional.js';
import { logger } from '../../core/logger/index.js';
import { getMaster, getRefTarget } from '../../core/masters/registry.js';
import type { Plain } from '../../core/masters/types.js';
import { CustomMaster, CustomRecord, FieldDefinition } from '../configuration/models/configuration.model.js';
import { notify } from '../messaging/dispatcher.js';
import { DocumentType } from './models/documentType.model.js';
import { ComplianceDocument } from './models/complianceDocument.model.js';

/**
 * Reminders for documents that expire (#105, from #97's review): compliance documents (road tax, insurance, a
 * driver's licence held as a document) and a company's own document fields with an expiry date (a driver's medical
 * certificate). `document.expiring` goes once when one comes within the warning window, `document.expired` once
 * when it lapses, through the company's notification rules. Renewing (a new expiry date) starts again.
 */

export const EXPIRY_WARNING_DAYS = 30;
const DAY = 86_400_000;

/** One reminder sent: a document, its expiry date and the state reminded. The unique index makes it once only. */
const sentSchema = new Schema({
  ref: { type: String, required: true },
  expiresOn: { type: String, required: true },
  state: { type: String, enum: ['expiring', 'expired'], required: true },
  at: { type: Date, required: true },
}, { versionKey: false, collection: 'expiryreminders' });
sentSchema.index({ ref: 1, expiresOn: 1, state: 1 }, { unique: true });
export const ExpiryReminder = model('ExpiryReminder', sentSchema);

interface Due { ref: string; expiresOn: string; name: string; number?: string; holder: string; holderKind: string; holderId: string; vehicle?: string }

/** Claims a reminder; false when another run (or instance) already sent it. */
async function claim(due: Due, state: 'expiring' | 'expired', now: Date) {
  try {
    await ExpiryReminder.create({ ref: due.ref, expiresOn: due.expiresOn, state, at: now });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

const day = (value: unknown) => new Date(String(value)).toISOString().slice(0, 10);
const titleOf = (record: Plain | null | undefined, field = 'name') => String(record?.[field] ?? record?.name ?? record?.registrationNumber ?? record?.code ?? '');

/** Compliance documents of active holders that expire within the window, or have expired. */
async function complianceDue(until: Date): Promise<Due[]> {
  const docs = await ComplianceDocument.find({ status: 'active', expiryDate: { $lte: until } }).lean() as Plain[];
  const types = new Map((await DocumentType.find({ _id: { $in: docs.map((d) => d.documentTypeId) } }).select('name').lean()).map((t) => [String(t._id), String(t.name)]));
  const kinds: Record<string, string> = { vehicle: 'vehicles', trailer: 'trailers', driver: 'drivers', party: 'parties' };
  const out: Due[] = [];
  for (const d of docs) {
    const target = kinds[String(d.subjectKind)] ? getRefTarget(kinds[String(d.subjectKind)]!) : undefined;
    const holder = target ? await target.model.findById(d.subjectId).lean() as Plain | null : null;
    if (target && (!holder || holder.status === 'archived')) continue;
    const name = holder ? titleOf(holder, target!.titleField) : 'the company';
    out.push({
      ref: `compliance-documents:${String(d._id)}`, expiresOn: day(d.expiryDate), name: types.get(String(d.documentTypeId)) ?? 'A document', number: d.number as string | undefined,
      holder: name, holderKind: target?.key ?? 'company', holderId: String(d.subjectId), ...(d.subjectKind === 'vehicle' ? { vehicle: name } : {}),
    });
  }
  return out;
}

/** A company's document fields with an expiry date, on masters and on custom masters' records. */
async function fieldsDue(until: Date): Promise<Due[]> {
  const last = until.toISOString().slice(0, 10);
  const out: Due[] = [];
  for (const f of await FieldDefinition.find({ type: 'document', withExpiry: true, status: 'active' }).lean() as Plain[]) {
    const def = getMaster(String(f.entity));
    if (!def) continue;
    const path = `custom.${String(f.key)}`;
    const rows = await def.model.find({ status: { $ne: 'archived' }, [`${path}.expiresOn`]: { $lte: last } }).lean() as Plain[];
    for (const r of rows) {
      const value = ((r.custom ?? {}) as Plain)[String(f.key)] as Plain;
      const holder = titleOf(r, def.titleField);
      out.push({ ref: `${def.key}:${String(r._id)}:${path}`, expiresOn: String(value.expiresOn), name: String(f.label), number: String(value.name ?? ''), holder, holderKind: def.key, holderId: String(r._id), ...(def.key === 'vehicles' ? { vehicle: holder } : {}) });
    }
  }
  for (const m of await CustomMaster.find({ status: 'active', fields: { $elemMatch: { type: 'document', withExpiry: true } } }).lean() as Plain[]) {
    for (const f of (m.fields as Plain[]).filter((x) => x.type === 'document' && x.withExpiry)) {
      const rows = await CustomRecord.find({ masterId: m._id, status: { $ne: 'archived' }, [`data.${String(f.key)}.expiresOn`]: { $lte: last } }).lean() as Plain[];
      for (const r of rows) {
        const value = ((r.data ?? {}) as Plain)[String(f.key)] as Plain;
        out.push({ ref: `custom-records:${String(r._id)}:data.${String(f.key)}`, expiresOn: String(value.expiresOn), name: String(f.label), number: String(value.name ?? ''), holder: `${String(r.title)} (${String(m.name)})`, holderKind: 'custom-records', holderId: String(r._id) });
      }
    }
  }
  return out;
}

/** Sends what is due now; several runs, or several instances, never send the same reminder twice. */
export async function remindExpiringDocuments(now = new Date()): Promise<number> {
  const until = new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY);
  const today = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const due of [...await complianceDue(until), ...await fieldsDue(until)]) {
    const state = due.expiresOn < today ? 'expired' : 'expiring';
    if (!(await claim(due, state, now))) continue;
    await notify({
      event: state === 'expired' ? 'document.expired' : 'document.expiring',
      variables: {
        'document.name': due.name, 'document.number': due.number, 'document.holder': due.holder,
        'document.expiryDate': Fmt.calendarDate(due.expiresOn), ...(due.vehicle ? { 'vehicle.registration': due.vehicle } : {}),
      },
      ref: { kind: due.holderKind, id: due.holderId },
    });
    sent += 1;
  }
  return sent;
}

let worker: NodeJS.Timeout | undefined;
/** Checks every `intervalMs` (an hour by default) in this process, and once soon after start. */
export function startExpiryWorker(intervalMs = 60 * 60_000) {
  if (worker) return;
  const run = () => { remindExpiringDocuments().catch((err) => logger.error({ err }, 'Expiry reminders failed')); };
  worker = setInterval(run, intervalMs);
  worker.unref();
  setTimeout(run, 60_000).unref();
}
export function stopExpiryWorker() { if (worker) clearInterval(worker); worker = undefined; }
