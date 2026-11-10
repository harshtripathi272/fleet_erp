/**
 * Permission resources of the trip and money areas. Each is checked with the usual actions:
 * `create` to do the thing, `update` to change or cancel it, `read` to see it.
 */
export const OPERATIONS_RESOURCES = [
  'nominations',
  'trips',
  'vehicle-states',
  'fund-requests',
  /** Approving money requests when the company has no approval policy for them. */
  'fund-approvals',
  /** Paying out or issuing an approved request. */
  'payments',
  'driver-documents',
  'consignments',
  /**
   * A consignment's rates and revenue, and a trip's profit (#135). Seeing them is the area's sensitive switch, so a
   * role that sees everything else (Operations, Viewer) does not see money until the owner allows it.
   */
  'consignment-revenue',
  'trip-profit',
  /** Recording a pickup that puts the truck over its capacity, and letting a truck pass a stop that holds it. */
  'capacity-override',
  'stop-gate-override',
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
  'consignment-revenue', 'trip-profit', 'fund-approvals', 'payments', 'driver-documents', 'shortage-decisions', 'expenses', 'expense-approvals', 'settlements', 'messages',
];
