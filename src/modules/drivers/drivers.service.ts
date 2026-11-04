import { Types } from 'mongoose';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { boolQuery, idQuery } from '../../core/masters/query.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { VehicleType } from '../fleet/models/vehicleType.model.js';
import { Country } from '../geography/models/country.model.js';
import * as S from './drivers.schema.js';
import { Driver } from './models/driver.model.js';
import { LicenceClass } from './models/licenceClass.model.js';
import { RECOVERY_KINDS, RecoveryRule } from './models/recoveryRule.model.js';

const DAY = 86400000;
const EXPIRY_WARNING_DAYS = 30;
const byId = (field: string) => ({ schema: idQuery, apply: (v: string) => ({ [field]: new Types.ObjectId(v) }), description: `Only records with this ${field}` });
const push = (errors: Record<string, string[]>, key: string, message: string) => { (errors[key] ??= []).push(message); };

export const licenceClassDefinition = defineMaster({
  key: 'licence-classes', label: 'Licence classes', singular: 'Licence class', group: GROUPS.drivers,
  description: 'What a driving licence allows, per country (e.g. C1, EC). Vehicle types list the classes allowed to drive them.',
  model: LicenceClass, createSchema: S.createLicenceClassSchema, updateSchema: S.updateLicenceClassSchema,
  refs: [{ path: 'countryId', target: 'countries' }],
  filters: { countryId: byId('countryId') },
});

/** Expiry state for a date: valid, expiring within 30 days, expired, or missing. */
export function expiryState(date: unknown, now = Date.now()) {
  if (!date) return { state: 'missing' as const, daysLeft: null };
  const time = new Date(String(date)).getTime();
  const daysLeft = Math.floor((time - now) / DAY);
  return { state: time < now ? 'expired' as const : daysLeft <= EXPIRY_WARNING_DAYS ? 'expiring' as const : 'valid' as const, daysLeft };
}

function ageOn(birth: Date, on = new Date()) {
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  const m = on.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

export const driverDefinition = defineMaster({
  key: 'drivers', label: 'Drivers', singular: 'Driver', group: GROUPS.drivers,
  description: 'Each driver with identity, licence, permits, medical, contacts, payout account and opening balance. National ID, passport, tax IDs and account numbers are sensitive.',
  model: Driver, createSchema: S.createDriverSchema, updateSchema: S.updateDriverSchema,
  searchFields: ['code', 'name', 'firstName', 'lastName', 'phone', 'licence.number', 'nationalId.number'],
  columns: ['phone', 'licence.expiryDate', 'assignedVehicleId'],
  sortFields: ['code', 'name', 'joinedOn', 'licence.expiryDate', 'createdAt', 'updatedAt'],
  autoCode: true,
  sensitive: ['nationalId.number', 'passport.number', 'taxIds.tpin', 'taxIds.napsa', 'taxIds.nhima', 'payout.accountNumber', 'religion'],
  refs: [
    { path: 'nationalId.countryId', target: 'countries' }, { path: 'passport.countryId', target: 'countries' },
    { path: 'address.cityId', target: 'cities' }, { path: 'licence.classIds', target: 'licence-classes' },
    { path: 'licence.issuedByCountryId', target: 'countries' }, { path: 'homeBranchId', target: 'branches' },
    { path: 'fleetManagerUserId', target: 'users' }, { path: 'openingBalance.currencyId', target: 'currencies' },
    { path: 'assignedVehicleId', target: 'vehicles' },
  ],
  filters: {
    homeBranchId: byId('homeBranchId'),
    blacklisted: { schema: boolQuery, apply: (v: boolean) => ({ blacklisted: v }), description: 'Blacklisted drivers' },
    licenceExpiringWithinDays: {
      schema: z.coerce.number().int().min(0).max(365),
      apply: (days: number) => ({ 'licence.expiryDate': { $lte: new Date(Date.now() + days * DAY) } }),
      description: 'Licence expires within N days (or has expired)',
    },
  },
  present: (doc: Plain) => {
    const licence = doc.licence as { expiryDate?: unknown } | undefined;
    const passport = doc.passport as { expiryDate?: unknown } | undefined;
    const permit = doc.professionalPermit as { expiryDate?: unknown } | undefined;
    return {
      compliance: {
        licence: expiryState(licence?.expiryDate),
        passport: expiryState(passport?.expiryDate),
        professionalPermit: expiryState(permit?.expiryDate),
        medical: expiryState(doc.medicalExpiryDate),
      },
    };
  },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    const birth = data.dateOfBirth as Date | undefined;
    if (birth) {
      const age = ageOn(birth);
      if (age < 18) push(errors, 'dateOfBirth', 'Drivers must be at least 18');
      if (age > 80) push(errors, 'dateOfBirth', 'Check the date of birth (over 80 years)');
    }
    const licence = data.licence as { issueDate?: Date; expiryDate: Date; classIds?: string[] } | undefined;
    if (licence?.issueDate && licence.expiryDate <= licence.issueDate) push(errors, 'licence', 'Expiry must be after issue');
    if (licence?.issueDate && licence.issueDate > new Date()) push(errors, 'licence', 'Issue date is in the future');
    const passport = data.passport as { issueDate?: Date; expiryDate?: Date } | undefined;
    if (passport?.issueDate && passport.expiryDate && passport.expiryDate <= passport.issueDate) push(errors, 'passport', 'Expiry must be after issue');
    if (data.blacklisted && !data.blacklistReason) push(errors, 'blacklistReason', 'Give the reason for blacklisting');
    if (!data.blacklisted && data.blacklistReason) push(errors, 'blacklistReason', 'Only blacklisted drivers have a reason');
    if (data.blacklisted && data.assignedVehicleId) push(errors, 'assignedVehicleId', 'A blacklisted driver cannot be assigned a truck');
    const joined = data.joinedOn as Date | undefined;
    if (joined && birth && ageOn(birth, joined) < 16) push(errors, 'joinedOn', 'Joined before the driver was 16');

    const nationalId = data.nationalId as { countryId: unknown; typeKey?: string; number: string } | undefined;
    if (nationalId) {
      const country = await Country.findById(nationalId.countryId).select('idTypes').lean();
      const idTypes = (country?.idTypes ?? []) as Array<{ key: string; label: string; pattern?: string }>;
      if (nationalId.typeKey) {
        const type = idTypes.find((t) => t.key === nationalId.typeKey);
        if (!type) push(errors, 'nationalId', `This country has no ID type "${nationalId.typeKey}"`);
        else if (type.pattern && !new RegExp(type.pattern).test(nationalId.number)) push(errors, 'nationalId', `${type.label} number does not match the required format`);
      }
    }
    if (licence?.classIds?.length && data.assignedVehicleId) {
      const vehicle = await Vehicle.findById(data.assignedVehicleId).select('vehicleTypeId').lean();
      const type = vehicle ? await VehicleType.findById(vehicle.vehicleTypeId).select('licenceClassIds name').lean() : null;
      const allowed = ((type?.licenceClassIds ?? []) as unknown[]).map(String);
      if (allowed.length && !licence.classIds.some((c) => allowed.includes(String(c)))) {
        push(errors, 'assignedVehicleId', `The driver's licence classes do not cover a ${type?.name}`);
      }
    }
    if (licence?.classIds?.length && birth) {
      const classes = await LicenceClass.find({ _id: { $in: licence.classIds } }).select('code minimumAge').lean();
      for (const c of classes) if (c.minimumAge && ageOn(birth) < Number(c.minimumAge)) push(errors, 'licence', `Class ${c.code} needs age ${c.minimumAge}+`);
    }
    if (Object.keys(errors).length) throw new ValidationError('Driver details are not valid', errors);
    return { ...data, name: `${data.firstName} ${data.lastName}`.trim() };
  },
});

export const recoveryRuleDefinition = defineMaster({
  key: 'recovery-rules', label: 'Driver recovery rules', singular: 'Recovery rule', group: GROUPS.drivers, module: 'finance',
  description: 'What may be recovered from a driver (shortage, damage, loan, unreturned advance, fine) and the maximum per settlement.',
  model: RecoveryRule, createSchema: S.createRecoveryRuleSchema, updateSchema: S.updateRecoveryRuleSchema,
  refs: [{ path: 'maxAmountPerSettlement.currencyId', target: 'currencies' }, { path: 'approvalPolicyId', target: 'approval-policies' }],
  filters: { kind: { schema: z.enum(RECOVERY_KINDS), apply: (v: string) => ({ kind: v }), description: 'Kind of recovery' } },
  async prepare(data: Plain) {
    if (data.maxPercentPerSettlement === undefined && !data.maxAmountPerSettlement) {
      throw new ValidationError('Set a maximum percentage, a maximum amount, or both', { maxPercentPerSettlement: ['Required unless maxAmountPerSettlement is set'] });
    }
    if (data.requiresApproval === false && data.approvalPolicyId) throw new ValidationError('An approval policy only applies when approval is required', { approvalPolicyId: ['Remove or require approval'] });
    return data;
  },
});

export const masters: MasterDefinition[] = [licenceClassDefinition, driverDefinition, recoveryRuleDefinition];
