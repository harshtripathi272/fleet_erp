import type { Model } from 'mongoose';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { moveUp, type Approval, type ApprovalLevel } from './approvals.js';
import { askExpenseLevel } from './expenses.service.js';
import { askLevel } from './funding.service.js';
import { FundRequest } from './models/funding.model.js';
import { Expense } from './models/money.model.js';
import { Trip } from './models/trip.model.js';
import { log, resolve, type OpsContext } from './support.js';

/**
 * A level that does not decide within its `escalateAfterHours` loses the request to the next level up.
 * Fuel requests, advances and expenses wait level by level. Shortage waivers and settlements don't:
 * they go straight to the policy's last level, so they have nowhere further to move.
 */

/** Nobody acted: with no user id, the audit log shows these as "System". The activity feed needs a desk, so they sit at the owner's. */
const SYSTEM: OpsContext = { name: 'System', desk: 'owner', can: () => false, roles: [] };
const BATCH = 50;

const hours = (n: number | undefined) => `${n} hour${n === 1 ? '' : 's'}`;
const lateNote = (from: ApprovalLevel) => `${from.label} did not decide within ${hours(from.escalateAfterHours)}.`;

/**
 * Takes the move: only one run can, and a decision saved meanwhile wins, since either changes the version.
 * Returns the moved record and its two levels, or undefined when nothing moved.
 */
async function move(model: Model<any>, doc: Plain, now: Date, trail?: (from: ApprovalLevel, to: ApprovalLevel) => Plain) {
  const approval = doc.approval as Approval;
  const step = await moveUp(approval, now);
  if (!step) {
    // Nobody above: it stays here, and the job stops looking at it.
    await model.updateOne({ _id: doc._id, version: doc.version }, { $unset: { 'approval.escalateAt': 1 } });
    return undefined;
  }
  const moved = await model.findOneAndUpdate(
    { _id: doc._id, version: doc.version, status: 'pending' },
    { $set: { approval }, $inc: { version: 1 }, ...(trail ? { $push: { trail: trail(step.from, step.to) } } : {}) },
    { returnDocument: 'after' },
  ).lean() as Plain | null;
  return moved ? { moved, ...step } : undefined;
}

async function escalateRequest(doc: Plain, now: Date) {
  const done = await move(FundRequest, doc, now, (from, to) => ({ desk: SYSTEM.desk, name: SYSTEM.name, what: 'escalated', at: now, note: `${lateNote(from)} Now with ${to.label}.`, via: 'app' }));
  if (!done) return false;
  const { moved, from, to } = done;
  await resolve(String(moved._id), `Moved to ${to.label}: no decision within ${hours(from.escalateAfterHours)}`);
  const trip = await Trip.findById(moved.tripId).lean() as Plain;
  await askLevel(moved, trip, SYSTEM, now, lateNote(from));
  await log(SYSTEM, now, `${moved.number} moved from ${from.label} to ${to.label}: no decision within ${hours(from.escalateAfterHours)}`, { tripId: moved.tripId });
  return true;
}

async function escalateExpense(doc: Plain, now: Date) {
  const done = await move(Expense, doc, now);
  if (!done) return false;
  const { moved, from, to } = done;
  await resolve(String(moved._id), `Moved to ${to.label}: no decision within ${hours(from.escalateAfterHours)}`);
  await askExpenseLevel(moved, lateNote(from), SYSTEM, now);
  await log(SYSTEM, now, `${moved.number} moved from ${from.label} to ${to.label}: no decision within ${hours(from.escalateAfterHours)}`, { tripId: moved.tripId, entity: 'expenses', entityId: moved._id });
  return true;
}

/** Moves up what has waited too long. Returns how many moved; one that fails is logged and the rest still go. */
export async function escalateDue(now = new Date()): Promise<number> {
  let count = 0;
  for (const [model, escalate] of [[FundRequest, escalateRequest], [Expense, escalateExpense]] as const) {
    const due = await model.find({ status: 'pending', 'approval.escalateAt': { $lte: now } }).sort({ 'approval.escalateAt': 1 }).limit(BATCH).lean() as Plain[];
    for (const doc of due) {
      try {
        if (await escalate(doc, now)) count += 1;
      } catch (err) {
        logger.error({ err, id: String(doc._id) }, 'A request could not be moved up');
      }
    }
  }
  return count;
}

let worker: NodeJS.Timeout | undefined;
/** Runs escalateDue every `intervalMs` in this process. Safe on several instances: each move is taken once. */
export function startEscalationWorker(intervalMs = 60_000) {
  if (worker) return;
  worker = setInterval(() => { escalateDue().catch((err) => logger.error({ err }, 'Escalation worker failed')); }, intervalMs);
  worker.unref();
}
export function stopEscalationWorker() { if (worker) clearInterval(worker); worker = undefined; }
