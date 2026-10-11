import assert from 'node:assert/strict';
import test from 'node:test';
import { countries, findCountryCodes, isKnownCountryCode, sortedCountries } from '../src/data/countries';

test('country list is complete, unique and alphabetical', () => {
  assert.equal(countries.length, 197);
  assert.equal(new Set(countries.map((country) => country.code)).size, countries.length);
  assert.equal(new Set(countries.map((country) => country.name)).size, countries.length);
  const names = sortedCountries.map((country) => country.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
  for (const code of ['NL', 'UA', 'US', 'GB', 'PS', 'XK', 'TW', 'VA', 'SS', 'CD', 'CG']) assert.ok(isKnownCountryCode(code), code);
});

test('every country is found by its own name', () => {
  for (const country of countries) {
    assert.ok(findCountryCodes(`News from ${country.name} today`).includes(country.code), country.name);
  }
});

test('overlapping names resolve to the right country', () => {
  assert.deepEqual(findCountryCodes('Papua New Guinea'), ['PG']);
  assert.deepEqual(findCountryCodes('Equatorial Guinea and Guinea-Bissau'), ['GQ', 'GW']);
  assert.deepEqual(findCountryCodes('Northern Ireland'), ['GB']);
  assert.deepEqual(findCountryCodes('Dominican Republic'), ['DO']);
  assert.deepEqual(findCountryCodes('New Mexico'), []);
});
