import { z } from 'zod';
import { baseShape, code, idList, integer, isoDate, name, objectId, regexText, text, toUpdateSchema } from '../../core/masters/zod.js';
import { BLOCKING, SUBJECT_KINDS } from './models/documentType.model.js';
import { COVERAGES } from './models/insuranceType.model.js';

export const documentTypeShape = {
  code, name, description: text(500).optional(),
  appliesTo: z.enum(SUBJECT_KINDS),
  countryId: objectId.optional(),
  numberPattern: regexText.optional(),
  hasIssueDate: z.boolean().optional(),
  hasExpiryDate: z.boolean().optional(),
  reminderDaysBefore: integer(0, 365).optional(),
  blocking: z.enum(BLOCKING).optional(),
  requiredForAll: z.boolean().optional(),
  verifiedByRoleId: objectId.optional(),
  ...baseShape,
};

export const permitTypeShape = {
  code, name, description: text(500).optional(),
  issuingAuthority: text(120).optional(),
  countryIds: idList(60).pipe(z.array(z.string()).min(1, 'Name at least one country')),
  validityDays: integer(1, 3650).optional(),
  documentTypeId: objectId.optional(),
  ...baseShape,
};

export const insuranceTypeShape = {
  code, name, description: text(500).optional(),
  coverage: z.enum(COVERAGES),
  countryIds: idList(60).optional(),
  documentTypeId: objectId.optional(),
  ...baseShape,
};

export const complianceDocumentShape = {
  documentTypeId: objectId,
  subjectKind: z.enum(SUBJECT_KINDS),
  subjectId: objectId,
  number: z.string().trim().toUpperCase().min(1).max(60),
  issueDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  issuedBy: text(120).optional(),
  countryId: objectId.optional(),
  ...baseShape,
};

export const createDocumentTypeSchema = z.strictObject(documentTypeShape);
export const updateDocumentTypeSchema = toUpdateSchema(documentTypeShape);
export const createPermitTypeSchema = z.strictObject(permitTypeShape);
export const updatePermitTypeSchema = toUpdateSchema(permitTypeShape);
export const createInsuranceTypeSchema = z.strictObject(insuranceTypeShape);
export const updateInsuranceTypeSchema = toUpdateSchema(insuranceTypeShape);
export const createComplianceDocumentSchema = z.strictObject(complianceDocumentShape);
export const updateComplianceDocumentSchema = toUpdateSchema(complianceDocumentShape);

export const expiringQuerySchema = z.strictObject({
  withinDays: z.coerce.number().int().min(0).max(365).default(30),
  subjectKind: z.enum(SUBJECT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const checkQuerySchema = z.strictObject({ subjectKind: z.enum(['vehicle', 'trailer', 'driver']), subjectId: objectId });
export type ExpiringQuery = z.infer<typeof expiringQuerySchema>;
export type CheckQuery = z.infer<typeof checkQuerySchema>;
