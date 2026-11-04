import { env } from '../../config/env.js';
import type { Plain } from '../../core/masters/types.js';
import { notifyPerson } from '../messaging/dispatcher.js';
import { ApprovalPolicy } from '../organisation/models/approvalPolicy.model.js';
import { Role } from '../roles/role.model.js';
import { User } from '../users/user.model.js';
import { sendButtons } from './actionTokens.js';
import { convertTo, post, type MessageButton, type OpsContext, type Post } from './support.js';

/**
 * Who approves what comes from the company's `approval-policies`: levels by amount (or litres for fuel),
 * each naming a role or a person. Without a policy for a subject, one approval by anyone holding the
 * area's approve permission is needed. Nothing about who approves is fixed in code.
 */
export type Subject = 'fuel_request' | 'cash_advance' | 'expense' | 'shortage_waiver' | 'settlement';

/** The permission that approves a subject when the company has no policy for it. */
const FALLBACK: Record<Subject, string> = {
  fuel_request: 'fund-approvals', cash_advance: 'fund-approvals', expense: 'expense-approvals', shortage_waiver: 'shortage-decisions', settlement: 'settlements',
};

export interface ApprovalLevel {
  level: number;
  /** Where its messages go: role:<key>, user:<id>, or queue:<permission> without a policy. */
  thread: string;
  label: string;
  approverRoleKey?: string;
  approverUserId?: string;
  fallbackResource?: string;
  channels: string[];
  /** Hours this level has to decide before the request moves up. */
  escalateAfterHours?: number;
  /** Set when the request moved past this level because nobody here decided in time. */
  escalatedAt?: Date;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: Date;
}

export interface Approval {
  policyId?: string;
  levels: ApprovalLevel[];
  /** Index of the level waiting to decide; equal to levels.length when fully approved. */
  current: number;
  /** When the waiting level's time is up; absent when it may wait for as long as it takes. */
  escalateAt?: Date;
  requireReasonAboveBudget: boolean;
}

export type Measure = { amountMinor: number; currencyId: string } | { litres: number };

const dueAt = (level: ApprovalLevel | undefined, from: Date) => (level?.escalateAfterHours ? new Date(from.getTime() + level.escalateAfterHours * 3_600_000) : undefined);

/** A policy's levels as an item keeps them: the people and channels at the time. */
async function snapshot(levels: Plain[]): Promise<ApprovalLevel[]> {
  const roles = new Map((await Role.find({ _id: { $in: levels.map((l) => String(l.approverRoleId ?? '')).filter(Boolean) } }).select('key name').lean()).map((r) => [String(r._id), r]));
  const users = new Map((await User.find({ _id: { $in: levels.map((l) => String(l.approverUserId ?? '')).filter(Boolean) } }).select('name').lean()).map((u) => [String(u._id), u]));
  return levels.map((l) => {
    const role = l.approverRoleId ? roles.get(String(l.approverRoleId)) : undefined;
    const user = l.approverUserId ? users.get(String(l.approverUserId)) : undefined;
    return {
      level: Number(l.level),
      thread: user ? `user:${user._id}` : `role:${role?.key ?? 'owner'}`,
      label: String(user?.name ?? role?.name ?? 'Approver'),
      approverRoleKey: role ? String(role.key) : undefined,
      approverUserId: user ? String(user._id) : undefined,
      channels: (l.channels as string[] | undefined) ?? ['app'],
      escalateAfterHours: l.escalateAfterHours as number | undefined,
    };
  });
}

/** The levels an item needs: those whose threshold it reaches, or all of them above budget when the policy says so. */
export async function routeApproval(subject: Subject, value: Measure, aboveBudget = false): Promise<Approval> {
  const policies = await ApprovalPolicy.find({ subject, status: 'active' }).lean();
  const money = 'amountMinor' in value ? value : undefined;
  const policy = (money && policies.find((p) => String(p.currencyId) === money.currencyId)) ?? policies[0];
  if (!policy) {
    const resource = FALLBACK[subject];
    return { levels: [{ level: 1, thread: `queue:${resource}`, label: `Anyone who can approve (${resource})`, fallbackResource: resource, channels: ['app'] }], current: 0, requireReasonAboveBudget: true };
  }
  const amountInPolicy = money ? (String(policy.currencyId) === money.currencyId ? money.amountMinor : await convertTo(money.amountMinor, money.currencyId, policy.currencyId)) : 0;
  const levels = (policy.levels as Plain[]).slice().sort((a, b) => Number(a.level) - Number(b.level));
  const reached = (l: Plain) => (l.measure === 'litres' ? ('litres' in value ? value.litres : 0) : amountInPolicy) >= Number(l.minAmountMinor);
  let applicable = aboveBudget && policy.escalateAboveBudget !== false ? levels : levels.filter(reached);
  if (!applicable.length) applicable = levels.slice(0, 1);
  const chain = await snapshot(applicable);
  return {
    policyId: String(policy._id),
    requireReasonAboveBudget: policy.requireReasonAboveBudget !== false,
    current: 0,
    levels: chain,
    escalateAt: dueAt(chain[0], new Date()),
  };
}

function eligible(ctx: OpsContext, level: ApprovalLevel) {
  if (level.fallbackResource) return ctx.can(level.fallbackResource, 'create');
  if (level.approverUserId) return ctx.actorId === level.approverUserId;
  return Boolean(level.approverRoleKey && ctx.roles.includes(level.approverRoleKey));
}

/** The highest level from the waiting one up that this person may decide; -1 when none. A senior approver may act for the levels below. */
export function highestEligible(ctx: OpsContext, approval: Approval) {
  for (let i = approval.levels.length - 1; i >= approval.current; i -= 1) if (eligible(ctx, approval.levels[i]!)) return i;
  return -1;
}

/** May this person take the final decision (approve every remaining level at once)? */
export const mayDecideAll = (ctx: OpsContext, approval: Approval) => approval.levels.length > 0 && eligible(ctx, approval.levels.at(-1)!);

/** Records approval by this person for every level up to the highest they may decide. */
export function approveAs(ctx: OpsContext, approval: Approval, upTo: number, at: Date) {
  for (let i = approval.current; i <= upTo; i += 1) Object.assign(approval.levels[i]!, { decidedBy: ctx.actorId, decidedByName: ctx.name, decidedAt: at });
  approval.current = upTo + 1;
  // The next level gets its full time, counted from now.
  approval.escalateAt = dueAt(waitingOn(approval), at);
}

export const waitingOn = (approval: Approval) => approval.levels[approval.current];

/**
 * Moves an approval past a level that did not decide in time, to the next one up. That is the next in
 * its chain or, when the amount only needed this level, the next in the policy. Without one, nothing
 * moves and the result is undefined: there is nobody above.
 */
export async function moveUp(approval: Approval, at: Date) {
  const from = waitingOn(approval)!;
  let to = approval.levels[approval.current + 1];
  if (!to) {
    const policy = approval.policyId ? await ApprovalPolicy.findOne({ _id: approval.policyId, status: 'active' }).lean() : null;
    const above = ((policy?.levels ?? []) as Plain[]).filter((l) => Number(l.level) > from.level).sort((a, b) => Number(a.level) - Number(b.level))[0];
    if (!above) return undefined;
    [to] = await snapshot([above]);
    approval.levels.push(to!);
  }
  from.escalatedAt = at;
  approval.current += 1;
  approval.escalateAt = dueAt(to, at);
  return { from, to: to! };
}

/** SMS and e-mail have no answer buttons: they say what is waiting and where to decide it. */
function outsideTheApp(message: Post, channel: 'sms' | 'email') {
  const lines = [message.text, ...(message.rows ?? []).map(([name, value]) => `${name}: ${value}`)].filter(Boolean);
  const where = `Open the app to decide: ${env.APP_URL}`;
  return channel === 'email' ? `${lines.join('\n')}\n\n${where}` : `${[message.title, ...lines].join('. ').slice(0, 240)}. ${where}`;
}

/**
 * Tells a level it has something to decide: always a message in its thread in the app, then on each
 * channel the level names, to each of its approvers. WhatsApp carries one-time answer buttons. SMS and
 * e-mail go through the messaging connections and show in the outbox, like every other message.
 */
export async function notifyLevel(level: ApprovalLevel, at: Date, message: Post, ctx: OpsContext, kind: 'fund-requests' | 'expenses') {
  await post(level.thread, at, message, ctx);
  if (!level.channels.some((c) => c !== 'app')) return;
  const filter: Plain = level.approverUserId
    ? { _id: level.approverUserId }
    : { roleIds: { $in: (await Role.find({ key: level.approverRoleKey }).select('_id').lean()).map((r) => r._id) } };
  const people = await User.find({ ...filter, status: 'active' }).select('_id name phone email').lean();
  for (const person of people) {
    for (const channel of ['sms', 'email'] as const) {
      if (!level.channels.includes(channel)) continue;
      await notifyPerson({
        event: 'approval.waiting', channel, recipient: { name: String(person.name), email: person.email as string | undefined, phone: person.phone as string | undefined },
        subject: message.title, body: outsideTheApp(message, channel), ref: message.refId ? { kind, id: message.refId } : undefined, actorId: ctx.actorId,
      });
    }
    if (level.channels.includes('whatsapp') && person.phone) await sendButtons(String(person._id), String(person.phone), message, (message.buttons ?? []) as MessageButton[]);
  }
}
