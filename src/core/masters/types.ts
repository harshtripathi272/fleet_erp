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
  /** Columns the list shows after the title and code; screens choose their own when omitted. */
  columns?: string[];
  filters?: Record<string, FilterSpec>;
  refs?: RefSpec[];
  /** Fields never returned by the API. */
  hidden?: string[];
  /** Names for fields whose key doesn't read well on screen ("levels.minAmountMinor" → "Applies from"); others are named from their key. */
  labels?: Record<string, string>;
  /** The area of the business this master belongs to (#56); while the company has it off, the master is hidden and refuses. */
  module?: string;
  /** Fields the app's logic reads beyond the required ones: a company may rename and move them but not hide them (#65). */
  fixedFields?: string[];
  /** Choice lists the app acts on: a company may rename and reorder their values but not retire them (#65). */
  lockedChoices?: string[];
  /** Names for a choice field's stored values ({ event: { "trip.loaded": "A truck is loaded" } }); values without one are named from the value. */
  choiceLabels?: Record<string, Record<string, string>>;
  /** One line under a field saying what to put in it, where its name alone doesn't ("{SEQ} is the running number"). */
  hints?: Record<string, string>;
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
