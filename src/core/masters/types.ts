import type { Model } from 'mongoose';
import type { Router } from 'express';
import type { z } from 'zod';

export type Action = 'read' | 'create' | 'update' | 'archive' | 'delete' | 'sensitive';
export const ACTIONS: Action[] = ['read', 'create', 'update', 'archive', 'delete', 'sensitive'];

export type Plain = Record<string, unknown>;

/** A field that points at another record. `path` may cross arrays, e.g. "stops.placeId". */
export interface RefSpec {
  path: string;
  target: string;
  /** Party roles the referenced party must hold. */
  partyRoles?: string[];
  /** Polymorphic link: counted for usage, but existence is checked by the master itself. */
  usageOnly?: boolean;
}

export interface MasterContext {
  mode: 'create' | 'update';
  actorId?: string;
  requestId?: string;
  id?: string;
  existing?: Plain;
}

export interface FilterSpec {
  schema: z.ZodType;
  apply: (value: never) => Plain;
  description: string;
}

export interface MasterDefinition {
  key: string;
  label: string;
  singular: string;
  group: string;
  description: string;
  model: Model<any>;
  createSchema: z.ZodObject;
  updateSchema: z.ZodType;
  searchFields: string[];
  sortFields: string[];
  defaultSort?: string;
  titleField?: string;
  filters?: Record<string, FilterSpec>;
  refs?: RefSpec[];
  /** Fields never returned by the API. */
  hidden?: string[];
  /** Paths masked unless the caller holds the "sensitive" permission. */
  sensitive?: string[];
  /** Fields that cannot change after creation. */
  immutable?: string[];
  /** Codes are generated from the numbering series when omitted. */
  autoCode?: boolean;
  customFields?: boolean;
  /** Generic create/update/delete are replaced by custom endpoints. */
  managed?: { create?: boolean; update?: boolean; delete?: boolean; archive?: boolean };
  /** Business rules on the full candidate record; may return computed fields. */
  prepare?: (data: Plain, ctx: MasterContext) => Promise<Plain | void>;
  beforeArchive?: (doc: Plain, ctx: MasterContext) => Promise<void>;
  beforeDelete?: (doc: Plain, ctx: MasterContext) => Promise<void>;
  /** Extra read-time fields, e.g. expiry state. */
  present?: (doc: Plain) => Plain;
  router?: Router;
}
