import { ConflictError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { getMaster } from '../../core/masters/registry.js';
import * as MasterService from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { saveCompanySchema } from '../company/company.schema.js';
import { saveCompany } from '../company/company.service.js';
import { createCustomRecordSchema } from '../configuration/configuration.schema.js';
import { pairSchema } from '../fleet/fleet.schema.js';
import { createRecord } from '../configuration/configuration.service.js';
import { pair } from '../fleet/fleet.service.js';
import { Role } from '../roles/role.model.js';

/**
 * A realistic cross-border fuel and copper operation (Zambia, Tanzania, DRC) created through
 * the same services the API uses, so every business rule is applied. Runs once per database.
 */
export async function loadSampleData(actorId?: string) {
  const countries = getMaster('countries')!;
  if (await countries.model.exists({ code: 'ZM' })) throw new ConflictError('Sample data is already loaded (country ZM exists)');
  const ctx = { actorId, canSeeSensitive: true };
  const ids: Record<string, string> = {};
  let created = 0;
  /** Same path as POST /api/v1/<key>: request schema first, then the service rules. */
  const make = async (key: string, ref: string, data: Plain) => {
    const def = getMaster(key)!;
    const record = await MasterService.create(def, def.createSchema.parse(data) as Plain, ctx);
    ids[ref] = String(record.id);
    created += 1;
    return ids[ref]!;
  };
  const money = (amountMinor: number, currency = 'ZMW') => ({ amountMinor, currencyId: ids[currency]! });
  const days = (n: number) => new Date(Date.now() + n * 86400000);

  // Money
  await make('currencies', 'ZMW', { code: 'ZMW', name: 'Zambian kwacha', symbol: 'K', minorUnits: 2 });
  await make('currencies', 'USD', { code: 'USD', name: 'US dollar', symbol: '$', minorUnits: 2 });
  await make('currencies', 'TZS', { code: 'TZS', name: 'Tanzanian shilling', symbol: 'TSh', minorUnits: 2 });
  await make('exchange-rates', 'fxUsdZmw', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: 26.45, effectiveDate: days(-1).toISOString().slice(0, 10), source: 'bank' });
  await make('exchange-rates', 'fxUsdTzs', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.TZS, rate: 2710, effectiveDate: days(-1).toISOString().slice(0, 10), source: 'bank' });

  // Geography
  await make('countries', 'ZM', { code: 'ZM', iso3: 'ZMB', name: 'Zambia', dialCode: '+260', currencyId: ids.ZMW, drivingSide: 'left', timezones: ['Africa/Lusaka'], idTypes: [{ key: 'nrc', label: 'NRC', pattern: '^\\d{6}/\\d{2}/\\d$' }] });
  await make('countries', 'TZ', { code: 'TZ', iso3: 'TZA', name: 'Tanzania', dialCode: '+255', currencyId: ids.TZS, drivingSide: 'left', timezones: ['Africa/Dar_es_Salaam'] });
  await make('countries', 'CD', { code: 'CD', iso3: 'COD', name: 'DR Congo', dialCode: '+243', drivingSide: 'right', timezones: ['Africa/Lubumbashi'] });
  await make('provinces', 'pLusaka', { code: 'LSK', name: 'Lusaka', countryId: ids.ZM });
  await make('provinces', 'pCopperbelt', { code: 'CB', name: 'Copperbelt', countryId: ids.ZM });
  await make('provinces', 'pDar', { code: 'DSM', name: 'Dar es Salaam', countryId: ids.TZ });
  await make('cities', 'cLusaka', { code: 'LUN', name: 'Lusaka', provinceId: ids.pLusaka, location: { lat: -15.4167, lng: 28.2833 } });
  await make('cities', 'cNdola', { code: 'NLA', name: 'Ndola', provinceId: ids.pCopperbelt, location: { lat: -12.9587, lng: 28.6366 } });
  await make('cities', 'cDar', { code: 'DAR', name: 'Dar es Salaam', provinceId: ids.pDar, location: { lat: -6.7924, lng: 39.2083 } });
  await make('places', 'depot', { code: 'LSK-DEPOT', name: 'Lusaka fuel depot', type: 'depot', cityId: ids.cLusaka, location: { lat: -15.4363, lng: 28.3221 }, geofenceRadiusM: 400 });
  await make('places', 'darPort', { code: 'DAR-PORT', name: 'Dar es Salaam port', type: 'port', cityId: ids.cDar, location: { lat: -6.8335, lng: 39.2895 } });
  await make('places', 'ndolaYard', { code: 'NDL-YARD', name: 'Ndola yard', type: 'yard', cityId: ids.cNdola, location: { lat: -12.9706, lng: 28.6439 } });
  await make('places', 'nakonde', { code: 'NAKONDE', name: 'Nakonde border', type: 'border', location: { lat: -9.3443, lng: 32.7529 } });
  await make('places', 'kasumbalesa', { code: 'KASUMBALESA', name: 'Kasumbalesa border', type: 'border', location: { lat: -12.2656, lng: 27.7981 } });
  await make('units', 'L', { code: 'L', name: 'Litre', symbol: 'L', dimension: 'volume', decimals: 0 });
  await make('units', 'KG', { code: 'KG', name: 'Kilogram', symbol: 'kg', dimension: 'mass', decimals: 0 });
  await make('units', 'T', { code: 'T', name: 'Tonne', symbol: 't', dimension: 'mass', decimals: 3 });
  await make('unit-conversions', 'tToKg', { fromUnitId: ids.T, toUnitId: ids.KG, factor: 1000 });

  // Organisation
  await make('branches', 'hq', { code: 'HQ', name: 'Lusaka head office', type: 'head_office', placeId: ids.depot, phone: '+260211123456', cashLimit: money(5_000_000) });
  await make('branches', 'ndola', { code: 'NDL', name: 'Ndola branch', type: 'branch', parentBranchId: ids.hq, placeId: ids.ndolaYard });
  await make('numbering-series', 'seriesDrivers', { code: 'DRIVERS', name: 'Driver codes', entity: 'drivers', prefix: 'DRV', pattern: '{PREFIX}-{SEQ}', padding: 4, resetPolicy: 'never' });
  await make('numbering-series', 'seriesParties', { code: 'PARTIES', name: 'Party codes', entity: 'parties', prefix: 'PTY', pattern: '{PREFIX}-{SEQ}', padding: 4, resetPolicy: 'never' });
  await make('numbering-series', 'seriesTrips', { code: 'TRIPS', name: 'Trip numbers', entity: 'trips', prefix: 'TRIP', pattern: '{PREFIX}/{YY}/{SEQ}', padding: 4, resetPolicy: 'yearly' });
  const financeRole = await Role.findOne({ key: 'finance' }).lean();
  const ownerRole = await Role.findOne({ key: 'owner' }).lean();
  await make('approval-policies', 'advanceApproval', {
    code: 'ADV-ZMW', name: 'Cash advances in kwacha', subject: 'cash_advance', currencyId: ids.ZMW,
    levels: [{ level: 1, minAmountMinor: 0, approverRoleId: String(financeRole!._id), channels: ['app', 'whatsapp'] }, { level: 2, minAmountMinor: 1_000_000, approverRoleId: String(ownerRole!._id), escalateAfterHours: 4, channels: ['whatsapp'] }],
  });

  await make('approval-policies', 'fuelApproval', {
    code: 'FUEL-L', name: 'Fuel requests', subject: 'fuel_request', currencyId: ids.ZMW,
    levels: [{ level: 1, minAmountMinor: 0, measure: 'litres', approverRoleId: String(financeRole!._id), channels: ['app', 'whatsapp'] }, { level: 2, minAmountMinor: 5000, measure: 'litres', approverRoleId: String(ownerRole!._id), channels: ['whatsapp'] }],
  });

  // Parties
  await make('order-sources', 'direct', { code: 'DIRECT', name: 'Direct from customer' });
  await make('order-sources', 'broker', { code: 'BROKER', name: 'Through a broker', referenceRequired: true });
  await make('parties', 'zambezi', { name: 'Zambezi Energy Ltd', roles: ['customer', 'consignee'], taxId: '1002345678', countryId: ids.ZM, currencyId: ids.USD, paymentTermsDays: 30, creditLimit: money(250_000_00, 'USD'), contacts: [{ name: 'Natasha Banda', jobTitle: 'Logistics manager', phone: '+260966112233', email: 'natasha.banda@zambezi.example', receives: ['nominations', 'pods'], isPrimary: true }] });
  await make('parties', 'copper', { name: 'Copperbelt Minerals plc', roles: ['customer', 'consignor'], countryId: ids.ZM, currencyId: ids.USD, contacts: [{ name: 'Peter Chileshe', email: 'p.chileshe@cbminerals.example', receives: ['invoices'] }] });
  await make('parties', 'clearing', { name: 'Tunduma Clearing & Forwarding', roles: ['clearing_agent'], countryId: ids.TZ, contacts: [{ name: 'Amani Mushi', whatsapp: '+255754998877' }] });
  await make('parties', 'leasing', { name: 'Afri Asset Leasing', roles: ['financier'], countryId: ids.ZM, bankAccounts: [{ bankName: 'Zanaco', accountName: 'Afri Asset Leasing', accountNumber: '0123456789012', currencyId: ids.ZMW }] });
  await make('border-posts', 'bpNakonde', { code: 'NAK-TUN', name: 'Nakonde / Tunduma', countryAId: ids.ZM, countryBId: ids.TZ, placeId: ids.nakonde, oneStopBorder: true, typicalWaitHours: 18, clearingAgentPartyIds: [ids.clearing], fees: [{ description: 'Road toll', amount: money(1000_00, 'USD') }] });
  await make('border-posts', 'bpKasumbalesa', { code: 'KASUMBA', name: 'Kasumbalesa', countryAId: ids.ZM, countryBId: ids.CD, placeId: ids.kasumbalesa, typicalWaitHours: 36 });

  // Compliance
  await make('document-types', 'dtRoadTax', { code: 'ROAD-TAX', name: 'Road tax', appliesTo: 'vehicle', countryId: ids.ZM, reminderDaysBefore: 30, blocking: 'dispatch', requiredForAll: true });
  await make('document-types', 'dtFitness', { code: 'FITNESS', name: 'Certificate of fitness', appliesTo: 'vehicle', reminderDaysBefore: 30, blocking: 'dispatch' });
  await make('document-types', 'dtCalibration', { code: 'CALIBRATION', name: 'Tank calibration certificate', appliesTo: 'trailer', reminderDaysBefore: 30, blocking: 'loading' });
  await make('document-types', 'dtLicence', { code: 'DL', name: 'Driving licence', appliesTo: 'driver', numberPattern: '^[A-Z0-9/ -]{5,20}$', reminderDaysBefore: 60, blocking: 'dispatch', requiredForAll: true });
  await make('document-types', 'dtComesa', { code: 'COMESA-CL', name: 'COMESA carrier licence', appliesTo: 'vehicle', reminderDaysBefore: 45, blocking: 'border' });
  await make('permit-types', 'permitComesa', { code: 'COMESA', name: 'COMESA carrier licence', issuingAuthority: 'RTSA', countryIds: [ids.ZM, ids.TZ], validityDays: 365, documentTypeId: ids.dtComesa });
  await make('insurance-types', 'insYellow', { code: 'YELLOW-CARD', name: 'COMESA Yellow Card', coverage: 'yellow_card', countryIds: [ids.ZM, ids.TZ, ids.CD] });

  // Drivers' licences and fleet
  await make('licence-classes', 'lcC1', { code: 'C1', name: 'Heavy goods vehicle', countryId: ids.ZM, minimumAge: 21 });
  await make('licence-classes', 'lcEC', { code: 'EC', name: 'Articulated heavy goods vehicle', countryId: ids.ZM, minimumAge: 21 });
  await make('vehicle-makes', 'scania', { code: 'SCANIA', name: 'Scania' });
  await make('vehicle-makes', 'volvo', { code: 'VOLVO', name: 'Volvo' });
  await make('vehicle-types', 'vtPrime', { code: 'PRIME', name: 'Prime mover (horse)', category: 'prime_mover', towsTrailer: true, licenceClassIds: [ids.lcEC], requiredDocumentTypeIds: [ids.dtFitness, ids.dtComesa] });
  await make('vehicle-types', 'vtRigid', { code: 'RIGID', name: 'Rigid truck', category: 'rigid', licenceClassIds: [ids.lcC1, ids.lcEC], requiredDocumentTypeIds: [ids.dtFitness] });
  await make('vehicle-models', 'r460', { code: 'R460', name: 'R 460 6x4', makeId: ids.scania, vehicleTypeId: ids.vtPrime, axleConfiguration: '6x4', grossCombinationMassKg: 56000, grossVehicleMassKg: 26000, tankCapacityL: 900, kmPerLLoaded: 2.2, kmPerLEmpty: 2.9 });
  await make('vehicle-models', 'fh', { code: 'FH440', name: 'FH 440 6x4', makeId: ids.volvo, vehicleTypeId: ids.vtPrime, axleConfiguration: '6x4' });
  await make('trailer-types', 'ttTanker', { code: 'TANKER', name: 'Fuel tanker', cargoKinds: ['liquid_bulk'], hasCompartments: true, requiredDocumentTypeIds: [ids.dtCalibration] });
  await make('trailer-types', 'ttFlat', { code: 'FLATBED', name: 'Flatbed', cargoKinds: ['general', 'dry_bulk'] });
  await make('fuel-types', 'diesel', { code: 'D50', name: 'Diesel 50 ppm', unitId: ids.L, densityKgPerL: 0.835 });
  await make('vehicles', 'v1', { code: 'T001', registrationNumber: 'ALC 4821', vin: 'YS2R6X40005412345', engineNumber: 'DC13-1234567', makeId: ids.scania, modelId: ids.r460, vehicleTypeId: ids.vtPrime, year: 2021, homeBranchId: ids.hq, odometerKm: 412560, tankCapacityL: 900, fuelTypeId: ids.diesel, kmPerLLoaded: 2.2, kmPerLEmpty: 2.9, ownership: 'leased', ownerPartyId: ids.leasing, financierPartyId: ids.leasing, purchase: { date: '2021-03-15', amount: money(92_000_00, 'USD') }, regulatorRefs: [{ authority: 'RTSA', number: 'RTSA-884512' }] });
  await make('vehicles', 'v2', { code: 'T002', registrationNumber: 'BCA 9034', makeId: ids.volvo, modelId: ids.fh, vehicleTypeId: ids.vtPrime, year: 2019, homeBranchId: ids.ndola, odometerKm: 655010, fuelTypeId: ids.diesel });
  await make('trailers', 't1', { code: 'TR001', registrationNumber: 'TAC 7821', trailerTypeId: ids.ttTanker, make: 'Henred', axles: 3, capacityL: 38000, compartments: [{ number: 1, capacityL: 13000 }, { number: 2, capacityL: 12500 }, { number: 3, capacityL: 12500 }], homeBranchId: ids.hq });
  await make('trailers', 't2', { code: 'TR002', registrationNumber: 'TBL 6206', trailerTypeId: ids.ttFlat, axles: 3, capacityKg: 34000, homeBranchId: ids.ndola });
  await pair(pairSchema.parse({ vehicleId: ids.v1, trailerId: ids.t1, reason: 'Fuel runs' }), ctx);
  created += 1;
  await make('drivers', 'd1', { firstName: 'Joseph', lastName: 'Mwansa', phone: '+260971234567', whatsapp: '+260971234567', dateOfBirth: '1984-06-02', nationalId: { countryId: ids.ZM, typeKey: 'nrc', number: '123456/10/1' }, licence: { number: 'ZM-DL-448812', classIds: [ids.lcEC], issuedByCountryId: ids.ZM, issueDate: '2015-02-01', expiryDate: days(200).toISOString().slice(0, 10) }, homeBranchId: ids.hq, joinedOn: '2019-01-07', employmentType: 'permanent', bloodGroup: 'O+', payout: { method: 'mobile_money', provider: 'Airtel Money', accountName: 'Joseph Mwansa', accountNumber: '+260971234567' }, taxIds: { tpin: '1004567890' }, assignedVehicleId: ids.v1, emergencyContact: { name: 'Grace Mwansa', relation: 'Wife', phone: '+260977001122' } });
  await make('drivers', 'd2', { firstName: 'Martha', lastName: 'Phiri', phone: '+260955667788', dateOfBirth: '1990-11-20', licence: { number: 'ZM-DL-551201', classIds: [ids.lcEC, ids.lcC1], expiryDate: days(20).toISOString().slice(0, 10) }, homeBranchId: ids.ndola, employmentType: 'contract' });
  await make('recovery-rules', 'recShortage', { code: 'SHORTAGE', name: 'Fuel shortage beyond allowance', kind: 'shortage', maxPercentPerSettlement: 30, requiresApproval: true, approvalPolicyId: ids.advanceApproval });
  await make('compliance-documents', 'docRoadTax', { documentTypeId: ids.dtRoadTax, subjectKind: 'vehicle', subjectId: ids.v1, number: 'RT-2026-0042', issueDate: days(-200).toISOString().slice(0, 10), expiryDate: days(165).toISOString().slice(0, 10), issuedBy: 'RTSA' });
  await make('compliance-documents', 'docFitness', { documentTypeId: ids.dtFitness, subjectKind: 'vehicle', subjectId: ids.v1, number: 'FIT-77812', issueDate: days(-340).toISOString().slice(0, 10), expiryDate: days(12).toISOString().slice(0, 10), issuedBy: 'RTSA' });
  await make('compliance-documents', 'docLicence', { documentTypeId: ids.dtLicence, subjectKind: 'driver', subjectId: ids.d1, number: 'ZM-DL-448812', issueDate: '2015-02-01', expiryDate: days(200).toISOString().slice(0, 10) });

  // Cargo
  await make('product-groups', 'pgFuel', { code: 'FUEL', name: 'Fuel', defaultUnitId: ids.L, pricingBasis: 'per_litre' });
  await make('product-groups', 'pgMinerals', { code: 'MINERALS', name: 'Minerals', defaultUnitId: ids.T, pricingBasis: 'per_tonne' });
  await make('products', 'diesel50', { code: 'DIESEL-50', name: 'Diesel 50 ppm', groupId: ids.pgFuel, unitId: ids.L, hazard: { unClass: '3', unNumber: 'UN1202', packingGroup: 'III' }, densityKgPerL: 0.835, volumeCorrected: true, referenceTemperatureC: 20, shortageAllowancePercent: 0.3, shortagePricePerUnit: money(31_00), packaging: 'bulk', allowedTrailerTypeIds: [ids.ttTanker] });
  await make('products', 'copper', { code: 'CU-CATH', name: 'Copper cathodes', groupId: ids.pgMinerals, unitId: ids.T, packaging: 'pallets', allowedTrailerTypeIds: [ids.ttFlat] });
  await make('load-types', 'ltFull', { code: 'FTL', name: 'Full truck load', pricingBasis: 'per_trip' });
  await make('load-types', 'ltBulk', { code: 'BULK-LIQ', name: 'Bulk liquid', pricingBasis: 'per_litre' });
  await make('shortage-policies', 'spDiesel', { code: 'DIESEL-LOSS', name: 'Diesel transit loss', productId: ids.diesel50, allowanceKind: 'percent', allowanceValue: 0.3, measuredAt: 'reference_temperature', pricePerUnit: money(31_00), bearer: 'driver', approvalPolicyId: ids.advanceApproval });
  await make('pod-types', 'podSigned', { code: 'SIGNED', name: 'Signed delivery note', evidence: 'signed_note' });
  await make('pod-types', 'podPhoto', { code: 'PHOTO', name: 'Photo of stamped note', evidence: 'photo' });

  // Messages and layouts
  await make('print-layouts', 'plTripSheet', { code: 'TRIP-SHEET', name: 'Trip sheet A4', document: 'trip_sheet', paperSize: 'A4', isDefault: true, sections: [{ key: 'trip', label: 'Trip', visible: true, order: 1 }, { key: 'load', label: 'Load', visible: true, order: 2 }, { key: 'movement', label: 'Vehicle movement', visible: true, order: 3 }, { key: 'money', label: 'Advances and expenses', visible: true, order: 4 }], signatureLines: ['Operations', 'Finance', 'Driver'] });
  await make('message-templates', 'mtApproval', { code: 'WA-ADV-REQ', name: 'Advance request to Finance', channel: 'whatsapp', event: 'fund_request.created', audience: 'finance', body: '{{driver.name}} needs {{currency}} {{amount}} for {{trip.number}} ({{route.name}}). Reason: {{reason}}', buttons: [{ label: 'Approve', action: 'approve' }, { label: 'Reject', action: 'reject' }], providerTemplateId: 'advance_request_v1' });
  await make('message-templates', 'mtDispatch', { code: 'SMS-DISPATCH', name: 'Dispatch SMS to driver', channel: 'sms', event: 'trip.dispatched', audience: 'driver', body: '{{trip.number}}: you are dispatched with {{vehicle.registration}} on {{route.name}}. Safe travels.' });
  await make('message-templates', 'mtExpiry', { code: 'EMAIL-DOC-EXP', name: 'Document expiring e-mail', channel: 'email', event: 'document.expiring', audience: 'operations', subject: '{{document.name}} for {{vehicle.registration}} expires {{document.expiryDate}}', body: 'Hello,\n\n{{document.name}} {{document.number}} expires on {{document.expiryDate}}. Renew it to avoid blocking dispatch.\n\n{{company.name}}' });
  await make('notification-rules', 'nrApproval', { code: 'ADV-REQUEST', name: 'Tell Finance about advance requests', event: 'fund_request.created', recipients: [{ kind: 'role', roleId: String(financeRole!._id) }], templates: [{ channel: 'whatsapp', templateId: ids.mtApproval }, { channel: 'app' }], repeatEveryMinutes: 60, maxRepeats: 3 });

  // Trip operations
  await make('trip-types', 'ttFuel', { code: 'FUEL', name: 'Fuel haulage', cargoKind: 'liquid_bulk', loadTypeId: ids.ltBulk, requiredDocumentTypeIds: [ids.dtRoadTax], printLayoutId: ids.plTripSheet, isDefault: true });
  await make('trip-types', 'ttGeneral', { code: 'GENERAL', name: 'General cargo', cargoKind: 'general', loadTypeId: ids.ltFull });
  const stages = [['PLAN', 'Plan', 'operations', 'funding_requested'], ['FUNDING', 'Funding', 'finance', 'dispatched'], ['LOADING', 'Loading', 'operations', 'loaded'], ['TRANSIT', 'Transit', 'operations', 'arrived_offloading'], ['OFFLOAD', 'Offloading', 'operations', 'delivered'], ['CLOSE', 'Close', 'finance', 'ended']] as const;
  for (const [i, [code, name, role, completesOn]] of stages.entries()) {
    const roleId = String((await Role.findOne({ key: role }).lean())!._id);
    await make('trip-stages', `stage${code}`, { tripTypeId: ids.ttFuel, code, name, order: i + 1, actorRoleId: roleId, isFinal: code === 'CLOSE', completesOn, ...(code === 'FUNDING' ? { notifyTemplateId: ids.mtApproval } : {}), ...(code === 'LOADING' ? { requiredDocumentTypeIds: [ids.dtCalibration], reopenable: true } : {}) });
  }
  await make('stop-types', 'stBorder', { code: 'BORDER', name: 'Border crossing', waitingCountsAs: 'border' });
  await make('stop-types', 'stLoad', { code: 'LOAD', name: 'Loading', waitingCountsAs: 'loading' });
  await make('expense-categories', 'ecRoad', { code: 'ROAD', name: 'Road and border', ledgerCode: '5100', maxWithoutApproval: money(500_00) });
  await make('expense-categories', 'ecSubsistence', { code: 'SUBS', name: 'Subsistence', ledgerCode: '5200', receiptRequired: false });
  await make('expense-items', 'eiToll', { code: 'TOLL', name: 'Road toll', categoryId: ids.ecRoad, per: 'occurrence', defaultAmount: money(250_00) });
  await make('expense-items', 'eiBorder', { code: 'BORDER-FEE', name: 'Border clearing fee', categoryId: ids.ecRoad, per: 'border' });
  await make('expense-items', 'eiMeals', { code: 'MEALS', name: 'Meals and lodging', categoryId: ids.ecSubsistence, per: 'day', defaultAmount: money(180_00) });
  await make('fuel-norms', 'fnPrime', { vehicleTypeId: ids.vtPrime, kmPerLLoaded: 2.1, kmPerLEmpty: 2.8, reservePercent: 6 });
  await make('routes', 'routeDar', {
    code: 'DAR-LSK', name: 'Dar es Salaam port to Lusaka fuel depot', standardDays: 4,
    stops: [
      { placeId: ids.depot, kind: 'start', legKm: 0 },
      { placeId: ids.darPort, kind: 'load', legKm: 1961 },
      { placeId: ids.nakonde, kind: 'border', legKm: 934, borderPostId: ids.bpNakonde },
      { placeId: ids.depot, kind: 'offload', legKm: 1027 },
      { placeId: ids.depot, kind: 'end', legKm: 0 },
    ],
  });
  await make('trip-budgets', 'budgetDar', { code: 'DAR-LSK-PRIME', name: 'Dar run, prime mover', routeId: ids.routeDar, vehicleTypeId: ids.vtPrime, currencyId: ids.ZMW, cashItems: [{ expenseItemId: ids.eiToll, amountMinor: 1500_00 }, { expenseItemId: ids.eiBorder, amountMinor: 2400_00 }, { expenseItemId: ids.eiMeals, amountMinor: 1440_00 }] });
  await make('payment-methods', 'pmCash', { code: 'CASH', name: 'Cash', kind: 'cash', referenceRequired: false, currencyIds: [ids.ZMW, ids.USD] });
  await make('payment-methods', 'pmAirtel', { code: 'AIRTEL', name: 'Airtel Money', kind: 'mobile_money', provider: 'Airtel', currencyIds: [ids.ZMW] });
  await make('payment-methods', 'pmDepot', { code: 'DEPOT', name: 'Own depot fuel', kind: 'own_depot', forFuel: true, forCash: false, referenceRequired: true });
  await make('advance-policies', 'apRoute', { code: 'ROUTE-BUDGET', name: 'Advance from route budget', basis: 'route_budget', maxAmount: money(10_000_00), capOnCashHeld: money(2_000_00), approvalPolicyId: ids.advanceApproval, paymentMethodIds: [ids.pmCash, ids.pmAirtel] });
  await make('cancellation-reasons', 'crCustomer', { code: 'CUST-CANCEL', name: 'Customer cancelled', appliesTo: ['trip', 'order'], chargeableToCustomer: true });

  // Configuration
  await make('lists', 'listUnions', { code: 'UNIONS', name: 'Driver unions', values: [{ value: 'ztu', label: 'Zambia Transport Union' }, { value: 'none', label: 'Not a member' }] });
  await make('field-definitions', 'fdUnion', { entity: 'drivers', key: 'union', label: 'Union', type: 'select', listId: ids.listUnions, order: 1 });
  await make('field-definitions', 'fdUnionNo', { entity: 'drivers', key: 'unionNumber', label: 'Union membership no.', type: 'text', pattern: '^[A-Z0-9-]{4,20}$', order: 2 });
  await make('custom-masters', 'cmHealth', {
    code: 'health-cards', name: 'Health cards', description: 'Driver medical clearance cards issued by approved clinics',
    titleField: 'cardNumber',
    fields: [
      { key: 'cardNumber', label: 'Card number', type: 'text', required: true },
      { key: 'driver', label: 'Driver', type: 'reference', referenceMaster: 'drivers', required: true },
      { key: 'clinic', label: 'Clinic', type: 'text' },
      { key: 'expiryDate', label: 'Expiry date', type: 'date', required: true },
    ],
  });
  await createRecord(ids.cmHealth!, createCustomRecordSchema.parse({ data: { cardNumber: 'HC-001', driver: ids.d1, clinic: 'Lusaka Medical Centre', expiryDate: days(90).toISOString().slice(0, 10) } }), ctx);
  created += 1;

  if (!(await Company.exists({}))) {
    await saveCompany(saveCompanySchema.parse({ legalName: 'Marichi Connect Logistics Ltd', tradingName: 'Marichi Fleet', countryId: ids.ZM, baseCurrencyId: ids.ZMW, timezone: 'Africa/Lusaka', fiscalYearStartMonth: 1, modules: ['masters', 'trips', 'finance', 'tracking', 'driver-app'], phone: '+260211123456', email: 'ops@marichi.example', allowSelfRegistration: true }), actorId);
    created += 1;
  }
  logger.info({ created }, 'Sample data loaded');
  return { created };
}
