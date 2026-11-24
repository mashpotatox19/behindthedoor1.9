// Offline tests for src/area.js. Run: node --test tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ URLSearchParams });
for (const f of ['analyzer.js', 'area.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx);
}
const A = ctx.BTD_AREA;
const { analyze } = ctx.BTD;
const LAF = A.AREAS[0];

test('finds the area from a zip, or a city with the state', () => {
  assert.equal(A.areaFor('2110 McCormick Road West Lafayette, IN 47906'), LAF);
  assert.equal(A.areaFor('West Lafayette, IN'), LAF);
  assert.equal(A.areaFor('456 Sample Rd, Lafayette, Indiana'), LAF);
  assert.equal(A.areaFor('10 Main St, Lafayette, CO 80026'), null);
  assert.equal(A.areaFor('Lafayette, LA'), null);
  assert.equal(A.areaFor('222 2nd Street, Baltimore, MD'), null);
  assert.equal(A.areaFor(''), null);
});

test('HUD 2026 rents, with 15% per bedroom above four', () => {
  assert.equal(A.rentFor(LAF, 0), 894);
  assert.equal(A.rentFor(LAF, 2), 1242);
  assert.equal(A.rentFor(LAF, 4), 1992);
  assert.equal(A.rentFor(LAF, 5), Math.round(1992 * 1.15));
  assert.equal(A.rentFor(LAF, null), null);
});

test('compares the rent fairly', () => {
  const typical = A.compareRent({ priceAmount: 1195, pricePeriod: 'month', beds: 2 }, LAF);
  assert.equal(typical.verdict, 'typical');
  assert.match(typical.text, /\$1,195 a month.*\$1,242/);

  const bait = A.compareRent({ priceAmount: 500, pricePeriod: 'month', beds: 2 }, LAF);
  assert.equal(bait.verdict, 'far-below');
  assert.match(bait.text, /see the place in person/i);

  // Per person: compared with one person's share of a home that size.
  const station = A.compareRent({ priceAmount: 595, priceHigh: 820, pricePeriod: 'month', beds: 2, bedsMax: 4, perPerson: true }, LAF);
  // $595 is a bed in the 4-bedroom plan: compared with a quarter of a 4-bed.
  assert.equal(station.reference, 498);
  assert.equal(station.verdict, 'typical');
  assert.match(station.text, /starts at \$595 a month per person/);

  // A room in a home of unknown size: a share of a 3-bed.
  assert.equal(A.compareRent({ priceAmount: 875, pricePeriod: 'month', isRoom: true }, LAF).verdict, 'above');

  // Not comparable: no bedrooms, weekly price, another currency, no price.
  assert.equal(A.compareRent({ priceAmount: 1200, pricePeriod: 'month' }, LAF), null);
  assert.equal(A.compareRent({ priceAmount: 300, pricePeriod: 'day', beds: 1 }, LAF), null);
  // Weekly and every-two-weeks rent is compared as a monthly amount.
  assert.match(A.compareRent({ priceAmount: 300, pricePeriod: 'week', beds: 1 }, LAF).text, /\$300 a week \(about \$1,300 a month\)/);
  assert.equal(A.compareRent({ priceAmount: 450, pricePeriod: '2 weeks', beds: 1 }, LAF).verdict, 'typical');
  assert.equal(A.compareRent({ priceAmount: 900, beds: 1, priceCurrency: '£' }, LAF), null);
  assert.equal(A.compareRent({ beds: 1 }, LAF), null);
  assert.equal(A.compareRent({ priceAmount: 900, beds: 1 }, null), null);
});

test('the low-rent warning uses the area when known', () => {
  const base = { priceText: '$700 / month', priceAmount: 700, pricePeriod: 'month', beds: 3, fullText: 'Nice home' };
  // $700 for a 3-bed is 0.47 of the area's $1,489, and the advice says so.
  const withArea = Object.assign({}, base, { rent: A.compareRent(base, LAF) });
  assert.ok(analyze(withArea).flags.some((f) => f.id === 'low-price'));
  assert.match(analyze(withArea).flags.find((f) => f.id === 'low-price').advice, /\$1,489/);
  // $900 for a 2-bed here is a little low, not a warning.
  const fine = { priceText: '$900 / month', priceAmount: 900, pricePeriod: 'month', beds: 2, fullText: 'Nice home' };
  fine.rent = A.compareRent(fine, LAF);
  assert.equal(analyze(fine).flags.length, 0);
});

test('distance and trip to campus', () => {
  // Station 21's parcel centre (county records).
  const trip = A.campusTrip(LAF, 40.44712, -86.94282);
  assert.ok(trip.miles > 2 && trip.miles < 2.5, String(trip.miles));
  assert.match(trip.text, /miles from Purdue Memorial Union in a straight line/);
  assert.match(trip.text, /roughly 60 minutes on foot or 20 by bike/);
  // Cheswick Village, 3.4 miles out: bike or bus, not a daily walk.
  assert.match(A.campusTrip(LAF, 40.4717, -86.9268).text, /by bike; too far to walk/);
  // Across the river and beyond: drive or bus.
  assert.match(A.campusTrip(LAF, 40.3, -86.7).text, /drive or take the bus/);
  assert.equal(A.campusTrip(LAF, NaN, 1), null);
  assert.equal(A.campusTrip(LAF, 41.88, -87.63), null, 'Chicago is not near campus');
});

test('directions link goes only to Google Maps, with the address encoded', () => {
  const url = new URL(A.directionsUrl(LAF, '2110 McCormick Rd, West Lafayette, IN 47906'));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.searchParams.get('travelmode'), 'transit');
  assert.equal(url.searchParams.get('origin'), '2110 McCormick Rd, West Lafayette, IN 47906');
  assert.equal(A.directionsUrl(LAF, ''), '');
});

test('"per person" on a studio or 1-bed is the whole unit', () => {
  const studio = A.compareRent({ priceAmount: 1150, pricePeriod: 'month', beds: 0, bedsMax: 4, perPerson: true }, LAF);
  assert.equal(studio.reference, 894);
  assert.equal(studio.verdict, 'typical');
  const one = A.compareRent({ priceAmount: 1150, pricePeriod: 'month', beds: 1, bedsMax: 4, perPerson: true }, LAF);
  assert.equal(one.reference, 1032);
  assert.equal(one.verdict, 'typical');
  // The Pines: $499 per person in a 3-4 bed building.
  assert.equal(A.compareRent({ priceAmount: 499, pricePeriod: '', beds: 3, bedsMax: 4, perPerson: true }, LAF).verdict, 'typical');
  // Alight: $499 - $1,349, studio to 4 beds, per bed: $499 is a bed in a 4-bedroom.
  const alight = A.compareRent({ priceAmount: 499, priceHigh: 1349, pricePeriod: 'month', beds: 0, bedsMax: 4, perPerson: true }, LAF);
  assert.equal(alight.reference, 498);
  assert.equal(alight.verdict, 'typical');
  // A nightly stay is never compared with monthly rents.
  assert.equal(A.compareRent({ priceAmount: 105, pricePeriod: 'night', beds: 2 }, LAF), null);
});

test('nearest bus stop and supermarket from the bundled open data', () => {
  const ctx2 = vm.createContext({ URLSearchParams });
  for (const f of ['places-data.js', 'area.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx2);
  const A2 = ctx2.BTD_AREA;
  // Station 21's parcel centre.
  const bus = A2.nearestStop(40.44712, -86.94282);
  assert.ok(bus && bus.miles < 0.5, 'a stop within half a mile');
  assert.ok(bus.routes.length >= 1);
  assert.match(bus.text, /mi \(about \d+ min walk\)\. Routes? /);
  assert.doesNotMatch(bus.text, /BUS\d/, 'stop codes are stripped');
  const shop = A2.nearestGrocery(40.44712, -86.94282);
  assert.ok(shop && shop.miles < 3);
  // Far away (Chicago): nothing claimed.
  assert.equal(A2.nearestStop(41.88, -87.63), null);
  assert.equal(A2.nearestGrocery(41.88, -87.63), null);
  // Every stop has a name, a position in the county, and routes.
  for (const s of ctx2.BTD_PLACES.transit.stops) {
    assert.ok(s[0] && s[1] > 40.1 && s[1] < 40.7 && s[2] > -87.2 && s[2] < -86.6 && s[3], JSON.stringify(s));
  }
});
