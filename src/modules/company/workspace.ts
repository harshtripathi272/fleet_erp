import { z } from 'zod';
import { Company } from './company.model.js';
import { areasOn } from './areas.js';

/**
 * The company's own words, stages and desks (#73). The code names things one way (a "trip", the "Finance" desk);
 * a company that says "job" or "load", skips funding, or wants a "Workshop" desk changes it here, with no code
 * change. Only the company's changes are stored; everything else comes from the defaults below.
 */

/** The app's core terms: what the screens, documents and e-mails call things. */
export const TERMS = {
  trip: ['Trip', 'Trips'],
  nomination: ['Nomination', 'Nominations'],
  driver: ['Driver', 'Drivers'],
  truck: ['Truck', 'Trucks'],
  trailer: ['Trailer', 'Trailers'],
  customer: ['Customer', 'Customers'],
  advance: ['Cash advance', 'Cash advances'],
  fuelRequest: ['Fuel request', 'Fuel requests'],
  expense: ['Expense', 'Expenses'],
  settlement: ['Settlement', 'Settlements'],
  statement: ['Statement', 'Statements'],
  tripSheet: ['Trip sheet', 'Trip sheets'],
} as const satisfies Record<string, readonly [string, string]>;
export type Term = keyof typeof TERMS;
export const TERM_KEYS = Object.keys(TERMS) as [Term, ...Term[]];

/** The stages the desks walk a trip through, in their physical order. `optional` ones a company can switch off. */
export const STAGES = [
  { key: 'plan', name: 'Plan' },
  { key: 'funding', name: 'Funding', optional: true, area: 'finance' },
  { key: 'loading', name: 'Loading' },
  { key: 'transit', name: 'Transit' },
  { key: 'offloading', name: 'Offloading' },
  { key: 'close', name: 'Close' },
  { key: 'settle', name: 'Settlement', optional: true, area: 'finance' },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];
export const STAGE_KEYS = STAGES.map((s) => s.key) as [StageKey, ...StageKey[]];

/** The screens a desk can show, and the area each needs. */
export const VIEWS = [
  { key: 'overview', name: 'Overview' },
  { key: 'today', name: 'Approvals', area: 'finance' },
  { key: 'trips', name: 'Trips', area: 'trips' },
  { key: 'nominations', name: 'Nominations', area: 'trips' },
  { key: 'accounts', name: 'Driver accounts', area: 'finance' },
  { key: 'billing', name: 'Billing', area: 'billing' },
  { key: 'maintenance', name: 'Maintenance', area: 'maintenance' },
  { key: 'masters', name: 'Masters' },
] as const;
export type ViewKey = (typeof VIEWS)[number]['key'];
export const VIEW_KEYS = VIEWS.map((v) => v.key) as [ViewKey, ...ViewKey[]];

export const DESK_ICONS = ['gauge', 'grid', 'wallet', 'wrench', 'truck', 'clipboard', 'users', 'map'] as const;

/** Today's desks: who sees each is decided by permissions (`kind`), unless the company names roles. */
export const DEFAULT_DESKS = [
  { key: 'owner', name: 'Overview and approvals', icon: 'gauge', views: ['overview', 'trips', 'nominations', 'accounts', 'maintenance', 'billing', 'masters'], kind: 'owner' },
  { key: 'operations', name: 'Operations', icon: 'grid', views: ['trips', 'nominations', 'accounts', 'maintenance', 'masters'], kind: 'operations' },
  { key: 'finance', name: 'Finance', icon: 'wallet', views: ['today', 'trips', 'accounts', 'billing', 'masters'], kind: 'finance' },
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
export const workspaceInput = {
  vocabulary: z.partialRecord(z.enum(TERM_KEYS), z.strictObject({ singular: text(40), plural: text(40) })).optional(),
  stages: z.partialRecord(z.enum(STAGE_KEYS), z.strictObject({ name: text(40).optional(), off: z.boolean().optional() })).optional(),
  desks: z.array(z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    name: text(50),
    icon: z.enum(DESK_ICONS),
    views: z.array(z.enum(VIEW_KEYS)).min(1).max(VIEW_KEYS.length),
    /** Who sees the desk: the permission-based default for the built-in desks, or the roles named here. */
    kind: z.enum(['owner', 'operations', 'finance', 'roles']),
    roleKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)).max(50).optional(),
    /** For a desk the company adds: which built-in desk's queues and "Needs me" it follows. */
    actsAs: z.enum(['owner', 'operations', 'finance']).optional(),
  })).max(12).refine((d) => new Set(d.map((x) => x.key)).size === d.length, 'Desk keys must be unique').optional(),
};

type Stored = { vocabulary?: Record<string, { singular: string; plural: string }>; stages?: Record<string, { name?: string; off?: boolean }>; desks?: Array<Record<string, unknown>> };

/** The words, stages and desks this company uses: its changes over the defaults, with areas that are off taken out. */
export async function workspace(source?: { company: Stored | null; on: Set<string> }) {
  // Fleet Studio (#133) passes the profile being written and its areas: it has no database.
  const company = source ? source.company : await Company.findOne().select('vocabulary stages desks').lean<Stored>();
  const on = source ? source.on : await areasOn();
  const words = Object.fromEntries(TERM_KEYS.map((k) => {
    const own = company?.vocabulary?.[k];
    return [k, { singular: own?.singular ?? TERMS[k][0], plural: own?.plural ?? TERMS[k][1] }];
  })) as Record<Term, { singular: string; plural: string }>;
  const stages = STAGES.map((s) => {
    const own = company?.stages?.[s.key];
    const areaOff = 'area' in s && !on.has(s.area);
    const optional = 'optional' in s && s.optional;
    // `switchedOff` is the company's own choice, kept apart from an area being off, so the settings screen shows both.
    return { key: s.key, name: own?.name ?? s.name, defaultName: s.name, optional, on: !areaOff && !(own?.off && optional), switchedOff: Boolean(own?.off && optional), areaOff, area: 'area' in s ? s.area : undefined };
  });
  const views = VIEWS.filter((v) => !('area' in v) || on.has(v.area)).map((v) => v.key as string);
  const setup = (company?.desks?.length ? company.desks : DEFAULT_DESKS) as Array<{ key: string; name: string; icon: string; views: string[]; kind: string; roleKeys?: string[]; actsAs?: string }>;
  const desks = setup
    .map((d) => ({ ...d, actsAs: d.kind === 'roles' ? d.actsAs ?? 'operations' : d.kind, views: d.views.filter((v) => views.includes(v)) }))
    .filter((d) => d.views.length > 0);
  return {
    words,
    stages,
    desks,
    views: VIEWS.map((v) => ({ key: v.key, name: v.name, on: views.includes(v.key), area: 'area' in v ? v.area : undefined })),
    icons: DESK_ICONS,
    // For the settings screen: the defaults, and the desks as the company set them, before areas that are off took screens out.
    terms: Object.fromEntries(TERM_KEYS.map((k) => [k, { singular: TERMS[k][0], plural: TERMS[k][1] }])),
    deskSetup: setup,
    defaultDesks: DEFAULT_DESKS,
    customised: { vocabulary: Object.keys(company?.vocabulary ?? {}).length > 0, stages: Object.keys(company?.stages ?? {}).length > 0, desks: Boolean(company?.desks?.length) },
  };
}

/** Every term as the company says it, for an app that needs only the words (the driver's phone). */
export async function words() {
  const company = await Company.findOne().select('vocabulary').lean<Stored>();
  return Object.fromEntries(TERM_KEYS.map((k) => {
    const own = company?.vocabulary?.[k];
    return [k, { singular: own?.singular ?? TERMS[k][0], plural: own?.plural ?? TERMS[k][1] }];
  })) as Record<Term, { singular: string; plural: string }>;
}

/** One term as the company says it, for server text (PDF titles, e-mail subjects). */
export async function word(term: Term, plural = false) {
  const company = await Company.findOne().select('vocabulary').lean<Stored>();
  const own = company?.vocabulary?.[term];
  return plural ? own?.plural ?? TERMS[term][1] : own?.singular ?? TERMS[term][0];
}
