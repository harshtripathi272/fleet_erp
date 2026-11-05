import { clearAreasCache } from './areas.js';
import { ConflictError, NotFoundError } from '../../core/errors/index.js';
import { audit, comparable, diff } from '../../core/masters/audit.js';
import { getRefTarget } from '../../core/masters/registry.js';
import { ValidationError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Company } from './company.model.js';
import { refreshRegional } from './regional.js';

const presentDoc = (doc: Plain) => { const { _id, singleton, ...rest } = comparable(doc) as Plain; return { id: _id, ...rest }; };
/** The record as saved, and the regional settings in effect (the company's, else its country's, else the defaults). */
const present = async (doc: Plain) => ({ ...presentDoc(doc), effectiveRegional: await refreshRegional() });
/** Audit-friendly copy without the internal singleton marker. */
const auditable = (doc: Plain) => { const { singleton, ...rest } = doc; return rest; };

async function assertRef(key: string, target: string, value: unknown) {
  if (!value) return;
  const t = getRefTarget(target);
  if (!t || !(await t.model.exists({ _id: value, status: 'active' }))) throw new ValidationError(`No active ${target.replace(/s$/, '')} with this id`, { [key]: ['Not found or inactive'] });
}

export async function getCompany() {
  const doc = await Company.findOne().lean();
  if (!doc) throw new NotFoundError('Company details have not been saved yet');
  return present(doc as Plain);
}

export async function saveCompany(input: Plain, actorId?: string, requestId?: string) {
  await assertRef('countryId', 'countries', input.countryId);
  await assertRef('baseCurrencyId', 'currencies', input.baseCurrencyId);
  const { version, ...changes } = input;
  const existing = await Company.findOne();
  if (!existing) {
    if (!changes.legalName) throw new ValidationError('Legal name is required', { legalName: ['Required'] });
    const created = await Company.create({ ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)), updatedBy: actorId });
    clearAreasCache();
    await audit({ entity: 'company', entityId: created._id, action: 'create', actorId, requestId, changes: diff({}, auditable(created.toObject() as Plain)) });
    return present(created.toObject() as Plain);
  }
  if (version === undefined) throw new ValidationError('Send the version you edited', { version: ['Required when updating'] });
  if (version !== existing.version) throw new ConflictError('Company details were changed by someone else. Reload and try again.', { currentVersion: existing.version });
  const before = existing.toObject() as Plain;
  for (const [key, value] of Object.entries(changes)) {
    // Operations and Maintenance settings merge, so saving one setting doesn't reset the others.
    if ((key === 'operations' || key === 'maintenance') && value) existing.set(key, { ...((before[key] as Plain | undefined) ?? {}), ...(value as Plain) });
    else if (key === 'regional' && value) {
      const merged = { ...((before.regional as Plain | undefined) ?? {}), ...(value as Plain) };
      existing.set(key, Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined)));
    }
    // Brand and watermark merge the same way; a null clears that one setting (a logo removed, say).
    else if ((key === 'brand' || key === 'watermark') && value) {
      const merged: Plain = { ...((before[key] as Plain | undefined) ?? {}) };
      for (const [k, v] of Object.entries(value as Plain)) { if (v === null) delete merged[k]; else merged[k] = v; }
      existing.set(key, merged);
    }
    else existing.set(key, value === null ? undefined : value);
  }
  if (!existing.isModified()) return present(before);
  existing.set('updatedBy', actorId);
  await existing.save();
  clearAreasCache();
  await audit({ entity: 'company', entityId: existing._id, action: 'update', actorId, requestId, changes: diff(auditable(before), auditable(existing.toObject() as Plain)) });
  return present(existing.toObject() as Plain);
}
