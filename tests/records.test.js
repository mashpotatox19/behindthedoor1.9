// Offline tests for src/records.js. Run: node --test tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ URLSearchParams });
for (const f of ['analyzer.js', 'records.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx);
}
const R = ctx.BTD_RECORDS;
const { analyze } = ctx.BTD;
const plain = (o) => JSON.parse(JSON.stringify(o));
const TIPP = R.SOURCES[0];
const where = (url) => new URL(url).searchParams.get('where');
const answer = (rows) => ({ features: rows.map((a) => ({ attributes: a })) });
const row = (o) =>
  Object.assign({ Address: '350 S GRANT ST', Loccity: 'WEST LAFAYETTE', LoczipCode: '47906', mdeededOwner: '33 PARTNERS LLC', mpropertyclass: '4 to 19 Family Apartments', mconfidential: 'N' }, o);

test('parses common listing address formats', () => {
  assert.deepEqual(plain(R.parseAddress('440 S. Grant St., Apt 3, West Lafayette, IN 47906')), {
    number: '440', direction: 'S', street: 'GRANT', city: 'west lafayette', zip: '47906', state: 'IN',
  });
  assert.deepEqual(plain(R.parseAddress('1201 Example Ave #4, Lafayette, IN 47904')), {
    number: '1201', direction: '', street: 'EXAMPLE', city: 'lafayette', zip: '47904', state: 'IN',
  });
  assert.equal(R.parseAddress('5141 S 100 E, Lafayette, IN').street, '100');
  assert.equal(R.parseAddress('123 West St, Lafayette, IN').street, 'WEST');
  assert.equal(R.parseAddress('123 Example St, West Lafayette, IN').city, 'west lafayette');
  assert.equal(R.parseAddress('Lafayette, IN'), null);
  assert.deepEqual(plain(R.parseAddress('2110 McCormick Road West Lafayette, IN 47906')), {
    number: '2110', direction: '', street: 'MCCORMICK', city: 'west lafayette', zip: '47906', state: 'IN',
  });
  assert.equal(R.parseAddress(''), null);
});

test('only Tippecanoe County addresses are looked up', () => {
  assert.equal(R.sourceFor(R.parseAddress('440 S Grant St, West Lafayette, IN 47906')).id, 'tippecanoe-in');
  assert.equal(R.sourceFor(R.parseAddress('456 Sample Rd, Lafayette, IN')).id, 'tippecanoe-in');
  assert.equal(R.sourceFor(R.parseAddress('222 2nd Street, Baltimore, MD')), null);
  assert.equal(R.sourceFor(R.parseAddress('10 Main St, Lafayette, CO 80026')), null);
  assert.equal(R.sourceFor(R.parseAddress('10 Main St, Lafayette, LA')), null);
});

test('query is built from letters and digits only (no injection)', () => {
  const addr = R.parseAddress("350 S Grant'; DELETE FROM x; -- St, West Lafayette, IN 47906");
  const w = where(R.buildQueryUrl(TIPP, addr));
  const inner = w.match(/LIKE '([^']*)'/)[1];
  assert.ok(!/DELETE|;/.test(inner) || /^[A-Z0-9 %]+$/.test(inner));
  assert.match(inner, /^[A-Z0-9 %]+$/);
  assert.equal((w.match(/'/g) || []).length % 2, 0);
  assert.ok(!/;|--/.test(w));
  assert.equal(where(R.buildQueryUrl(TIPP, R.parseAddress('350 S Grant St, West Lafayette, IN 47906'))), "(Address LIKE '350 GRANT%' OR Address LIKE '350 % GRANT%') AND LoczipCode = '47906'");
  // "22 N 2nd St" must not match "22 N 22ND ST".
  const w2 = where(R.buildQueryUrl(TIPP, R.parseAddress('22 N 2nd St, Lafayette, IN 47901')));
  const like = (pattern, value) => new RegExp('^' + pattern.replace(/%/g, '.*') + '$').test(value);
  const pats = [...w2.matchAll(/LIKE '([^']*)'/g)].map((m) => m[1]);
  assert.ok(pats.some((p) => like(p, '22 N 2ND ST')));
  assert.ok(!pats.some((p) => like(p, '22 N 22ND ST')));
  const url = new URL(R.buildQueryUrl(TIPP, R.parseAddress('350 S Grant St, West Lafayette, IN 47906')));
  assert.equal(url.origin, 'https://maps.tippecanoe.in.gov');
  assert.ok(!/mail/i.test(url.searchParams.get('outFields')), 'never asks for mailing addresses');
});

test('owner found, lister matches', () => {
  const addr = R.parseAddress('350 S Grant St, West Lafayette, IN 47906');
  const r = R.interpret(TIPP, addr, answer([row({})]), '33 Partners Property Management');
  assert.equal(r.status, 'found');
  assert.equal(r.owner, '33 PARTNERS LLC');
  assert.equal(r.matches, true);
  assert.equal(r.flags.length, 0);
});

test('individual owner, different lister: medium warning that lowers the rating', () => {
  const addr = R.parseAddress('12 Elm St, Lafayette, IN 47904');
  const r = R.interpret(TIPP, addr, answer([row({ Address: '12 ELM ST', mdeededOwner: 'SMITH JOHN A & MARY B', mpropertyclass: 'Res 1 family dwelling' })]), 'Jordan Example');
  assert.equal(r.matches, false);
  assert.equal(r.flags[0].id, 'owner-mismatch');
  assert.equal(r.flags[0].severity, 'medium');
  const report = analyze({ fullText: 'Nice house for rent', extraFlags: r.flags });
  assert.equal(report.score, 80);
  // Same surname counts as a match.
  assert.equal(R.interpret(TIPP, addr, answer([row({ mdeededOwner: 'SMITH JOHN A' })]), 'Mary Smith').matches, true);
});

test('company owner and a person listing: a note, not a warning (likely a manager)', () => {
  const addr = R.parseAddress('350 S Grant St, West Lafayette, IN 47906');
  const r = R.interpret(TIPP, addr, answer([row({})]), 'Jordan Example');
  assert.equal(r.matches, false);
  assert.equal(r.flags.length, 0);
  assert.match(r.note, /company owns this property/);
});

test('no lister name: no comparison, no flag', () => {
  const addr = R.parseAddress('350 S Grant St, West Lafayette, IN 47906');
  const r = R.interpret(TIPP, addr, answer([row({})]), '');
  assert.equal(r.matches, null);
  assert.equal(r.flags.length, 0);
});

test('address with no parcel, vacant land, confidential owner, service error', () => {
  const addr = R.parseAddress('99999 Nowhere Rd, Lafayette, IN 47905');
  const none = R.interpret(TIPP, addr, answer([]), 'X');
  assert.equal(none.status, 'not-found');
  assert.equal(none.flags.length, 0, 'complexes and new buildings are often filed elsewhere: no warning');
  const vacant = R.interpret(TIPP, addr, answer([row({ mpropertyclass: 'Vacant Residential Lot' })]), '');
  assert.equal(vacant.flags[0].id, 'vacant-land');
  assert.equal(vacant.flags[0].severity, 'low');
  const secret = R.interpret(TIPP, addr, answer([row({ mconfidential: 'Y' })]), 'Jordan Example');
  assert.equal(secret.status, 'redacted');
  assert.equal(secret.flags.length, 0);
  assert.equal(R.interpret(TIPP, addr, { error: { code: 500 } }, '').status, 'error');
  assert.equal(R.interpret(TIPP, addr, null, '').status, 'error');
});

test('prefers the parcel with the matching street direction', () => {
  const addr = R.parseAddress('440 S Grant St, West Lafayette, IN 47906');
  const r = R.interpret(TIPP, addr, answer([row({ Address: '440 N GRANT ST', mdeededOwner: 'NORTH OWNER LLC' }), row({ Address: '440 S GRANT ST', mdeededOwner: '10 OWNER LLC' })]), '');
  assert.equal(r.address, '440 S GRANT ST');
});

// Real cases from Tippecanoe County records (2026-11-16).
test('52 Flats: advertised address is county land, the building is found by name', () => {
  const addr = R.parseAddress('3004 Pemberly Dr, West Lafayette, IN 47906');
  const county = { Address: '3004 PEMBERLY DR', mdeededOwner: 'TIPPECANOE COUNTY BOARD OF COMMISSIONERS', mpropertyclass: 'Exempt, County' };
  const exact = answer([row(county)]);
  const alone = R.interpret(TIPP, addr, exact, '', { title: '52 Flats' });
  assert.equal(alone.flags.length, 0, 'public land is not a warning');
  const street = answer([
    row(county),
    row({ Address: '3001 PEMBERLY CT', mdeededOwner: 'TIPPECANOE COUNTY BOARD OF COMMISSIONERS', mpropertyclass: 'Exempt, County' }),
    row({ Address: '3073 PEMBERLY DR', mdeededOwner: '52 FLATS LLC', mpropertyclass: '40 or More Family Apartments' }),
  ]);
  const r = R.interpret(TIPP, addr, exact, '', { title: '52 Flats', streetResponse: street });
  assert.equal(r.status, 'found');
  assert.equal(r.matchedBy, 'name');
  assert.equal(r.owner, '52 FLATS LLC');
  assert.equal(r.address, '3073 PEMBERLY DR');
  assert.equal(r.flags.length, 0);
  const url = new URL(R.buildStreetQueryUrl(TIPP, addr));
  assert.equal(url.searchParams.get('where'), "(Address LIKE '% PEMBERLY %' OR Address LIKE '% PEMBERLY') AND LoczipCode = '47906'");
});

test('reads the parcel centre and the date the owner bought it', () => {
  const addr = R.parseAddress('2110 McCormick Rd, West Lafayette, IN 47906');
  const url = new URL(R.buildQueryUrl(TIPP, addr));
  assert.equal(url.searchParams.get('returnCentroid'), 'true');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('returnGeometry'), 'false');
  assert.ok(!/mail/i.test(url.searchParams.get('outFields')), 'still never asks for mailing addresses');
  const street = {
    features: [{ attributes: row({ Address: '2106 MCCORMICK RD', mdeededOwner: 'STATION 21 PARTNERS LLC', mpropertyclass: '40 or More Family Apartments', mtransferDate: 1691020920000 }), centroid: { x: -86.94282, y: 40.44712 } }],
  };
  const r = R.interpret(TIPP, addr, answer([]), '', { title: 'Station 21', streetResponse: street });
  assert.equal(r.lat, 40.44712);
  assert.equal(r.lon, -86.94282);
  assert.equal(r.ownerSince, '2023-08-03');
  assert.equal(r.flags.length, 0, 'a company bought it long ago: nothing to say');
});

test('a home sold in the last few months, posted by someone else: a note', () => {
  const addr = R.parseAddress('12 Elm St, Lafayette, IN 47904');
  const now = Date.UTC(2026, 10, 16);
  const sold = (daysAgo) => answer([row({ Address: '12 ELM ST', mdeededOwner: 'SMITH JOHN A', mpropertyclass: 'Res 1 family dwelling', mtransferDate: now - daysAgo * 86400000 })]);
  const recent = R.interpret(TIPP, addr, sold(30), 'Jordan Example', { now });
  assert.ok(recent.flags.some((f) => f.id === 'recent-sale' && f.severity === 'low'));
  assert.equal(R.interpret(TIPP, addr, sold(30), 'John Smith', { now }).flags.length, 0, 'the new owner posted it');
  assert.ok(!R.interpret(TIPP, addr, sold(400), 'Jordan Example', { now }).flags.some((f) => f.id === 'recent-sale'));
});

test('Cheswick Village: advertised number not on record, the building is found by name', () => {
  const addr = R.parseAddress('3422 Cheswick Ct, West Lafayette, IN 47906');
  const street = answer([row({ Address: '3400 CHESWICK CT', mdeededOwner: 'NEW CHESWICK VILLAGE LLC', mpropertyclass: '40 or More Family Apartments' })]);
  const r = R.interpret(TIPP, addr, answer([]), '', { title: 'Cheswick Village', streetResponse: street });
  assert.equal(r.owner, 'NEW CHESWICK VILLAGE LLC');
  assert.equal(r.matchedBy, 'name');
  // A name with only generic words matches nothing.
  const none = R.interpret(TIPP, addr, answer([]), '', { title: 'West Lafayette Apartments', streetResponse: street });
  assert.equal(none.status, 'not-found');
  assert.equal(R.buildingNameScore('52 FLATS LLC', '52 Main'), 0, 'a shared number alone is not a match');
  assert.ok(R.buildingNameScore('STATION 21 PARTNERS LLC', 'Station 21') > 0);
  assert.ok(R.buildingNameScore('UMH IN WOODS EDGE LLC', 'Woods Edge') > 0);
  assert.equal(R.buildingNameScore('SMITH JOHN', 'John Purdue Block'), 0, 'a person is never matched by name');
  assert.equal(R.buildingNameScore('JOHN SMITH LLC', 'John Purdue Block'), 0, 'every distinctive word must match');
});

test('The Pines, 1117 Anthrop Dr: not on record, nearby apartment buildings offered as leads', () => {
  const addr = R.parseAddress('1117 Anthrop Dr, West Lafayette, IN 47906');
  const street = answer([
    row({ Address: '1155 ANTHROP DR', mdeededOwner: 'ANTHROP APTS LLC', mpropertyclass: '40 or More Family Apartments' }),
    row({ Address: '1130 ANTHROP DR', mdeededOwner: 'SMITH DWAYNE A MONA RAE', mpropertyclass: 'Condominium Unit - Unplatted (0 to 9.99 Acres)' }),
    row({ Address: '1105 ANTHROP DR', mdeededOwner: 'ANTHROP POINTE INVESTORS LLC', mpropertyclass: '4 to 19 Family Apartments' }),
    row({ Address: '1193 ANTHROP DR', mdeededOwner: 'WEST LAFAYETTE CITY OF', mpropertyclass: 'Exempt, Municipality' }),
    row({ Address: '1160 ANTHROP DR', mdeededOwner: 'ANTHROP APARTMENTS 1 LLC ETAL', mpropertyclass: '4 to 19 Family Apartments' }),
  ]);
  const r = R.interpret(TIPP, addr, answer([]), '', { title: 'The Pines', streetResponse: street });
  assert.equal(r.status, 'not-found');
  assert.equal(r.flags.length, 0);
  assert.deepEqual(plain(r.nearby).map((n) => n.address), ['1105 ANTHROP DR', '1155 ANTHROP DR']);
  assert.ok(!plain(r.nearby).some((n) => /SMITH|CITY/.test(n.owner)), 'only company-owned apartment buildings');
});

test('flood zone and year built, from the county server', () => {
  const fu = new URL(R.buildFloodQueryUrl(TIPP, 40.4207, -86.8993));
  assert.equal(fu.origin, 'https://maps.tippecanoe.in.gov');
  assert.equal(fu.searchParams.get('geometry'), '-86.899300,40.420700');
  assert.equal(R.buildFloodQueryUrl(TIPP, NaN, 1), null);
  const fl = (rows) => R.interpretFlood(answer(rows));
  assert.equal(fl([]).level, 'minimal');
  assert.equal(fl([{ FLD_ZONE: 'X', ZONE_SUBTY: '0.2 PCT ANNUAL CHANCE FLOOD HAZARD', SFHA_TF: 'F' }]).level, 'moderate');
  const high = fl([{ FLD_ZONE: 'AE', ZONE_SUBTY: 'FLOODWAY', SFHA_TF: 'T' }]);
  assert.equal(high.level, 'high');
  assert.match(high.label, /AE, floodway/);
  assert.equal(R.interpretFlood({ error: { code: 400 } }), null);

  const pu = new URL(R.buildPermitsQueryUrl(TIPP, "325 BROWN ST'; DROP"));
  assert.match(pu.searchParams.get('where'), /^ADDRESS = '325 BROWN ST DROP' OR ADDRESS LIKE '325 BROWN ST DROP %'$/);
  assert.equal(R.buildPermitsQueryUrl(TIPP, 'BROWN ST'), null, 'needs a street number');
  const built = R.interpretPermits(answer([{ DATE: 1521417600000, DESCRIPTN: 'Multi-Family Residence - 114 units', UNITTYPE: 'mul', UNITCOUNT: '114', PERMITYEAR: 2018, BUILT_YEAR: 2019 }]));
  assert.equal(built.builtYear, 2019);
  assert.match(built.text, /^Built in 2019, 114 units/);
  assert.match(R.interpretPermits(answer([{ DESCRIPTN: 'New single family residence', UNITTYPE: 'sin', PERMITYEAR: 2026 }])).text, /may still be under construction/);
  assert.equal(R.interpretPermits(answer([{ DESCRIPTN: 'Deck', UNITTYPE: 'acc', PERMITYEAR: 2024 }])), null);
});

test('Alight, "2243 Sagamore Pky W": no parcel at that number, found under the site map pin', () => {
  const addr = R.parseAddress('2243 Sagamore Pky W, West Lafayette, IN 47906');
  assert.equal(addr.street, 'SAGAMORE', '"Pky" and a trailing direction are dropped');
  const pu = new URL(R.buildPointQueryUrl(TIPP, 40.46706, -86.94684));
  assert.equal(pu.searchParams.get('geometry'), '-86.946840,40.467060');
  assert.ok(!/mail/i.test(pu.searchParams.get('outFields')));
  assert.equal(R.buildPointQueryUrl(TIPP, NaN, 0), null);
  const point = answer([row({ Address: '2243 US HWY 52 W', mdeededOwner: 'SCION WL APARTMENTS LLC', mpropertyclass: '40 or More Family Apartments' })]);
  const r = R.interpret(TIPP, addr, answer([]), '', { title: 'Alight West Lafayette', streetResponse: answer([]), pointResponse: point });
  assert.equal(r.status, 'found');
  assert.equal(r.matchedBy, 'map');
  assert.equal(r.owner, 'SCION WL APARTMENTS LLC');
  assert.match(r.note, /map/);
  // A road or other public parcel under the pin is not the building.
  const road = answer([row({ Address: 'SAGAMORE PKWY', mdeededOwner: 'STATE OF INDIANA', mpropertyclass: 'Exempt, State' })]);
  assert.equal(R.interpret(TIPP, addr, answer([]), '', { pointResponse: road }).status, 'not-found');
  // A name match on the street still wins over the pin.
  const street = answer([row({ Address: '3400 CHESWICK CT', mdeededOwner: 'NEW CHESWICK VILLAGE LLC', mpropertyclass: '40 or More Family Apartments' })]);
  const c = R.interpret(TIPP, R.parseAddress('3422 Cheswick Ct, West Lafayette, IN 47906'), answer([]), '', { title: 'Cheswick Village', streetResponse: street, pointResponse: point });
  assert.equal(c.matchedBy, 'name');
});

test('a person-owned parcel under the map pin is shown, not held against the lister', () => {
  const addr = R.parseAddress('12 Elm St, Lafayette, IN 47904');
  const point = answer([row({ Address: '14 ELM ST', mdeededOwner: 'SMITH JOHN A', mpropertyclass: 'Res 1 family dwelling' })]);
  const r = R.interpret(TIPP, addr, answer([]), 'Oak Property Management', { pointResponse: point });
  assert.equal(r.matchedBy, 'map');
  assert.equal(r.flags.length, 0, 'the pin may be on the lot next door');
  assert.match(r.note, /neighbouring lot/);
});
