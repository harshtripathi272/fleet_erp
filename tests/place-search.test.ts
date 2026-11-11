import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase } from './helpers.js';

/**
 * A new place is found by name or address and pinned on a map, not typed as latitude and longitude (#102);
 * a new company's usual lists have trailer types and its country's towns; an address's first line has a name.
 */
before(startDatabase);
after(stopDatabase);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function kenyanCompany() {
  await resetDatabase();
  const owner = await signUp('Owner');
  const kes = (await api().post('/api/v1/currencies').set(bearer(owner)).send({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', minorUnits: 2 }).expect(201)).body.data;
  const ke = (await api().post('/api/v1/countries').set(bearer(owner)).send({ code: 'KE', iso3: 'KEN', name: 'Kenya', currencyId: kes.id }).expect(201)).body.data;
  await api().put('/api/v1/company').set(bearer(owner)).send({ legalName: 'Rift Valley Bulk', baseCurrencyId: kes.id, countryId: ke.id, timezone: 'Africa/Nairobi' }).expect(200);
  return { owner, ke };
}

describe('finding a place', () => {
  test('search goes to OpenStreetMap by default, in the company\'s country, and matches the company\'s city', async () => {
    const { owner } = await kenyanCompany();
    await api().post('/api/v1/meta/starter-lists').set(bearer(owner)).send({}).expect(201);
    const asked: string[] = [];
    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      asked.push(String(url));
      assert.match(String((init.headers as Record<string, string>)['user-agent']), /fleet-erp/, 'Nominatim asks for a named app');
      return new Response(JSON.stringify([
        { lat: '-0.2827', lon: '36.0662', name: 'Nakuru Depot', display_name: 'Nakuru Depot, Lanet Road, Nakuru, Nakuru County, Kenya', address: { city: 'Nakuru', state: 'Nakuru County', country_code: 'ke' } },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const found = (await api().get('/api/v1/places/find').query({ q: 'Nakuru depot' }).set(bearer(owner)).expect(200)).body.data;
    assert.equal(found.searchedIn, 'KE');
    assert.match(asked[0]!, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
    assert.match(asked[0]!, /countrycodes=ke/);
    const [hit] = found.results;
    assert.deepEqual([hit.name, hit.lat, hit.lng, hit.city], ['Nakuru Depot', -0.2827, 36.0662, 'Nakuru']);
    const nakuru = (await api().get('/api/v1/cities').query({ search: 'Nakuru' }).set(bearer(owner)).expect(200)).body.data[0];
    assert.equal(hit.cityId, nakuru.id, 'the usual lists brought Nakuru, and the hit is matched to it');
  });

  test('a picked place\'s town is added to the cities with its region, once', async () => {
    const { owner } = await kenyanCompany();
    const first = (await api().post('/api/v1/places/city-for').set(bearer(owner)).send({ city: 'Athi River', region: 'Machakos County', countryCode: 'KE', lat: -1.4563, lng: 36.9784 }).expect(200)).body.data;
    assert.equal(first.created, true);
    const again = (await api().post('/api/v1/places/city-for').set(bearer(owner)).send({ city: 'athi river', region: 'Machakos County', countryCode: 'KE' }).expect(200)).body.data;
    assert.deepEqual([again.cityId, again.created], [first.cityId, false]);
    const city = (await api().get(`/api/v1/cities/${first.cityId}`).set(bearer(owner)).expect(200)).body.data;
    const province = (await api().get(`/api/v1/provinces/${city.provinceId}`).set(bearer(owner)).expect(200)).body.data;
    assert.equal(province.name, 'Machakos County');
    const abroad = (await api().post('/api/v1/places/city-for').set(bearer(owner)).send({ city: 'Kampala', countryCode: 'UG' }).expect(200)).body.data;
    assert.equal(abroad.cityId, null, 'no country is added behind the company\'s back');
  });

  test('a search that fails says so, and the place can still be pinned by hand', async () => {
    const { owner } = await kenyanCompany();
    globalThis.fetch = (async () => new Response('busy', { status: 503 })) as typeof fetch;
    const res = await api().get('/api/v1/places/find').query({ q: 'Mombasa port' }).set(bearer(owner)).expect(503);
    assert.match(res.body.error.message, /address search didn't answer/);
  });
});

describe('the usual lists for a first trailer and town', () => {
  test('trailer types say what they carry, the country\'s towns come in, more place types, and Line1 is named', async () => {
    const { owner } = await kenyanCompany();
    await api().post('/api/v1/meta/starter-lists').set(bearer(owner)).send({}).expect(201);
    const list = async (key: string) => (await api().get(`/api/v1/${key}`).query({ limit: 100 }).set(bearer(owner)).expect(200)).body.data as Record<string, any>[];
    const tanker = (await list('trailer-types')).find((t) => t.code === 'TANKER')!;
    assert.deepEqual([tanker.cargoKinds, tanker.hasCompartments], [['liquid_bulk'], true]);
    const towns = (await list('cities')).map((c) => c.name);
    for (const town of ['Nairobi', 'Mombasa', 'Nakuru', 'Malaba']) assert.ok(towns.includes(town), town);

    const masters = (await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data as Record<string, any>[];
    const places = masters.find((m) => m.key === 'places')!;
    assert.equal(places.fields.find((f: { path: string }) => f.path === 'address.line1').label, 'Street address');
    const type = places.fields.find((f: { path: string }) => f.path === 'type');
    for (const kind of ['factory', 'plant', 'warehouse']) assert.ok(JSON.stringify(type).includes(kind), kind);
    const trailerTypes = masters.find((m) => m.key === 'trailer-types')!;
    assert.match(trailerTypes.fields.find((f: { path: string }) => f.path === 'cargoKinds').hint, /Liquid bulk/);

    await api().post('/api/v1/places').set(bearer(owner)).send({ code: 'ATHI-PLANT', name: 'Athi River cement plant', type: 'plant', location: { lat: -1.4563, lng: 36.9784 } }).expect(201);
  });
});
