import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fieldLabel, fullLabel } from '../src/core/masters/labels.js';
import { api, bearer, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

/** Field names as people read them (#51): one rule for the form, the list and the import template. */
describe('field labels', () => {
  test('sentence case, links without "Id", units in brackets, acronyms in capitals', () => {
    const cases: [string, boolean | undefined, string][] = [
      ['registrationNumber', undefined, 'Registration number'],
      ['makeId', true, 'Make'],
      ['homeBranchId', true, 'Home branch'],
      ['currencyIds', true, 'Currencies'],
      ['nationalId', false, 'National ID'],
      ['vin', undefined, 'VIN'],
      ['gpsDeviceId', true, 'GPS device'],
      ['photoUrl', undefined, 'Photo URL'],
      ['tankCapacityL', undefined, 'Tank capacity (L)'],
      ['odometerKm', undefined, 'Odometer (km)'],
      ['geofenceRadiusM', undefined, 'Geofence radius (m)'],
      ['densityKgPerL', undefined, 'Density (kg/L)'],
      ['referenceTemperatureC', undefined, 'Reference temperature (°C)'],
      ['total', undefined, 'Total'],
      ['tareKg', undefined, 'Tare (kg)'],
      ['kmPerLLoaded', undefined, 'Km per L loaded'],
      ['status', undefined, 'Status'],
      ['email', undefined, 'E-mail'],
      ['contactEmail', undefined, 'Contact e-mail'],
      ['minAmountMinor', undefined, 'Minimum amount'],
      ['maxPercentPerSettlement', undefined, 'Maximum percent per settlement'],
    ];
    for (const [key, link, want] of cases) assert.equal(fieldLabel(key, link), want, key);
  });

  test('a nested path reads as one phrase', () => {
    assert.equal(fullLabel('address.cityId', true), 'Address city');
    assert.equal(fullLabel('fuel.tankCapacityL'), 'Fuel tank capacity (L)');
  });
});

describe('masters metadata carries the labels', () => {
  let owner: Session;
  before(async () => { await startDatabase(); owner = await signUp('Owner'); });
  after(stopDatabase);

  test('every field has a label, the same one the import template uses', async () => {
    const masters = (await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data as { key: string; fields: { path: string; label: string }[] }[];
    const vehicles = masters.find((m) => m.key === 'vehicles')!;
    const by = (path: string) => vehicles.fields.find((f) => f.path === path)?.label;
    assert.equal(by('registrationNumber'), 'Registration number');
    assert.equal(by('makeId'), 'Make');
    assert.ok(masters.every((m) => m.fields.every((f) => typeof f.label === 'string' && f.label.length > 0)));
    const template = (await api().get('/api/v1/meta/import/vehicles/template').set(bearer(owner)).expect(200)).text;
    assert.ok(template.includes('Registration number *'));
  });

  test('a master can name its fields and its choices', async () => {
    const masters = (await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data as { key: string; fields: { path: string; label: string; choiceLabels?: Record<string, string> }[] }[];
    const field = (key: string, path: string) => masters.find((m) => m.key === key)!.fields.find((f) => f.path === path)!;
    assert.equal(field('approval-policies', 'levels.minAmountMinor').label, 'Applies from');
    assert.equal(field('message-templates', 'event').choiceLabels?.['trip.loaded'], 'A truck is loaded');
    assert.equal(field('message-templates', 'channel').choiceLabels?.whatsapp, 'WhatsApp');
  });
});
