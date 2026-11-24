// Offline tests for src/analyzer.js. Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the analyzer the way the popup does: as a plain script.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'analyzer.js'), 'utf8'), ctx);
const { analyze, DEMO_LISTING } = ctx.BTD;
const NOW = new Date('2026-11-16T12:00:00Z');
const ids = (r) => Array.from(r.flags, (f) => f.id).sort();

test('journal scenario 1: Facebook listing, extreme low price, new account', () => {
  const r = analyze(
    {
      source: 'facebook',
      priceText: '$500 / month',
      priceAmount: 500,
      pricePeriod: 'month',
      beds: 2,
      sellerJoinedYear: 2026,
      fullText: '2 Beds 1 Bath Apartment\n$500 / Month\nAll utilities included. Message me for details.',
    },
    NOW
  );
  assert.deepEqual(ids(r), ['low-price', 'new-account']);
  assert.ok(r.stars < 5);
});

test('journal scenario 2: Craigslist, no tours, Zelle fee, owner abroad', () => {
  const r = analyze(
    {
      source: 'craigslist',
      fullText:
        'Charming 2BR near campus. I am currently out of the country on a mission trip so no in-person showings. ' +
        'Send the $50 application fee through Zelle and I will mail you the keys.',
    },
    NOW
  );
  for (const id of ['landlord-away', 'viewing-restrictions', 'p2p-payment', 'upfront-fee', 'keys-by-mail']) {
    assert.ok(ids(r).includes(id), `missing ${id}: got ${ids(r)}`);
  }
  assert.equal(r.level.key, 'high');
  assert.equal(r.stars, 0);
});

test('journal scenario 3: legitimate listing raises nothing', () => {
  const r = analyze(
    {
      source: 'apartments',
      priceText: '$1,150 / month',
      priceAmount: 1150,
      pricePeriod: 'month',
      beds: 2,
      fullText:
        'Two bedroom apartment, 12 month lease. Schedule a tour with our leasing office Monday to Friday. ' +
        'Contact leasing@granitestudentliving.com or call the office.',
    },
    NOW
  );
  assert.equal(r.flags.length, 0);
  assert.equal(r.stars, 5);
  assert.equal(r.level.key, 'good');
});

test('webmail address is flagged, a property company domain is not', () => {
  assert.ok(ids(analyze({ fullText: 'Email example.landlord.test@gmail.com for the address' }, NOW)).includes('off-platform-contact'));
  assert.ok(!ids(analyze({ fullText: 'Email office@sunsetapartments.com for a tour' }, NOW)).includes('off-platform-contact'));
});

test('low-price floor scales with bedrooms and ignores weekly or non-dollar prices', () => {
  const low = (o) => ids(analyze(Object.assign({ fullText: 'nice place', priceText: '$' + o.priceAmount }, o), NOW)).includes('low-price');
  assert.equal(low({ priceAmount: 350, beds: 1 }), true);
  assert.equal(low({ priceAmount: 450, beds: 1 }), false);
  assert.equal(low({ priceAmount: 550, beds: 2 }), true);
  assert.equal(low({ priceAmount: 750, beds: 3 }), true);
  assert.equal(low({ priceAmount: 300, beds: 1, pricePeriod: 'week' }), false);
  assert.equal(ids(analyze({ fullText: 'x', priceText: '₹300', priceAmount: 300 }, NOW)).includes('low-price'), false);
});

test('demo listing still produces a high-concern report', () => {
  const r = analyze(DEMO_LISTING, NOW);
  assert.equal(r.level.key, 'high');
});

test('missing or junk input does not throw', () => {
  assert.doesNotThrow(() => analyze(undefined, NOW));
  assert.doesNotThrow(() => analyze({ fullText: null, priceAmount: 'abc' }, NOW));
});

test('long hostile text is scanned quickly (no catastrophic regex)', () => {
  const junk = 'a'.repeat(19000) + '@' + 'b.'.repeat(400);
  const t0 = Date.now();
  analyze({ fullText: junk }, NOW);
  assert.ok(Date.now() - t0 < 500, 'took ' + (Date.now() - t0) + 'ms');
});

test('a room is priced as a room, not as the whole home', () => {
  const base = { fullText: 'Private room for rent in a quiet home', priceText: '$500 / month', priceAmount: 500, pricePeriod: 'month', beds: 3 };
  assert.ok(analyze(base).flags.some((f) => f.id === 'low-price'), 'a whole 3-bed home at $500 is low');
  assert.ok(!analyze(Object.assign({ isRoom: true }, base)).flags.some((f) => f.id === 'low-price'));
});

test('newer scam scripts are caught', () => {
  const ids = (text) => [...analyze({ fullText: text }).flags.map((f) => f.id)];
  assert.ok(ids('Pay the deposit through Airbnb, they will hold the payment until you move in.').includes('fake-platform-payment'));
  assert.ok(ids('Your money is protected by Zillow rental protection program.').includes('fake-platform-payment'));
  assert.ok(ids('Once you send the deposit I will text you the lockbox code.').includes('code-after-payment'));
  assert.ok(ids('I will send you the door code after payment is received.').includes('code-after-payment'));
  assert.ok(ids('Please fill the application here https://forms.gle/abc123').includes('form-application'));
  assert.ok(!ids('Please fill the application here https://forms.gle/abc123').includes('external-link'), 'one warning, not two');
  assert.ok(ids('Sign the lease first, before you see the house.').includes('pay-before-viewing'));
  assert.ok(ids('Rent can be paid by money order.').includes('p2p-payment'));
});

test('common honest wording is not flagged', () => {
  const ids = (text) => [...analyze({ fullText: text }).flags.map((f) => f.id)];
  assert.equal(ids('Zero application fee. Fully furnished, utilities included.').join(), '');
  assert.equal(ids('No application fee! Apply at https://renter.turbotenant.com/apply/123').join(), '');
  assert.equal(ids('Self-guided tours available: book online and get a lockbox code for your tour time.').join(), '');
  assert.equal(ids('Pets: No. Application fee of $45 per person waived this month.').filter((x) => x !== 'upfront-fee').join(), '');
});

test('every check is reported, passed or not', () => {
  const clean = analyze({ fullText: 'Nice 2 bed near campus', priceAmount: 1200, priceText: '$1,200' });
  assert.ok(clean.checks.length >= 7);
  assert.ok(clean.checks.every((c) => c.ok));
  const bad = analyze({ fullText: 'Wire the deposit today, I am out of the country.' });
  assert.ok(bad.checks.some((c) => !c.ok && /hard to get back/.test(c.label)));
  assert.ok(bad.checks.some((c) => !c.ok && /tour/.test(c.label)));
  assert.ok(!bad.checks.some((c) => /Seller account/.test(c.label)), 'only shown when the site gives the account age');
});

test('details that do not agree: map vs claimed location, home type, for-sale wording', () => {
  const ad = {
    title: '3br - Downtown Living on Main Street - Apartment B',
    description: '3-bed, 2-bath single-family home just 2 blocks from Mackey Arena. Don\'t miss the opportunity to make this your dream home.',
  };
  ad.fullText = ad.title + '\n' + ad.description;
  const far = [...analyze(Object.assign({ campusMiles: 2.4 }, ad)).flags.map((f) => f.id)];
  assert.ok(far.includes('location-mismatch'));
  assert.ok(far.includes('type-mismatch'));
  assert.ok(far.includes('sale-listing-copy'));
  // Really near campus: the claim is fine.
  assert.ok(![...analyze(Object.assign({ campusMiles: 0.4 }, ad)).flags.map((f) => f.id)].includes('location-mismatch'));
  // No map pin: nothing to compare.
  assert.ok(![...analyze(ad).flags.map((f) => f.id)].includes('location-mismatch'));
  // Honest wording passes.
  const ok = { title: '2 bed apartment near campus', description: 'Second-floor apartment, 5 minute walk to campus, laundry in building.' };
  ok.fullText = ok.title + '\n' + ok.description;
  assert.equal([...analyze(Object.assign({ campusMiles: 0.5 }, ok)).flags].length, 0);
});

test('review fixes: honest shuttle wording, checklist only claims what it checked, landlord sites keep fee rules', () => {
  const shuttle = { title: 'Apartments with shuttle', description: 'Free shuttle with stops on campus every 15 minutes.' };
  shuttle.fullText = shuttle.title + '\n' + shuttle.description;
  assert.equal([...analyze(Object.assign({ campusMiles: 3 }, shuttle)).flags].length, 0);
  const noPin = analyze({ fullText: 'Nice place' });
  assert.ok(!noPin.checks.some((c) => /Map pin/.test(c.label)), 'no map pin, no map claim');
  assert.ok(analyze({ fullText: 'Nice place', campusMiles: 1 }).checks.some((c) => /Map pin matches/.test(c.label)));
  const site = { source: 'web', scope: 'page', fullText: 'Pay the $75 application fee at https://bit.ly/abc' };
  const ids = [...analyze(site).flags.map((f) => f.id)];
  assert.ok(ids.includes('upfront-fee') && ids.includes('external-link'), 'a landlord site is the lister speaking');
  const portal = { source: 'apartments', scope: 'page', fullText: 'Application Fee $50' };
  assert.equal([...analyze(portal).flags].length, 0, 'a listing site fee table is not the lister');
});
