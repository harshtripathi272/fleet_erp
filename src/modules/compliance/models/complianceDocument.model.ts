import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';
import { SUBJECT_KINDS } from './documentType.model.js';

/** A licence, permit, certificate or policy held by a truck, trailer, driver, party or the company. */
const complianceDocumentSchema = masterSchema({
  documentTypeId: { type: ObjectId, ref: 'DocumentType', required: true, index: true },
  subjectKind: { type: String, enum: SUBJECT_KINDS, required: true },
  subjectId: { type: ObjectId, required: true },
  number: { type: String, required: true },
  issueDate: Date,
  expiryDate: Date,
  issuedBy: String,
  countryId: { type: ObjectId, ref: 'Country' },
});
complianceDocumentSchema.index({ subjectKind: 1, subjectId: 1 });
complianceDocumentSchema.index({ expiryDate: 1 });
complianceDocumentSchema.index({ documentTypeId: 1, subjectId: 1, number: 1 }, { unique: true });

export const ComplianceDocument = masterModel('ComplianceDocument', complianceDocumentSchema);
