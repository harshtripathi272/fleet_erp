import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, find, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

/** Business rules of every domain, exercised through the HTTP API on the sample operation. */
let owner: Session;
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const post = (path: string, body: unknown) => api().post(`/api/v1${path}`).set(bearer(owner)).send(body as object);
const patch = (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(owner)).send(body as object);
const get = (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(owner));
const detailsOf = (r: { body: { error?: { details?: unknown } } }) => JSON.stringify(r.body.error?.details ?? {});
let ids: Record<string, string> = {};

before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  const pick = async (master: string, search: string) => (await find(owner, master, search)).id as string;
  ids = {
    ZM: await pick('countries', 'ZM'), TZ: await pick('countries', 'TZ'), CD: await pick('countries', 'CD'),
    ZMW: await pick('currencies', 'ZMW'), USD: await pick('currencies', 'USD'),
    lusakaProv: await pick('provinces', 'Lusaka'), cbProv: await pick('provinces', 'Copperbelt'),
    depot: await pick('places', 'LSK-DEPOT'), darPort: await pick('places', 'DAR-PORT'), nakonde: await pick('places', 'NAKONDE'),
    bpNakonde: await pick('border-posts', 'NAK-TUN'),
    L: await pick('units', 'Litre'), KG: await pick('units', 'Kilogram'), T: await pick('units', 'Tonne'),
    scania: await pick('vehicle-makes', 'SCANIA'), volvo: await pick('vehicle-makes', 'VOLVO'), r460: await pick('vehicle-models', 'R460'),
    prime: await pick('vehicle-types', 'PRIME'), rigid: await pick('vehicle-types', 'RIGID'),
    tanker: await pick('trailer-types', 'TANKER'), flatbed: await pick('trailer-types', 'FLATBED'),
    v1: await pick('vehicles', 'ALC'), v2: await pick('vehicles', 'BCA'), t1: await pick('trailers', 'TAC'), t2: await pick('trailers', 'TBL'),
    lcEC: await pick('licence-classes', 'EC'), lcC1: await pick('licence-classes', 'C1'),
    joseph: await pick('drivers', 'Mwansa'), martha: await pick('drivers', 'Phiri'),
    clearing: await pick('parties', 'Tunduma'), zambezi: await pick('parties', 'Zambezi'), leasing: await pick('parties', 'Leasing'),
    dtRoadTax: await pick('document-types', 'ROAD-TAX'), dtLicence: await pick('document-types', 'DL'), dtFitness: await pick('document-types', 'FITNESS'),
    diesel: await pick('products', 'DIESEL-50'), pgFuel: await pick('product-groups', 'FUEL'),
    ttFuel: await pick('trip-types', 'FUEL'), routeDar: await pick('routes', 'DAR-LSK'),
    eiToll: await pick('expense-items', 'TOLL'), mtApproval: await pick('message-templates', 'WA-ADV-REQ'), mtSms: await pick('message-templates', 'SMS-DISPATCH'),
    mtEmail: await pick('message-templates', 'EMAIL-DOC-EXP'), hq: await pick('branches', 'HQ'), ndola: await pick('branches', 'NDL'),
    seriesTrips: await pick('numbering-series', 'TRIPS'), listUnions: await pick('lists', 'UNIONS'), healthCards: await pick('custom-masters', 'health-cards'),
  };
});
after(stopDatabase);

describe('geography and routes', () => {
  test('country codes follow ISO and ID-type patterns must compile', async () => {
    assert.equal((await post('/countries', { code: 'ZMB', name: 'Bad' })).status, 422);
    assert.equal((await post('/countries', { code: 'zw', name: 'Zimbabwe', timezones: ['Mars/Olympus'] })).status, 422);
    assert.equal((await post('/countries', { code: 'zw', name: 'Zimbabwe', idTypes: [{ key: 'nid', label: 'National ID', pattern: '([' }] })).status, 422);
    assert.equal((await post('/countries', { code: 'zw', name: 'Zimbabwe', idTypes: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] })).status, 422);
    const ok = await post('/countries', { code: 'zw', iso3: 'zwe', name: 'Zimbabwe', dialCode: '+263' }).expect(201);
    assert.equal(ok.body.data.code, 'ZW');
    assert.equal(ok.body.data.iso3, 'ZWE');
    assert.equal((await post('/countries', { code: 'ZW', name: 'Duplicate' })).status, 409);
  });

  test('cities take their country from the province; names are unique per province ignoring case', async () => {
    const city = await post('/cities', { code: 'KAF', name: 'Kafue', provinceId: ids.lusakaProv }).expect(201);
    assert.equal(city.body.data.countryId, ids.ZM);
    assert.equal((await post('/cities', { code: 'KAF2', name: 'KAFUE', provinceId: ids.lusakaProv })).status, 409);
    await post('/cities', { code: 'KAF3', name: 'Kafue', provinceId: ids.cbProv }).expect(201);
    assert.equal((await post('/cities', { code: 'X1', name: 'X', provinceId: ids.lusakaProv, countryId: ids.TZ })).status, 422);
  });

  test('places compute a geo point and can be searched by distance', async () => {
    const near = await get('/places/near', { lat: -15.42, lng: 28.30, radiusKm: 20 }).expect(200);
    assert.deepEqual(near.body.data.map((p: { code: string }) => p.code), ['LSK-DEPOT']);
    assert.ok(near.body.data[0].distanceKm < 20);
    const wide = await get('/places/near', { lat: -15.42, lng: 28.30, radiusKm: 2000, type: 'border' }).expect(200);
    assert.ok(wide.body.data.every((p: { type: string }) => p.type === 'border'));
    await get('/places/near', { lat: 91, lng: 0 }).expect(422);
    await get('/places/near', { lat: 0, lng: 0, radiusKm: 0 }).expect(422);
    assert.equal((await post('/places', { code: 'BAD-LOC', name: 'Bad', type: 'yard', location: { lat: 95, lng: 10 } })).status, 422);
    assert.equal((await post('/places', { code: 'BAD-R', name: 'Bad', type: 'yard', geofenceRadiusM: 5 })).status, 422);
  });

  test('border posts join two different countries and need clearing-agent parties', async () => {
    assert.equal((await post('/border-posts', { code: 'SAME', name: 'Same', countryAId: ids.ZM, countryBId: ids.ZM })).status, 422);
    const wrongRole = await post('/border-posts', { code: 'BP2', name: 'BP', countryAId: ids.ZM, countryBId: ids.CD, clearingAgentPartyIds: [ids.zambezi] }).expect(422);
    assert.match(detailsOf(wrongRole), /clearing_agent/);
    await post('/border-posts', { code: 'BP2', name: 'BP', countryAId: ids.ZM, countryBId: ids.CD, clearingAgentPartyIds: [ids.clearing] }).expect(201);
    const byCountry = await get('/border-posts', { countryId: ids.CD }).expect(200);
    assert.equal(byCountry.body.meta.total, 2);
  });

  test('routes check stop order and calculate loaded and empty kilometres', async () => {
    const dar = await get(`/routes/${ids.routeDar}`).expect(200);
    assert.equal(dar.body.data.totalKm, 3922);
    assert.equal(dar.body.data.loadedKm, 1961);
    assert.equal(dar.body.data.emptyKm, 1961);
    const stops = (kinds: Array<[string, string, number, string?]>) => kinds.map(([placeId, kind, legKm, borderPostId]) => ({ placeId, kind, legKm, ...(borderPostId ? { borderPostId } : {}) }));
    const cases: Array<[string, unknown]> = [
      ['no load', stops([[ids.depot!, 'start', 0], [ids.darPort!, 'offload', 10], [ids.depot!, 'end', 10]])],
      ['offload before load', stops([[ids.depot!, 'start', 0], [ids.darPort!, 'offload', 10], [ids.nakonde!, 'load', 10], [ids.depot!, 'end', 10]])],
      ['start not first', stops([[ids.depot!, 'load', 0], [ids.darPort!, 'offload', 10], [ids.depot!, 'end', 10]])],
      ['border without post', stops([[ids.depot!, 'start', 0], [ids.darPort!, 'load', 10], [ids.nakonde!, 'border', 10], [ids.depot!, 'offload', 10], [ids.depot!, 'end', 0]])],
      ['first leg not zero', stops([[ids.depot!, 'start', 5], [ids.darPort!, 'load', 10], [ids.depot!, 'offload', 10], [ids.depot!, 'end', 0]])],
      ['same place with distance', stops([[ids.depot!, 'start', 0], [ids.darPort!, 'load', 10], [ids.depot!, 'offload', 10], [ids.depot!, 'end', 7]])],
    ];
    for (const [label, s] of cases) assert.equal((await post('/routes', { code: `BAD-${label.length}${label[0]}`, name: label, stops: s })).status, 422, label);
    const good = await post('/routes', { code: 'NDL-LSK', name: 'Ndola to Lusaka', stops: stops([[ids.depot!, 'start', 0], [ids.darPort!, 'load', 100], [ids.nakonde!, 'border', 50, ids.bpNakonde], [ids.depot!, 'offload', 200], [ids.depot!, 'end', 0]]) }).expect(201);
    assert.equal(good.body.data.loadedKm, 250);
    assert.equal(good.body.data.emptyKm, 100);
    const edited = await patch(`/routes/${good.body.data.id}`, { version: good.body.data.version, stops: stops([[ids.depot!, 'start', 0], [ids.darPort!, 'load', 120], [ids.depot!, 'offload', 300], [ids.depot!, 'end', 0]]) }).expect(200);
    assert.equal(edited.body.data.totalKm, 420);
    const through = await get('/routes', { placeId: ids.nakonde }).expect(200);
    assert.deepEqual(through.body.data.map((r: { code: string }) => r.code), ['DAR-LSK']);
  });

  test('unit conversions stay within a dimension unless a product supplies density', async () => {
    const t = await get('/unit-conversions/convert', { fromUnitId: ids.T, toUnitId: ids.KG, value: 2.5 }).expect(200);
    assert.equal(t.body.data.result, 2500);
    const inverse = await get('/unit-conversions/convert', { fromUnitId: ids.KG, toUnitId: ids.T, value: 1500 }).expect(200);
    assert.equal(inverse.body.data.method, 'inverse');
    assert.equal(inverse.body.data.result, 1.5);
    const same = await get('/unit-conversions/convert', { fromUnitId: ids.KG, toUnitId: ids.KG, value: 7 }).expect(200);
    assert.equal(same.body.data.method, 'identity');
    await get('/unit-conversions/convert', { fromUnitId: ids.L, toUnitId: ids.KG, value: 1 }).expect(404);
    assert.equal((await post('/unit-conversions', { fromUnitId: ids.L, toUnitId: ids.KG, factor: 0.835 })).status, 422);
    await post('/unit-conversions', { fromUnitId: ids.L, toUnitId: ids.KG, factor: 0.835, productId: ids.diesel }).expect(201);
    const dense = await get('/unit-conversions/convert', { fromUnitId: ids.L, toUnitId: ids.KG, value: 1000, productId: ids.diesel }).expect(200);
    assert.equal(dense.body.data.result, 835);
    assert.equal((await post('/unit-conversions', { fromUnitId: ids.KG, toUnitId: ids.KG, factor: 1 })).status, 422);
    assert.equal((await post('/unit-conversions', { fromUnitId: ids.T, toUnitId: ids.KG, factor: 1000 })).status, 409);
    assert.equal((await post('/unit-conversions', { fromUnitId: ids.T, toUnitId: ids.KG, factor: -1 })).status, 422);
    const unit = await get(`/units/${ids.KG}`).expect(200);
    assert.equal((await patch(`/units/${ids.KG}`, { version: unit.body.data.version, dimension: 'volume' })).status, 422);
  });
});

describe('money', () => {
  test('converts with the latest rate on or before a date, directly or inverted', async () => {
    const usd = await get('/exchange-rates/convert', { fromCurrencyId: ids.USD, toCurrencyId: ids.ZMW, amountMinor: 10000 }).expect(200);
    assert.equal(usd.body.data.resultMinor, 264500);
    const back = await get('/exchange-rates/convert', { fromCurrencyId: ids.ZMW, toCurrencyId: ids.USD, amountMinor: 264500 }).expect(200);
    assert.equal(back.body.data.method, 'inverse');
    assert.equal(back.body.data.resultMinor, 10000);
    await post('/exchange-rates', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: 30, effectiveDate: day(10) }).expect(201);
    const today = await get('/exchange-rates/convert', { fromCurrencyId: ids.USD, toCurrencyId: ids.ZMW, amountMinor: 100 }).expect(200);
    assert.equal(today.body.data.rate, 26.45);
    const future = await get('/exchange-rates/convert', { fromCurrencyId: ids.USD, toCurrencyId: ids.ZMW, amountMinor: 100, date: day(11) }).expect(200);
    assert.equal(future.body.data.rate, 30);
    await get('/exchange-rates/convert', { fromCurrencyId: ids.USD, toCurrencyId: ids.ZMW, amountMinor: 100, date: '2000-01-01' }).expect(404);
    await get('/exchange-rates/convert', { fromCurrencyId: ids.USD, toCurrencyId: ids.ZMW, amountMinor: 1.5 }).expect(422);
    assert.equal((await post('/exchange-rates', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.USD, rate: 1, effectiveDate: day(0) })).status, 422);
    assert.equal((await post('/exchange-rates', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: 31, effectiveDate: `${day(10)}T15:00:00Z` })).status, 409);
    assert.equal((await post('/exchange-rates', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: 0, effectiveDate: day(20) })).status, 422);
  });

  test('currencies cannot change code or decimals once created; payment methods need a use', async () => {
    const usd = await get(`/currencies/${ids.USD}`).expect(200);
    assert.equal((await patch(`/currencies/${ids.USD}`, { version: usd.body.data.version, minorUnits: 3 })).status, 422);
    assert.equal((await patch(`/currencies/${ids.USD}`, { version: usd.body.data.version, code: 'USN' })).status, 422);
    await patch(`/currencies/${ids.USD}`, { version: usd.body.data.version, symbol: 'US$' }).expect(200);
    assert.equal((await post('/payment-methods', { code: 'NONE', name: 'None', kind: 'cash', forFuel: false, forCash: false })).status, 422);
    assert.equal((await post('/currencies', { code: 'US', name: 'Bad' })).status, 422);
  });
});

describe('organisation', () => {
  test('one active head office and no loops between branches', async () => {
    assert.equal((await post('/branches', { code: 'HQ2', name: 'Another HQ', type: 'head_office' })).status, 409);
    const child = await post('/branches', { code: 'KIT', name: 'Kitwe', type: 'depot', parentBranchId: ids.ndola }).expect(201);
    const hq = await get(`/branches/${ids.hq}`).expect(200);
    const loop = await patch(`/branches/${ids.hq}`, { version: hq.body.data.version, parentBranchId: child.body.data.id });
    assert.equal(loop.status, 422);
    const self = await patch(`/branches/${ids.hq}`, { version: hq.body.data.version, parentBranchId: ids.hq });
    assert.equal(self.status, 422);
  });

  test('numbering series generate codes, skip taken ones, and validate patterns', async () => {
    const preview = await get(`/numbering-series/${ids.seriesTrips}/preview`).expect(200);
    assert.match(preview.body.data.next, /^TRIP\/\d{2}\/0001$/);
    const n1 = await post(`/numbering-series/${ids.seriesTrips}/next`, {}).expect(200);
    const n2 = await post(`/numbering-series/${ids.seriesTrips}/next`, {}).expect(200);
    assert.equal(n2.body.data.number, n1.body.data.number + 1);
    const party = await post('/parties', { name: 'Auto Code Ltd', roles: ['supplier'] }).expect(201);
    assert.match(party.body.data.code, /^PTY-\d{4}$/);
    await post('/parties', { code: 'PTY-0006', name: 'Manual', roles: ['supplier'] }).expect(201);
    await post('/parties', { code: 'PTY-0007', name: 'Manual 2', roles: ['supplier'] }).expect(201);
    const next = await post('/parties', { name: 'After manual', roles: ['supplier'] }).expect(201);
    assert.notEqual(next.body.data.code, 'PTY-0006');
    assert.notEqual(next.body.data.code, 'PTY-0007');
    for (const pattern of ['NOSEQ', '{SEQ}{SEQ}', '{SEQ}{WHAT}', '{BR}-{SEQ}', 'A B{SEQ}']) {
      assert.equal((await post('/numbering-series', { code: `S${pattern.length}${pattern[1]}`, name: 'Bad', entity: 'vehicles', pattern })).status, 422, pattern);
    }
    assert.equal((await post('/numbering-series', { code: 'SX', name: 'Bad entity', entity: 'spaceships', pattern: '{SEQ}' })).status, 422);
    assert.equal((await post('/numbering-series', { code: 'DUPDRV', name: 'Second driver series', entity: 'drivers', pattern: 'D{SEQ}' })).status, 409);
    const entities = await get('/numbering-series/entities').expect(200);
    assert.ok(entities.body.data.includes('drivers') && entities.body.data.includes('trips'));
  });

  test('approval levels are ordered with rising thresholds and one approver each', async () => {
    const role = (await find(owner, 'roles', 'finance')).id;
    const base = { code: 'EXP-ZMW', name: 'Expenses', subject: 'expense', currencyId: ids.ZMW };
    assert.equal((await post('/approval-policies', { ...base, levels: [{ level: 2, minAmountMinor: 0, approverRoleId: role }] })).status, 422);
    assert.equal((await post('/approval-policies', { ...base, levels: [{ level: 1, minAmountMinor: 0, approverRoleId: role, approverUserId: owner.userId }] })).status, 422);
    assert.equal((await post('/approval-policies', { ...base, levels: [{ level: 1, minAmountMinor: 0 }] })).status, 422);
    assert.equal((await post('/approval-policies', { ...base, levels: [{ level: 1, minAmountMinor: 500, approverRoleId: role }, { level: 2, minAmountMinor: 500, approverUserId: owner.userId }] })).status, 422);
    await post('/approval-policies', { ...base, levels: [{ level: 1, minAmountMinor: 0, approverRoleId: role }, { level: 2, minAmountMinor: 500, approverUserId: owner.userId }] }).expect(201);
    assert.equal((await post('/approval-policies', { ...base, code: 'EXP-2', levels: [{ level: 1, minAmountMinor: 0, approverRoleId: role }] })).status, 409);
  });

  test('company details are versioned and reference active masters', async () => {
    const company = await api().get('/api/v1/company').set(bearer(owner)).expect(200);
    await api().put('/api/v1/company').set(bearer(owner)).send({ tradingName: 'X' }).expect(422);
    await api().put('/api/v1/company').set(bearer(owner)).send({ version: company.body.data.version, timezone: 'Nowhere/City' }).expect(422);
    await api().put('/api/v1/company').set(bearer(owner)).send({ version: company.body.data.version, baseCurrencyId: '0123456789abcdef01234567' }).expect(422);
    const saved = await api().put('/api/v1/company').set(bearer(owner)).send({ version: company.body.data.version, tradingName: 'Marichi', modules: ['masters', 'trips', 'finance'] }).expect(200);
    assert.equal(saved.body.data.version, company.body.data.version + 1);
    await api().put('/api/v1/company').set(bearer(owner)).send({ version: company.body.data.version, tradingName: 'Stale' }).expect(409);
  });
});

describe('customers and partners', () => {
  test('party rules: one primary contact, reachable contacts, customers-only credit, tax ID with country', async () => {
    const base = { roles: ['customer'] };
    assert.equal((await post('/parties', { ...base, name: 'Two primaries', contacts: [{ name: 'A', phone: '+260971000001', isPrimary: true }, { name: 'B', phone: '+260971000002', isPrimary: true }] })).status, 422);
    assert.equal((await post('/parties', { ...base, name: 'Unreachable', contacts: [{ name: 'A' }] })).status, 422);
    assert.equal((await post('/parties', { roles: ['supplier'], name: 'Credit supplier', creditLimit: { amountMinor: 100, currencyId: ids.ZMW } })).status, 422);
    assert.equal((await post('/parties', { ...base, name: 'Tax without country', taxId: 'ABC12345' })).status, 422);
    assert.equal((await post('/parties', { ...base, name: 'Dup tax', taxId: '1002345678', countryId: ids.ZM })).status, 409);
    await post('/parties', { ...base, name: 'Same tax other country', taxId: '1002345678', countryId: ids.TZ }).expect(201);
    assert.equal((await post('/parties', { roles: ['customer', 'customer'], name: 'Dup roles' })).status, 422);
    assert.equal((await post('/parties', { roles: [], name: 'No roles' })).status, 422);
    const filtered = await get('/parties', { role: 'clearing_agent' }).expect(200);
    assert.ok(filtered.body.data.every((p: { roles: string[] }) => p.roles.includes('clearing_agent')));
  });
});

describe('vehicles and pairing', () => {
  test('plates are unique ignoring spaces; VIN and engine numbers are unique', async () => {
    const base = { makeId: ids.scania, vehicleTypeId: ids.rigid };
    assert.equal((await post('/vehicles', { ...base, code: 'T900', registrationNumber: 'ALC4821' })).status, 409);
    assert.equal((await post('/vehicles', { ...base, code: 'T901', registrationNumber: 'alc  4821' })).status, 409);
    assert.equal((await post('/vehicles', { ...base, code: 'T902', registrationNumber: 'NEW 1', vin: 'YS2R6X40005412345' })).status, 409);
    const fresh = await post('/vehicles', { ...base, code: 'T903', registrationNumber: 'new  0001' }).expect(201);
    assert.equal(fresh.body.data.registrationNumber, 'NEW 0001');
    assert.equal(fresh.body.data.registrationKey, undefined);
    assert.equal((await post('/vehicles', { ...base, code: 'T904', registrationNumber: '!!' })).status, 422);
  });

  test('vehicle rules: model matches make, ownership, consumption, sale and odometer', async () => {
    const base = { code: 'T950', registrationNumber: 'RULE 1', vehicleTypeId: ids.rigid };
    assert.equal((await post('/vehicles', { ...base, makeId: ids.volvo, modelId: ids.r460 })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, ownership: 'hired' })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, ownership: 'own', ownerPartyId: ids.leasing })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, ownership: 'hired', ownerPartyId: ids.zambezi })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, kmPerLLoaded: 3, kmPerLEmpty: 2 })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, purchase: { date: '2022-01-01' }, sale: { date: '2021-01-01' }, operationalStatus: 'sold' })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, operationalStatus: 'sold' })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, year: 1900 })).status, 422);
    assert.equal((await post('/vehicles', { ...base, makeId: ids.scania, registrationDate: day(30) })).status, 422);
    const v = await post('/vehicles', { ...base, makeId: ids.scania, odometerKm: 1000 }).expect(201);
    assert.equal((await patch(`/vehicles/${v.body.data.id}`, { version: 0, odometerKm: 900 })).status, 422);
    await patch(`/vehicles/${v.body.data.id}`, { version: 0, odometerKm: 1500 }).expect(200);
  });

  test('trailer compartments must match the type and fit the capacity', async () => {
    const base = { trailerTypeId: ids.tanker, registrationNumber: 'TNK 1' };
    assert.equal((await post('/trailers', { ...base, code: 'TR10' , capacityL: 30000 })).status, 422);
    assert.equal((await post('/trailers', { ...base, code: 'TR11', capacityL: 20000, compartments: [{ number: 1, capacityL: 15000 }, { number: 2, capacityL: 10000 }] })).status, 422);
    assert.equal((await post('/trailers', { ...base, code: 'TR12', compartments: [{ number: 1, capacityL: 1000 }, { number: 1, capacityL: 1000 }] })).status, 422);
    const derived = await post('/trailers', { ...base, code: 'TR13', compartments: [{ number: 1, capacityL: 15000 }, { number: 2, capacityL: 10000 }] }).expect(201);
    assert.equal(derived.body.data.capacityL, 25000);
    assert.equal((await post('/trailers', { code: 'TR14', registrationNumber: 'FLAT 9', trailerTypeId: ids.flatbed, capacityKg: 30000, compartments: [{ number: 1, capacityL: 10 }] })).status, 422);
    assert.equal((await post('/trailers', { code: 'TR15', registrationNumber: 'FLAT 10', trailerTypeId: ids.flatbed })).status, 422);
  });

  test('pairing is exclusive, keeps history, and maintains current partners', async () => {
    const v1 = await get(`/vehicles/${ids.v1}`).expect(200);
    assert.equal(v1.body.data.currentTrailerId, ids.t1);
    await post('/pairings', { vehicleId: ids.v1, trailerId: ids.t1 }).expect(409);
    const moved = await post('/pairings', { vehicleId: ids.v2, trailerId: ids.t1, reason: 'Swap' }).expect(201);
    assert.equal((await get(`/vehicles/${ids.v1}`)).body.data.currentTrailerId, undefined);
    assert.equal((await get(`/vehicles/${ids.v2}`)).body.data.currentTrailerId, ids.t1);
    assert.equal((await get(`/trailers/${ids.t1}`)).body.data.currentVehicleId, ids.v2);
    const history = await get('/pairings', { vehicleId: ids.v1, status: 'all' }).expect(200);
    assert.equal(history.body.data[0].open, false);
    assert.ok(history.body.data[0].to);
    await post(`/pairings/${moved.body.data.id}/end`, { to: '2000-01-01' }).expect(422);
    await post(`/pairings/${moved.body.data.id}/end`, { reason: 'Workshop' }).expect(200);
    await post(`/pairings/${moved.body.data.id}/end`, {}).expect(409);
    assert.equal((await get(`/trailers/${ids.t1}`)).body.data.currentVehicleId, undefined);
    const rigid = await post('/vehicles', { code: 'T960', registrationNumber: 'RIGID 1', makeId: ids.scania, vehicleTypeId: ids.rigid }).expect(201);
    await post('/pairings', { vehicleId: rigid.body.data.id, trailerId: ids.t2 }).expect(409);
    await post('/pairings', { vehicleId: ids.v1, trailerId: ids.t2, from: day(5) }).expect(422);
    await api().patch(`/api/v1/pairings/${moved.body.data.id}`).set(bearer(owner)).send({ version: 0 }).expect(404);
    await api().delete(`/api/v1/pairings/${moved.body.data.id}`).set(bearer(owner)).expect(404);
  });

  test('a paired trailer or truck cannot be archived', async () => {
    await post('/pairings', { vehicleId: ids.v1, trailerId: ids.t2 }).expect(201);
    const r = await post(`/trailers/${ids.t2}/archive`, {}).expect(409);
    assert.ok(r.body.error.details.usage.length);
  });
});

describe('drivers and compliance', () => {
  test('driver rules: age, licence dates, NRC format, blacklist reason, licence class vs truck', async () => {
    const base = { firstName: 'Test', lastName: 'Driver', phone: '+260971555000' };
    assert.equal((await post('/drivers', { ...base, dateOfBirth: day(-365 * 16) })).status, 422);
    assert.equal((await post('/drivers', { ...base, licence: { number: 'L-1', expiryDate: '2020-01-01', issueDate: '2021-01-01' } })).status, 422);
    assert.equal((await post('/drivers', { ...base, nationalId: { countryId: ids.ZM, typeKey: 'nrc', number: '12345' } })).status, 422);
    assert.equal((await post('/drivers', { ...base, nationalId: { countryId: ids.ZM, typeKey: 'passport', number: '123456/11/1' } })).status, 422);
    assert.equal((await post('/drivers', { ...base, blacklisted: true })).status, 422);
    assert.equal((await post('/drivers', { ...base, blacklistReason: 'x' })).status, 422);
    assert.equal((await post('/drivers', { ...base, phone: '0971555000' })).status, 422);
    const wrongClass = await post('/drivers', { ...base, licence: { number: 'L-2', classIds: [ids.lcC1], expiryDate: day(300) }, assignedVehicleId: ids.v2 });
    assert.equal(wrongClass.status, 422);
    assert.match(detailsOf(wrongClass), /licence classes/);
    const tooYoung = await post('/drivers', { ...base, dateOfBirth: day(-365 * 19), licence: { number: 'L-3', classIds: [ids.lcEC], expiryDate: day(300) } });
    assert.equal(tooYoung.status, 422);
    assert.equal((await post('/drivers', { ...base, nationalId: { countryId: ids.ZM, number: '123456/10/1' } })).status, 409);
    assert.equal((await post('/drivers', { ...base, assignedVehicleId: ids.v1 })).status, 409);
    const ok = await post('/drivers', { ...base, nationalId: { countryId: ids.ZM, typeKey: 'nrc', number: '654321/11/2' }, licence: { number: 'L-4', classIds: [ids.lcEC], expiryDate: day(10) } }).expect(201);
    assert.match(ok.body.data.code, /^DRV-\d{4}$/);
    assert.equal(ok.body.data.name, 'Test Driver');
    assert.equal(ok.body.data.compliance.licence.state, 'expiring');
    assert.equal(ok.body.data.compliance.passport.state, 'missing');
    const expiring = await get('/drivers', { licenceExpiringWithinDays: 30 }).expect(200);
    assert.ok(expiring.body.data.some((d: { id: string }) => d.id === ok.body.data.id));
  });

  test('custom fields on drivers are validated, and required fields need an impact check', async () => {
    const d = await get(`/drivers/${ids.martha}`).expect(200);
    assert.equal((await patch(`/drivers/${ids.martha}`, { version: d.body.data.version, custom: { union: 'unknown-union' } })).status, 422);
    assert.equal((await patch(`/drivers/${ids.martha}`, { version: d.body.data.version, custom: { notDefined: 'x' } })).status, 422);
    assert.equal((await patch(`/drivers/${ids.martha}`, { version: d.body.data.version, custom: { unionNumber: 'bad number!' } })).status, 422);
    const saved = await patch(`/drivers/${ids.martha}`, { version: d.body.data.version, custom: { union: 'ztu', unionNumber: 'ZTU-0042' } }).expect(200);
    assert.deepEqual(saved.body.data.custom, { union: 'ztu', unionNumber: 'ZTU-0042' });
    const cleared = await patch(`/drivers/${ids.martha}`, { version: saved.body.data.version, custom: { unionNumber: null } }).expect(200);
    assert.deepEqual(cleared.body.data.custom, { union: 'ztu' });
    const impact = await post('/field-definitions', { entity: 'drivers', key: 'shirtSize', label: 'Shirt size', type: 'select', options: ['S', 'M', 'L'], required: true }).expect(409);
    assert.ok(impact.body.error.details.impact.missing >= 2);
    const optional = await post('/field-definitions', { entity: 'drivers', key: 'shirtSize', label: 'Shirt size', type: 'select', options: ['S', 'M', 'L'] }).expect(201);
    assert.equal((await patch(`/field-definitions/${optional.body.data.id}`, { version: 0, type: 'text' })).status, 422);
    assert.equal((await post('/field-definitions', { entity: 'drivers', key: 'phone', label: 'Phone 2', type: 'text' })).status, 422);
    assert.equal((await post('/field-definitions', { entity: 'pairings', key: 'x', label: 'X', type: 'text' })).status, 422);
    assert.equal((await post('/field-definitions', { entity: 'drivers', key: 'favourite', label: 'Fav', type: 'select' })).status, 422);
    assert.equal((await post('/field-definitions', { entity: 'drivers', key: 'mentor', label: 'Mentor', type: 'reference', referenceMaster: 'spaceships' })).status, 422);
    await post('/field-definitions', { entity: 'drivers', key: 'mentor', label: 'Mentor', type: 'reference', referenceMaster: 'drivers' }).expect(201);
    const m2 = await get(`/drivers/${ids.martha}`).expect(200);
    await patch(`/drivers/${ids.martha}`, { version: m2.body.data.version, custom: { mentor: ids.joseph } }).expect(200);
    const usage = await get(`/drivers/${ids.joseph}/usage`).expect(200);
    assert.ok(usage.body.data.usage.some((u: { path: string }) => u.path === 'custom.mentor'));
    assert.equal((await patch(`/drivers/${ids.martha}`, { version: m2.body.data.version + 1, custom: { mentor: '0123456789abcdef01234567' } })).status, 422);
  });

  test('compliance documents match their type and holder, and report what is missing', async () => {
    assert.equal((await post('/compliance-documents', { documentTypeId: ids.dtLicence, subjectKind: 'vehicle', subjectId: ids.v1, number: 'X1', expiryDate: day(10) })).status, 422);
    assert.equal((await post('/compliance-documents', { documentTypeId: ids.dtRoadTax, subjectKind: 'vehicle', subjectId: ids.joseph, number: 'X2', expiryDate: day(10) })).status, 422);
    assert.equal((await post('/compliance-documents', { documentTypeId: ids.dtRoadTax, subjectKind: 'vehicle', subjectId: ids.v2, number: 'X3' })).status, 422);
    assert.equal((await post('/compliance-documents', { documentTypeId: ids.dtLicence, subjectKind: 'driver', subjectId: ids.martha, number: '!!', expiryDate: day(10) })).status, 422);
    assert.equal((await post('/compliance-documents', { documentTypeId: ids.dtRoadTax, subjectKind: 'vehicle', subjectId: ids.v2, number: 'X4', issueDate: day(5), expiryDate: day(2) })).status, 422);
    const check = await get('/compliance-documents/check', { subjectKind: 'vehicle', subjectId: ids.v2 }).expect(200);
    assert.equal(check.body.data.compliant, false);
    assert.deepEqual(check.body.data.items.map((i: { code: string; state: string }) => `${i.code}:${i.state}`).sort(), ['COMESA-CL:missing', 'FITNESS:missing', 'ROAD-TAX:missing']);
    assert.ok(check.body.data.blocking.some((b: { code: string; blocks: string }) => b.code === 'ROAD-TAX' && b.blocks === 'dispatch'));
    const v1 = await get('/compliance-documents/check', { subjectKind: 'vehicle', subjectId: ids.v1 }).expect(200);
    assert.equal(v1.body.data.items.find((i: { code: string }) => i.code === 'FITNESS').state, 'expiring');
    const expiring = await get('/compliance-documents/expiring', { withinDays: 30 }).expect(200);
    assert.ok(expiring.body.data.some((d: { number: string; expiry: { state: string } }) => d.number === 'FIT-77812' && d.expiry.state === 'expiring'));
    const doc = (await get('/compliance-documents', { search: 'RT-2026' })).body.data[0];
    assert.equal((await patch(`/compliance-documents/${doc.id}`, { version: doc.version, subjectId: ids.v2 })).status, 422);
    await get('/compliance-documents/check', { subjectKind: 'vehicle', subjectId: '0123456789abcdef01234567' }).expect(404);
  });
});

describe('cargo and trip operations', () => {
  test('product and shortage rules', async () => {
    const base = { groupId: ids.pgFuel, unitId: ids.L };
    assert.equal((await post('/products', { ...base, code: 'P1', name: 'P', volumeCorrected: true })).status, 422);
    assert.equal((await post('/products', { ...base, code: 'P2', name: 'P', referenceTemperatureC: 20 })).status, 422);
    assert.equal((await post('/products', { groupId: ids.pgFuel, unitId: ids.KG, code: 'P3', name: 'P', volumeCorrected: true, densityKgPerL: 0.8, referenceTemperatureC: 15 })).status, 422);
    assert.equal((await post('/products', { ...base, code: 'P4', name: 'P', hazard: { unClass: '10' } })).status, 422);
    assert.equal((await post('/products', { ...base, code: 'P5', name: 'P', referenceTemperatureC: 25, volumeCorrected: true, densityKgPerL: 0.8 })).status, 422);
    const sp = { code: 'SP1', name: 'SP', allowanceKind: 'percent', allowanceValue: 0.5, pricePerUnit: { amountMinor: 100, currencyId: ids.ZMW } };
    assert.equal((await post('/shortage-policies', sp)).status, 422);
    assert.equal((await post('/shortage-policies', { ...sp, productId: ids.diesel, productGroupId: ids.pgFuel })).status, 422);
    assert.equal((await post('/shortage-policies', { ...sp, productGroupId: ids.pgFuel, allowanceValue: 12 })).status, 422);
    assert.equal((await post('/shortage-policies', { ...sp, productGroupId: ids.pgFuel, bearer: 'shared' })).status, 422);
    assert.equal((await post('/shortage-policies', { ...sp, productGroupId: ids.pgFuel, pricePerUnit: undefined })).status, 422);
    await post('/shortage-policies', { ...sp, productGroupId: ids.pgFuel, bearer: 'shared', driverSharePercent: 50 }).expect(201);
    assert.equal((await post('/shortage-policies', { ...sp, code: 'SP2', productId: ids.diesel })).status, 409);
    assert.equal((await post('/pod-types', { code: 'P', name: 'Photo', evidence: 'photo', requiresPhoto: false })).status, 422);
    const photo = await post('/pod-types', { code: 'P2', name: 'Photo 2', evidence: 'photo' }).expect(201);
    assert.equal(photo.body.data.requiresPhoto, true);
  });

  /** A different, valid id: changing the last character to "0" gave the same id when it already was "0". */
  const otherId = (id: string) => id.replace(/.$/, (c) => (c === '0' ? '1' : '0'));

  test('trip stages: unique order, one final stage at the end', async () => {
    const final = (await get('/trip-stages', { tripTypeId: ids.ttFuel, sort: '-order' })).body.data[0];
    assert.equal(final.isFinal, true);
    assert.equal((await post('/trip-stages', { tripTypeId: ids.ttFuel, code: 'AFTER', name: 'After close', order: 7 })).status, 422);
    assert.equal((await post('/trip-stages', { tripTypeId: ids.ttFuel, code: 'DUP', name: 'Duplicate order', order: 2 })).status, 409);
    assert.equal((await post('/trip-stages', { tripTypeId: ids.ttFuel, code: 'plan', name: 'Same code', order: 4 })).status, 409);
    assert.equal((await post('/trip-stages', { tripTypeId: ids.ttFuel, code: 'F2', name: 'Second final', order: 5, isFinal: true })).status, 422);
    assert.equal((await post('/trip-stages', { tripTypeId: ids.ttFuel, code: 'RO', name: 'X', order: 5, isFinal: true, reopenable: true })).status, 422);
    assert.equal((await patch(`/trip-stages/${final.id}`, { version: final.version, tripTypeId: otherId(ids.ttFuel!) })).status, 422);
    assert.equal((await post('/trip-types', { code: 'FUEL2', name: 'Second default', cargoKind: 'liquid_bulk', isDefault: true })).status, 409);
  });

  test('fuel norms, budgets and the trip estimate', async () => {
    assert.equal((await post('/fuel-norms', { kmPerLLoaded: 2, kmPerLEmpty: 3 })).status, 422);
    assert.equal((await post('/fuel-norms', { vehicleTypeId: ids.prime, vehicleModelId: ids.r460, kmPerLLoaded: 2, kmPerLEmpty: 3 })).status, 422);
    assert.equal((await post('/fuel-norms', { vehicleTypeId: ids.rigid, kmPerLLoaded: 4, kmPerLEmpty: 3 })).status, 422);
    assert.equal((await post('/fuel-norms', { vehicleTypeId: ids.prime, kmPerLLoaded: 2, kmPerLEmpty: 3 })).status, 409);
    assert.equal((await post('/fuel-types', { code: 'BADFUEL', name: 'Bad', unitId: ids.KG })).status, 422);
    const byVehicle = await get('/trip-budgets/estimate', { routeId: ids.routeDar, vehicleId: ids.v1 }).expect(200);
    // Vehicle figures: 1961 km loaded at 2.2 + 1961 km empty at 2.9 = 1567.6 L, plus 6 % reserve = 1661.7, rounded up to 5 L.
    assert.equal(byVehicle.body.data.fuel.litres, 1665);
    assert.match(byVehicle.body.data.fuel.source, /vehicle ALC 4821/);
    assert.equal(byVehicle.body.data.cash.amountMinor, 534000);
    const byType = await get('/trip-budgets/estimate', { routeId: ids.routeDar, vehicleTypeId: ids.rigid }).expect(200);
    assert.equal(byType.body.data.fuel.litres, null);
    await get('/trip-budgets/estimate', { routeId: ids.routeDar, vehicleId: ids.v1, vehicleTypeId: ids.prime }).expect(422);
    await get('/trip-budgets/estimate', { routeId: '0123456789abcdef01234567' }).expect(404);
    assert.equal((await post('/trip-budgets', { code: 'B2', name: 'Dup items', routeId: ids.routeDar, currencyId: ids.ZMW, cashItems: [{ expenseItemId: ids.eiToll, amountMinor: 1 }, { expenseItemId: ids.eiToll, amountMinor: 2 }] })).status, 422);
    assert.equal((await post('/trip-budgets', { code: 'B3', name: 'Same route and type', routeId: ids.routeDar, vehicleTypeId: ids.prime, currencyId: ids.ZMW, cashItems: [] })).status, 409);
    const route = await post('/trip-budgets', { code: 'B4', name: 'Route default', routeId: ids.routeDar, currencyId: ids.ZMW, cashItems: [{ expenseItemId: ids.eiToll, amountMinor: 700 }] }).expect(201);
    assert.equal(route.body.data.totalCashMinor, 700);
  });

  test('advance policy amounts match the basis and share a currency', async () => {
    const max = { amountMinor: 1000, currencyId: ids.ZMW };
    assert.equal((await post('/advance-policies', { code: 'A1', name: 'A', basis: 'per_day', maxAmount: max })).status, 422);
    assert.equal((await post('/advance-policies', { code: 'A2', name: 'A', basis: 'fixed', fixedAmount: { amountMinor: 2000, currencyId: ids.ZMW }, maxAmount: max })).status, 422);
    assert.equal((await post('/advance-policies', { code: 'A3', name: 'A', basis: 'route_budget', fixedAmount: max, maxAmount: max })).status, 422);
    assert.equal((await post('/advance-policies', { code: 'A4', name: 'A', basis: 'per_day', perDayAmount: { amountMinor: 100, currencyId: ids.USD }, maxAmount: max })).status, 422);
    await post('/advance-policies', { code: 'A5', name: 'A', basis: 'per_day', perDayAmount: { amountMinor: 100, currencyId: ids.ZMW }, maxAmount: max }).expect(201);
    assert.equal((await post('/advance-policies', { code: 'A6', name: 'A', basis: 'fixed', fixedAmount: { amountMinor: 1.5, currencyId: ids.ZMW }, maxAmount: max })).status, 422);
  });
});

describe('messages and configuration', () => {
  test('templates check placeholders, channel rules and SMS length; preview renders', async () => {
    const base = { code: 'T1', name: 'T', event: 'trip.loaded' };
    assert.equal((await post('/message-templates', { ...base, channel: 'sms', body: 'Hello {{unknown.var}}' })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'sms', body: 'Hello {{driver.name}' })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'email', body: 'No subject' })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'sms', subject: 'S', body: 'x' })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'sms', body: 'x', buttons: [{ label: 'OK', action: 'reply' }] })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'sms', body: 'x'.repeat(1000) })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'whatsapp', body: 'x', buttons: [{ label: 'A', action: 'reply' }, { label: 'a', action: 'reply' }] })).status, 422);
    assert.equal((await post('/message-templates', { ...base, channel: 'whatsapp', body: 'x', buttons: [1, 2, 3, 4].map((n) => ({ label: `B${n}`, action: 'reply' })) })).status, 422);
    const preview = await post(`/message-templates/${ids.mtApproval}/preview`, { variables: [{ name: 'driver.name', value: 'Martha Phiri' }, { name: 'amount', value: '1,200.00' }] }).expect(200);
    assert.match(preview.body.data.body, /^Martha Phiri needs ZMW 1,200.00 for TRIP\/26\/0137/);
    assert.ok(preview.body.data.sampleValuesUsedFor.includes('route.name'));
    assert.equal(preview.body.data.delivery, 'WhatsApp connection');
    const sms = await post(`/message-templates/${ids.mtSms}/preview`, {}).expect(200);
    assert.equal(sms.body.data.sms.encoding, 'GSM-7');
    assert.equal(sms.body.data.sms.segments, 1);
    const email = await post(`/message-templates/${ids.mtEmail}/preview`, {}).expect(200);
    assert.equal(email.body.data.delivery, 'E-mail connection');
    assert.ok(email.body.data.subject.includes('ALC 4821'));
    await post(`/message-templates/${ids.mtSms}/preview`, { variables: [{ name: 'nope', value: 'x' }] }).expect(422);
  });

  test('notification rules match templates to channel and event', async () => {
    const role = (await find(owner, 'roles', 'finance')).id;
    const base = { code: 'N1', name: 'N', event: 'trip.dispatched', recipients: [{ kind: 'role', roleId: role }] };
    assert.equal((await post('/notification-rules', { ...base, templates: [{ channel: 'whatsapp', templateId: ids.mtSms }] })).status, 422);
    assert.equal((await post('/notification-rules', { ...base, event: 'trip.loaded', templates: [{ channel: 'sms', templateId: ids.mtSms }] })).status, 422);
    assert.equal((await post('/notification-rules', { ...base, recipients: [{ kind: 'role' }], templates: [{ channel: 'app' }] })).status, 422);
    assert.equal((await post('/notification-rules', { ...base, templates: [{ channel: 'app', templateId: ids.mtSms }] })).status, 422);
    assert.equal((await post('/notification-rules', { ...base, templates: [{ channel: 'app' }, { channel: 'app' }] })).status, 422);
    assert.equal((await post('/notification-rules', { ...base, templates: [{ channel: 'app' }], repeatEveryMinutes: 30 })).status, 422);
    await post('/notification-rules', { ...base, templates: [{ channel: 'sms', templateId: ids.mtSms }, { channel: 'app' }] }).expect(201);
  });

  test('lists, print layouts, and custom masters with records', async () => {
    assert.equal((await post('/lists', { code: 'L1', name: 'L', values: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] })).status, 422);
    const values = await get('/lists/by-code/unions').expect(200);
    assert.deepEqual(values.body.data.values.map((v: { value: string }) => v.value), ['ztu', 'none']);
    await get('/lists/by-code/NOPE').expect(404);
    assert.equal((await post('/print-layouts', { code: 'PL', name: 'P', document: 'invoice', sections: [{ key: 'a', label: 'A', visible: true, order: 1 }, { key: 'a', label: 'B', visible: true, order: 2 }] })).status, 422);
    assert.equal((await post('/print-layouts', { code: 'PL2', name: 'Second default', document: 'trip_sheet', isDefault: true })).status, 409);

    assert.equal((await post('/custom-masters', { code: 'vehicles', name: 'Clash', titleField: 'a', fields: [{ key: 'a', label: 'A', type: 'text', required: true }] })).status, 422);
    assert.equal((await post('/custom-masters', { code: 'cards', name: 'Bad title', titleField: 'a', fields: [{ key: 'a', label: 'A', type: 'number', required: true }] })).status, 422);
    assert.equal((await post('/custom-masters', { code: 'cards', name: 'Dup keys', titleField: 'a', fields: [{ key: 'a', label: 'A', type: 'text', required: true }, { key: 'a', label: 'B', type: 'text' }] })).status, 422);
    const base = `/custom-masters/${ids.healthCards}/records`;
    const list = await get(base).expect(200);
    assert.equal(list.body.data[0].title, 'HC-001');
    assert.equal((await post(base, { data: { cardNumber: 'HC-002' } })).status, 422);
    assert.equal((await post(base, { data: { cardNumber: 'HC-002', driver: ids.joseph, expiryDate: 'soon' } })).status, 422);
    assert.equal((await post(base, { data: { cardNumber: 'HC-002', driver: '0123456789abcdef01234567', expiryDate: day(10) } })).status, 422);
    assert.equal((await post(base, { data: { cardNumber: 'HC-002', driver: ids.joseph, expiryDate: day(10), extra: 1 } })).status, 422);
    const rec = await post(base, { data: { cardNumber: 'HC-002', driver: ids.martha, expiryDate: day(10) } }).expect(201);
    const upd = await api().patch(`/api/v1${base}/${rec.body.data.id}`).set(bearer(owner)).send({ version: 0, data: { clinic: 'Ndola Clinic' } }).expect(200);
    assert.equal(upd.body.data.data.cardNumber, 'HC-002');
    assert.equal(upd.body.data.data.clinic, 'Ndola Clinic');
    await api().patch(`/api/v1${base}/${rec.body.data.id}`).set(bearer(owner)).send({ version: 1, data: { cardNumber: null } }).expect(422);
    const other = await post('/custom-masters', { code: 'checkpoints', name: 'Police checkpoints', titleField: 'name', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] }).expect(201);
    await get(`/custom-masters/${other.body.data.id}/records/${rec.body.data.id}`).expect(404);
    const usage = await get(`/drivers/${ids.martha}/usage`).expect(200);
    assert.ok(usage.body.data.usage.some((u: { master: string }) => u.master === 'custom-records'));
    const cm = await get(`/custom-masters/${ids.healthCards}`).expect(200);
    const addRequired = await patch(`/custom-masters/${ids.healthCards}`, { version: cm.body.data.version, fields: [...cm.body.data.fields, { key: 'grade', label: 'Grade', type: 'text', required: true }] });
    assert.equal(addRequired.status, 409);
    const retype = await patch(`/custom-masters/${ids.healthCards}`, { version: cm.body.data.version, fields: cm.body.data.fields.map((f: { key: string }) => (f.key === 'clinic' ? { ...f, type: 'number' } : f)) });
    assert.equal(retype.status, 409);
    assert.equal((await post(`/custom-masters/${ids.healthCards}/archive`, {})).status, 409);
  });

  test('forms get select choices from a field\'s options or its list', async () => {
    const masters = await get('/meta/masters').expect(200);
    const drivers = masters.body.data.find((m: { key: string }) => m.key === 'drivers');
    const union = drivers.customFields.find((f: { key: string }) => f.key === 'union');
    assert.deepEqual(union.choices.map((c: { value: string }) => c.value), ['ztu', 'none']);
    assert.ok(union.choices.every((c: { label: string }) => c.label));

    const cm = await post('/custom-masters', {
      code: 'inspections', name: 'Inspections', titleField: 'ref',
      fields: [
        { key: 'ref', label: 'Ref', type: 'text', required: true },
        { key: 'grade', label: 'Grade', type: 'select', options: ['A', 'B'] },
        { key: 'union', label: 'Union', type: 'select', listId: ids.listUnions },
      ],
    }).expect(201);
    const fields = await get(`/custom-masters/${cm.body.data.id}/fields`).expect(200);
    const by = (key: string) => fields.body.data.find((f: { key: string }) => f.key === key);
    assert.deepEqual(by('grade').choices, [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]);
    assert.deepEqual(by('union').choices.map((c: { value: string }) => c.value), ['ztu', 'none']);
    assert.equal(by('ref').choices, undefined);
    await get('/custom-masters/0123456789abcdef01234567/fields').expect(404);
  });
});
