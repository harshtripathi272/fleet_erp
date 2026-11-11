import type { Plain } from '../../core/masters/types.js';
import { ConsignmentDocumentType } from '../freight/models/freight.model.js';
import { currentStop, legsByStopFor } from './driverApp.service.js';
import { Consignment, DriverDocument } from './models/cargo.model.js';
import { Trip } from './models/trip.model.js';
import { driverThread, post, type OpsContext } from './support.js';

/**
 * On WhatsApp a photo arrives with no kind and no consignment (#135 Part 2, design 3.8.3). The bot works it out:
 * the only paper due where the truck is, it files there; otherwise it asks what the photo is, then which
 * consignment, and the driver answers with a number. The question is kept on the photo, so nothing is lost if the
 * driver never answers: the office can still file it.
 */

type Due = { consignmentId: string; legId: string; documentTypeId: string; label: string; number: string; party?: string; kind: 'pickup' | 'drop' };

/** Every paper due at the stop the truck is at, one per consignment and paper. */
async function dueHere(tripId: unknown): Promise<Due[]> {
  const trip = await Trip.findById(tripId).lean<Plain>();
  if (!trip?.dispatchedAt) return [];
  const [consignments, docs] = await Promise.all([Consignment.find({ tripId: trip._id, status: { $ne: 'cancelled' } }).lean(), DriverDocument.find({ tripId: trip._id }).lean()]);
  const byStop = await legsByStopFor(trip, consignments as Plain[], docs as Plain[]);
  const stop = currentStop(trip.stops as Plain[]);
  if (!stop?.arrivedAt) return [];
  return (byStop.get(String(stop._id)) ?? []).flatMap((l) => ((l.send ?? []) as Plain[]).map((p) => ({
    consignmentId: String(l.consignmentId), legId: String(l.legId), documentTypeId: String(p.documentTypeId), label: String(p.label),
    number: String(l.number), party: l.party as string | undefined, kind: l.kind as 'pickup' | 'drop',
  })));
}

const numbered = (labels: string[]) => labels.map((l, i) => `${i + 1}. ${l}`).join('\n');
/** The same list on one line, for the template that reaches a driver after WhatsApp's 24 hours. */
const inline = (labels: string[]) => labels.map((l, i) => `${i + 1}. ${l}`).join(', ');

async function file(docId: unknown, due: Due, ctx: OpsContext) {
  const type = await ConsignmentDocumentType.findById(due.documentTypeId).select('driverKind').lean<Plain>();
  const kind = ['loading', 'delivery', 'pod', 'weighbridge', 'permit', 'eway'].includes(String(type?.driverKind)) ? String(type!.driverKind) : 'other';
  const doc = await DriverDocument.findByIdAndUpdate(docId, { $set: { consignmentId: due.consignmentId, legId: due.legId, documentTypeId: due.documentTypeId, kind }, $unset: { question: 1 } }, { new: true }).lean<Plain>();
  const what = `${due.label.toLowerCase()} for ${due.number}${due.party ? ` (${due.party})` : ''}`;
  if (doc) await post(driverThread(doc.driverId), new Date(), { text: `We got your ${what}. Operations will check it and tell you here.`, wa: { template: 'document_received', values: [what, 'Operations'] } }, ctx);
}

async function askWhich(docId: unknown, driverId: unknown, options: Due[], ctx: OpsContext) {
  await DriverDocument.updateOne({ _id: docId }, { $set: { question: { ask: 'consignment', at: new Date(), options: options.map((o) => ({ label: `${o.number}${o.party ? ` · ${o.party}` : ''}`, value: `${o.consignmentId}:${o.legId}:${o.documentTypeId}` })) } } });
  const labels = options.map((o) => `${o.number}${o.party ? ` · ${o.party}` : ''}`);
  await post(driverThread(driverId), new Date(), { text: `Which consignment is this ${options[0]!.label.toLowerCase()} for? Reply with the number.\n${numbered(labels)}`, wa: { template: 'which_consignment', values: [options[0]!.label.toLowerCase(), inline(labels)] } }, ctx);
}

/**
 * A photo just filed on the trip from WhatsApp (or the simulated phone): file it, or ask about it. `kind` is what
 * the sender said it is, when it said (the simulated phone does; a real WhatsApp photo is "other").
 */
export async function sortOutPhoto(doc: Plain, ctx: OpsContext) {
  if (!doc.tripId || doc.consignmentId || !doc.file) return;
  const step = doc.kind === 'loading' || doc.kind === 'weighbridge' ? 'pickup' : doc.kind === 'delivery' || doc.kind === 'pod' ? 'drop' : undefined;
  if (!step && doc.kind !== 'other') return; // a receipt or a fuel slip is Finance's, not a consignment's
  const due = (await dueHere(doc.tripId)).filter((d) => !step || d.kind === step);
  if (!due.length) return;
  if (due.length === 1) return file(doc.id ?? doc._id, due[0]!, ctx);
  const types = [...new Map(due.map((d) => [d.documentTypeId, d.label] as const)).entries()];
  if (types.length > 1) {
    await DriverDocument.updateOne({ _id: doc.id ?? doc._id }, { $set: { question: { ask: 'kind', at: new Date(), options: types.map(([value, label]) => ({ label, value })) } } });
    const labels = types.map(([, label]) => label);
    await post(driverThread(doc.driverId), new Date(), { text: `What is this photo? Reply with the number.\n${numbered(labels)}`, wa: { template: 'what_photo', values: [inline(labels)] } }, ctx);
    return;
  }
  return askWhich(doc.id ?? doc._id, doc.driverId, due, ctx);
}

/**
 * The driver's reply to the bot's last question about a photo: a number from the list, a consignment number, or the
 * paper's name. True when it was an answer; false leaves it to be filed as an ordinary message.
 */
export async function answerAboutPhoto(driverId: unknown, text: string | undefined, ctx: OpsContext): Promise<boolean> {
  const reply = text?.trim();
  if (!reply) return false;
  const doc = await DriverDocument.findOne({ driverId, status: 'new', 'question.at': { $exists: true } }).sort({ 'question.at': -1 }).lean<Plain>();
  const question = doc?.question as { ask: 'kind' | 'consignment'; options: Array<{ label: string; value: string }> } | undefined;
  if (!doc || !question) return false;
  const n = /^\d{1,2}$/.test(reply) ? Number(reply) : NaN;
  const chosen = Number.isInteger(n) && n >= 1 ? question.options[n - 1]
    : question.options.find((o) => o.label.toLowerCase().includes(reply.toLowerCase()) || reply.toLowerCase().includes(o.label.split(' · ')[0]!.toLowerCase()));
  if (!chosen) {
    // A number off the list is not filed as a message: the question is asked again.
    if (Number.isInteger(n)) {
      const labels = question.options.map((o) => o.label);
      if (question.ask === 'kind') await post(driverThread(driverId), new Date(), { text: `What is this photo? Reply with a number from 1 to ${labels.length}.\n${numbered(labels)}`, wa: { template: 'what_photo', values: [inline(labels)] } }, ctx);
      else await post(driverThread(driverId), new Date(), { text: `Which consignment is it for? Reply with a number from 1 to ${labels.length}.\n${numbered(labels)}`, wa: { template: 'which_consignment', values: ['paper', inline(labels)] } }, ctx);
      return true;
    }
    return false;
  }
  if (question.ask === 'kind') {
    const due = (await dueHere(doc.tripId)).filter((d) => d.documentTypeId === chosen.value);
    if (!due.length) { await DriverDocument.updateOne({ _id: doc._id }, { $unset: { question: 1 } }); return true; }
    if (due.length === 1) { await file(doc._id, due[0]!, ctx); return true; }
    await askWhich(doc._id, driverId, due, ctx);
    return true;
  }
  const [consignmentId, legId, documentTypeId] = chosen.value.split(':');
  const due = (await dueHere(doc.tripId)).find((d) => d.consignmentId === consignmentId && d.legId === legId && d.documentTypeId === documentTypeId);
  await file(doc._id, due ?? { consignmentId: consignmentId!, legId: legId!, documentTypeId: documentTypeId!, label: 'paper', number: chosen.label.split(' · ')[0]!, kind: 'pickup' }, ctx);
  return true;
}
