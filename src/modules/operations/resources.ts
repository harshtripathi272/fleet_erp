/**
 * Permission resources of the trip and money areas. Each is checked with the usual actions:
 * `create` to do the thing, `update` to change or cancel it, `read` to see it.
 */
export const OPERATIONS_RESOURCES = [
  'nominations',
  'trips',
  'vehicle-states',
  'fund-requests',
  /** Finance approval of a money request. */
  'fund-approvals',
  /** Second approval when a request is above the trip budget (Owner and Admin by default). */
  'owner-approvals',
  /** Paying out or issuing an approved request. */
  'payments',
  'driver-documents',
  'consignments',
  'shortage-decisions',
  'expenses',
  'expense-approvals',
  'settlements',
  'settlement-requests',
  'messages',
  'activity',
] as const;

export type OperationsResource = (typeof OPERATIONS_RESOURCES)[number];

/** What the built-in Operations and Finance roles may create and update. */
export const OPERATIONS_DESK: OperationsResource[] = [
  'nominations', 'trips', 'vehicle-states', 'fund-requests', 'driver-documents', 'consignments', 'expenses', 'settlement-requests', 'messages',
];
export const FINANCE_DESK: OperationsResource[] = [
  'fund-approvals', 'payments', 'driver-documents', 'shortage-decisions', 'expenses', 'expense-approvals', 'settlements', 'messages',
];
