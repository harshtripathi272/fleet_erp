import { Types } from 'mongoose';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import { getRefTarget } from '../../core/masters/registry.js';
import { serialize } from '../../core/masters/service.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { expiryState } from '../drivers/drivers.service.js';
import { Trailer } from '../fleet/models/trailer.model.js';
import { TrailerType } from '../fleet/models/trailerType.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { VehicleType } from '../fleet/models/vehicleType.model.js';
import * as S from './compliance.schema.js';
import { ComplianceDocument } from './models/complianceDocument.model.js';
import { BLOCKING, DocumentType, SUBJECT_KINDS } from './models/documentType.model.js';
import { COVERAGES, InsuranceType } from './models/insuranceType.model.js';
import { PermitType } from './models/permitType.model.js';

const DAY = 86400000;
const SUBJECT_TARGET: Record<string, string> = { vehicle: 'vehicles', trailer: 'trailers', driver: 'drivers', party: 'parties' };

export const documentTypeDefinition = defineMaster({
  key: 'document-types', label: 'Document types', singular: 'Document type', group: GROUPS.compliance,
  description: 'Any document a truck, trailer, driver, party or the company must hold: number format, issue/expiry, reminder days and what it blocks (dispatch, loading, border).',
  model: DocumentType, createSchema: S.createDocumentTypeSchema, updateSchema: S.updateDocumentTypeSchema,
  refs: [{ path: 'countryId', target: 'countries' }, { path: 'verifiedByRoleId', target: 'roles' }],
  immutable: ['appliesTo'],
  filters: {
    appliesTo: { schema: z.enum(SUBJECT_KINDS), apply: (v: string) => ({ appliesTo: v }), description: 'Which records hold it' },
    blocking: { schema: z.enum(BLOCKING), apply: (v: string) => ({ blocking: v }), description: 'What a missing document blocks' },
  },
  async prepare(data: Plain) {
    if (data.hasExpiryDate === false && data.reminderDaysBefore) throw new ValidationError('Reminders need an expiry date', { reminderDaysBefore: ['Remove, or set hasExpiryDate'] });
    return data;
  },
});

async function assertDocumentTypeFor(id: unknown, kinds: string[], field: string) {
  if (!id) return;
  const type = await DocumentType.findById(id).select('appliesTo').lean();
  if (type && !kinds.includes(String(type.appliesTo))) throw new ValidationError(`This document type is for ${type.appliesTo} records`, { [field]: [`Use a document type for ${kinds.join(' or ')}`] });
}

export const permitTypeDefinition = defineMaster({
  key: 'permit-types', label: 'Permit types', singular: 'Permit type', group: GROUPS.compliance,
  description: 'Road and cross-border permits: COMESA carrier licence, cross-border permit, abnormal load, dangerous goods.',
  model: PermitType, createSchema: S.createPermitTypeSchema, updateSchema: S.updatePermitTypeSchema,
  refs: [{ path: 'countryIds', target: 'countries' }, { path: 'documentTypeId', target: 'document-types' }],
  async prepare(data: Plain) {
    await assertDocumentTypeFor(data.documentTypeId, ['vehicle', 'trailer', 'driver'], 'documentTypeId');
    return data;
  },
});

export const insuranceTypeDefinition = defineMaster({
  key: 'insurance-types', label: 'Insurance types', singular: 'Insurance type', group: GROUPS.compliance,
  description: 'Kinds of cover: third party, comprehensive, goods in transit, COMESA Yellow Card, liability.',
  model: InsuranceType, createSchema: S.createInsuranceTypeSchema, updateSchema: S.updateInsuranceTypeSchema,
  refs: [{ path: 'countryIds', target: 'countries' }, { path: 'documentTypeId', target: 'document-types' }],
  filters: { coverage: { schema: z.enum(COVERAGES), apply: (v: string) => ({ coverage: v }), description: 'Coverage' } },
  async prepare(data: Plain) {
    await assertDocumentTypeFor(data.documentTypeId, ['vehicle', 'trailer', 'driver', 'company'], 'documentTypeId');
    return data;
  },
});

export const complianceDocumentDefinition = defineMaster({
  key: 'compliance-documents', label: 'Compliance documents', singular: 'Compliance document', group: GROUPS.compliance,
  description: 'Documents actually held: road tax, fitness, insurance, permits, licences. Shows valid / expiring / expired from the expiry date.',
  model: ComplianceDocument, createSchema: S.createComplianceDocumentSchema, updateSchema: S.updateComplianceDocumentSchema,
  searchFields: ['number', 'issuedBy'], sortFields: ['expiryDate', 'issueDate', 'number', 'createdAt', 'updatedAt'], defaultSort: 'expiryDate', titleField: 'number',
  refs: [
    { path: 'documentTypeId', target: 'document-types' }, { path: 'countryId', target: 'countries' },
    { path: 'subjectId', target: 'vehicles', usageOnly: true }, { path: 'subjectId', target: 'trailers', usageOnly: true },
    { path: 'subjectId', target: 'drivers', usageOnly: true }, { path: 'subjectId', target: 'parties', usageOnly: true },
  ],
  immutable: ['subjectKind', 'subjectId', 'documentTypeId'],
  filters: {
    subjectKind: { schema: z.enum(SUBJECT_KINDS), apply: (v: string) => ({ subjectKind: v }), description: 'Kind of holder' },
    subjectId: { schema: idQuery, apply: (v: string) => ({ subjectId: new Types.ObjectId(v) }), description: 'Documents of one holder' },
    documentTypeId: { schema: idQuery, apply: (v: string) => ({ documentTypeId: new Types.ObjectId(v) }), description: 'Document type' },
    expiringWithinDays: { schema: z.coerce.number().int().min(0).max(365), apply: (d: number) => ({ expiryDate: { $lte: new Date(Date.now() + d * DAY) } }), description: 'Expires within N days (or expired)' },
  },
  present: (doc: Plain) => ({ expiry: expiryState(doc.expiryDate) }),
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    const type = await DocumentType.findById(data.documentTypeId).lean();
    if (!type) throw new ValidationError('Document type not found', { documentTypeId: ['Not found'] });
    if (type.appliesTo !== data.subjectKind) errors.subjectKind = [`${type.name} is held by a ${type.appliesTo}, not a ${data.subjectKind}`];
    if (data.subjectKind === 'company') {
      const company = await Company.findOne().select('_id').lean();
      if (!company || String(company._id) !== String(data.subjectId)) errors.subjectId = ['Use the company id from GET /company'];
    } else {
      const target = getRefTarget(SUBJECT_TARGET[String(data.subjectKind)]!);
      if (!target || !(await target.model.exists({ _id: data.subjectId, status: 'active' }))) errors.subjectId = [`No active ${data.subjectKind} with this id`];
    }
    if (type.numberPattern && !new RegExp(String(type.numberPattern)).test(String(data.number))) errors.number = [`Does not match the ${type.name} number format`];
    if (type.hasExpiryDate && !data.expiryDate) errors.expiryDate = ['Required for this document type'];
    if (!type.hasExpiryDate && data.expiryDate) errors.expiryDate = ['This document type does not expire'];
    if (type.hasIssueDate === false && data.issueDate) errors.issueDate = ['This document type has no issue date'];
    const issue = data.issueDate as Date | undefined;
    const expiry = data.expiryDate as Date | undefined;
    if (issue && expiry && expiry <= issue) errors.expiryDate = ['Must be after the issue date'];
    if (issue && issue > new Date(Date.now() + DAY)) errors.issueDate = ['Cannot be in the future'];
    if (Object.keys(errors).length) throw new ValidationError('Document details are not valid', errors);
    return data;
  },
});

export async function expiring(query: S.ExpiringQuery) {
  const filter: Plain = { status: 'active', expiryDate: { $lte: new Date(Date.now() + query.withinDays * DAY) } };
  if (query.subjectKind) filter.subjectKind = query.subjectKind;
  const rows = await ComplianceDocument.find(filter).sort({ expiryDate: 1 }).limit(query.limit).lean();
  return rows.map((row) => serialize(complianceDocumentDefinition, row as Plain));
}

/** Which documents a truck, trailer or driver needs, and the state of each. */
export async function check(query: S.CheckQuery) {
  let typeIds: unknown[] = [];
  if (query.subjectKind === 'vehicle') {
    const vehicle = await Vehicle.findById(query.subjectId).select('vehicleTypeId').lean();
    if (!vehicle) throw new NotFoundError('Vehicle not found');
    typeIds = ((await VehicleType.findById(vehicle.vehicleTypeId).select('requiredDocumentTypeIds').lean())?.requiredDocumentTypeIds ?? []) as unknown[];
  } else if (query.subjectKind === 'trailer') {
    const trailer = await Trailer.findById(query.subjectId).select('trailerTypeId').lean();
    if (!trailer) throw new NotFoundError('Trailer not found');
    typeIds = ((await TrailerType.findById(trailer.trailerTypeId).select('requiredDocumentTypeIds').lean())?.requiredDocumentTypeIds ?? []) as unknown[];
  } else {
    const target = getRefTarget('drivers');
    if (!target || !(await target.model.exists({ _id: query.subjectId }))) throw new NotFoundError('Driver not found');
  }
  const types = await DocumentType.find({ status: 'active', appliesTo: query.subjectKind, $or: [{ _id: { $in: typeIds } }, { requiredForAll: true }] }).sort({ code: 1 }).lean();
  const docs = await ComplianceDocument.find({ subjectId: query.subjectId, status: 'active', documentTypeId: { $in: types.map((t) => t._id) } }).sort({ expiryDate: -1 }).lean();
  const items = types.map((type) => {
    const doc = docs.find((d) => String(d.documentTypeId) === String(type._id));
    const state = !doc ? { state: 'missing' as const, daysLeft: null } : type.hasExpiryDate ? expiryState(doc.expiryDate) : { state: 'valid' as const, daysLeft: null };
    return { documentTypeId: String(type._id), code: type.code, name: type.name, blocking: type.blocking, documentId: doc ? String(doc._id) : null, number: doc?.number ?? null, expiryDate: doc?.expiryDate ?? null, ...state };
  });
  const blockers = items.filter((i) => (i.state === 'missing' || i.state === 'expired') && i.blocking !== 'none');
  return { subjectKind: query.subjectKind, subjectId: query.subjectId, compliant: !items.some((i) => i.state === 'missing' || i.state === 'expired'), blocking: blockers.map((b) => ({ code: b.code, blocks: b.blocking, state: b.state })), items };
}

export const masters: MasterDefinition[] = [documentTypeDefinition, permitTypeDefinition, insuranceTypeDefinition, complianceDocumentDefinition];
