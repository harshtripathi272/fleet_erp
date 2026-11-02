import type { Plain } from '../../core/masters/types.js';
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
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: Date;
}

export interface Approval {
  policyId?: string;
  levels: ApprovalLevel[];
  /** Index of the level waiting to decide; equal to levels.length when fully approved. */
  current: number;
  requireReasonAboveBudget: boolean;
}

export type Measure = { amountMinor: number; currencyId: string } | { litres: number };

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
  const roles = new Map((await Role.find({ _id: { $in: applicable.map((l) => String(l.approverRoleId ?? '')).filter(Boolean) } }).select('key name').lean()).map((r) => [String(r._id), r]));
  const users = new Map((await User.find({ _id: { $in: applicable.map((l) => String(l.approverUserId ?? '')).filter(Boolean) } }).select('name').lean()).map((u) => [String(u._id), u]));
  return {
    policyId: String(policy._id),
    requireReasonAboveBudget: policy.requireReasonAboveBudget !== false,
    current: 0,
    levels: applicable.map((l) => {
      const role = l.approverRoleId ? roles.get(String(l.approverRoleId)) : undefined;
      const user = l.approverUserId ? users.get(String(l.approverUserId)) : undefined;
      return {
        level: Number(l.level),
        thread: user ? `user:${user._id}` : `role:${role?.key ?? 'owner'}`,
        label: String(user?.name ?? role?.name ?? 'Approver'),
        approverRoleKey: role ? String(role.key) : undefined,
        approverUserId: user ? String(user._id) : undefined,
        channels: (l.channels as string[] | undefined) ?? ['app'],
      };
    }),
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
}

export const waitingOn = (approval: Approval) => approval.levels[approval.current];

/**
 * Tells a level it has something to decide: a message in its thread, and on WhatsApp to each
 * approver with a phone when the level's channels include WhatsApp, with one-time answer buttons.
 */
export async function notifyLevel(level: ApprovalLevel, at: Date, message: Post, ctx: OpsContext) {
  await post(level.thread, at, message, ctx);
  if (!level.channels.includes('whatsapp')) return;
  const filter: Plain = level.approverUserId
    ? { _id: level.approverUserId }
    : { roleIds: { $in: (await Role.find({ key: level.approverRoleKey }).select('_id').lean()).map((r) => r._id) } };
  const people = await User.find({ ...filter, status: 'active', phone: { $exists: true } }).select('_id phone').lean();
  for (const person of people) await sendButtons(String(person._id), String(person.phone), message, (message.buttons ?? []) as MessageButton[]);
}
