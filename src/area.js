/*
 * BehindTheDoor — the area around a listing.
 *
 * Compares the rent with HUD's Fair Market Rents for the area, and measures
 * how far the building is from campus. Everything here is a fixed table or
 * arithmetic: no network, no DOM, so it can be tested on its own.
 *
 * Exposes: BTD_AREA.{ AREAS, areaFor, rentFor, compareRent, distanceMiles, campusTrip, directionsUrl }
 */
(function (root) {
  'use strict';

  const AREAS = [
    {
      id: 'lafayette-in',
      name: 'Lafayette–West Lafayette',
      // HUD FY2026 Fair Market Rents, Lafayette-West Lafayette, IN HUD Metro
      // FMR Area (Benton and Tippecanoe counties), checked 2026-11-16.
      // Index = bedrooms (0 = studio). Rent plus basic utilities, at about
      // the 40th percentile of what recent movers pay.
      rents: [894, 1032, 1242, 1489, 1992],
      rentsLabel: 'HUD 2026 fair market rent',
      rentsUrl:
        'https://www.huduser.gov/portal/datasets/fmr/fmrs/FY2026_code/2026summary.odn?cbsasub=METRO29200M29140&selection_type=hmfa&year=2026',
      state: 'IN',
      zips: ['47901', '47902', '47903', '47904', '47905', '47906', '47907', '47909', '47920', '47924', '47930', '47941', '47981', '47983', '47992'],
      cities: ['west lafayette', 'lafayette', 'battle ground', 'dayton', 'clarks hill', 'romney', 'stockwell', 'buck creek', 'west point', 'westpoint', 'shadeland', 'otterbein', 'americus'],
      campus: {
        name: 'Purdue Memorial Union',
        short: 'Purdue',
        query: 'Purdue Memorial Union, West Lafayette, IN',
        lat: 40.42466,
        lon: -86.91106,
      },
      help: [
        { label: 'Purdue renting guide', url: 'https://www.purdue.edu/odos/sls/information/guide.php' },
        { label: 'Purdue Student Legal Services', url: 'https://www.purdue.edu/odos/sls/access/index.php' },
        { label: 'Purdue Off-Campus Housing', url: 'https://www.purdue.edu/odos/offcampus/' },
      ],
    },
  ];

  // The area a listing's location text is in, or null.
  function areaFor(location) {
    const text = String(location || '').slice(0, 300);
    const zip = (text.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1];
    for (const a of AREAS) {
      if (zip) {
        if (a.zips.includes(zip)) return a;
        continue;
      }
      const lower = text.toLowerCase();
      const hasState = new RegExp(`\\b(${a.state}|indiana)\\b`, 'i').test(text);
      if (hasState && a.cities.some((c) => new RegExp(`\\b${c}\\b`).test(lower))) return a;
    }
    return null;
  }

  // HUD's rent for a home with this many bedrooms. Above four, HUD adds 15%
  // of the four-bedroom rent per extra bedroom.
  function rentFor(area, beds) {
    if (!area || !Number.isFinite(beds) || beds < 0) return null;
    const b = Math.floor(beds);
    if (b <= 4) return area.rents[b];
    return Math.round(area.rents[4] * (1 + 0.15 * (b - 4)));
  }

  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const bedWord = (b) => (b === 0 ? 'studio' : `${b}-bed`);

  /**
   * How the listing's rent compares with the area's.
   * Returns null when it cannot be compared fairly (no monthly price, or no
   * bedroom count for a whole home), else
   * { ratio, verdict, headline, text, reference }
   * verdict: 'far-below' | 'below' | 'typical' | 'above'
   */
  function compareRent(listing, area) {
    if (!area || !listing) return null;
    const paid = Number(listing.priceAmount);
    const period = String(listing.pricePeriod || '');
    // Rent paid weekly or every two weeks, as a monthly amount.
    const perMonth = { '': 1, month: 1, week: 52 / 12, '2 weeks': 26 / 12 }[period];
    if (!(paid > 0) || !perMonth) return null;
    const amount = paid * perMonth;
    if (listing.priceCurrency && listing.priceCurrency !== 'USD' && listing.priceCurrency !== '$') return null;
    let beds = Number.isFinite(listing.beds) ? listing.beds : null;
    // A building priced per bed, with a range of plans: the lowest price is
    // a bed in the largest unit (Alight: $499 is a bed in a 4-bedroom, not a
    // studio), so it is compared with a share of the largest unit.
    if (listing.perPerson && !listing.isRoom && listing.priceHigh && Number.isFinite(listing.bedsMax) && listing.bedsMax > (beds || 0)) {
      beds = listing.bedsMax;
    }

    let reference;
    let what;
    if (listing.perPerson && !listing.isRoom && beds != null && beds <= 1) {
      // A studio or 1-bed "per person" is one person's whole unit.
      reference = rentFor(area, beds);
      what = `a ${bedWord(beds)} home`;
    } else if (listing.isRoom || listing.perPerson) {
      // One person's share of a home of that size; a room alone in a home of
      // unknown size is compared with a share of a 3-bed.
      const home = beds && beds > 0 ? beds : 3;
      reference = rentFor(area, home) / home;
      what = `one person's share of a ${bedWord(home)} home (${money(rentFor(area, home))} ÷ ${home})`;
    } else {
      if (beds == null) return null;
      reference = rentFor(area, beds);
      what = `a ${bedWord(beds)} home`;
    }
    const ratio = amount / reference;
    const from = listing.priceHigh ? 'starts at' : 'is';
    const per = listing.isRoom ? ' for the room' : listing.perPerson ? ' per person' : '';
    const verdict = ratio < 0.5 ? 'far-below' : ratio < 0.8 ? 'below' : ratio <= 1.3 ? 'typical' : 'above';
    const headline = {
      'far-below': 'Much lower than usual for this area',
      below: 'A bit below the usual rent here',
      typical: 'About normal for this area',
      above: 'Above the usual rent here',
    }[verdict];
    const why = {
      'far-below': 'Very low rent is the most common bait in rental scams. See the place in person before you pay anything.',
      below: 'Could be a good deal, an older unit, or utilities not included. Ask what the rent covers.',
      typical: '',
      above: listing.isRoom
        ? 'Common for a furnished room, a private bathroom, or rent that includes utilities. Ask what the rent covers.'
        : 'Common for new student buildings, furnished units, or rent that includes utilities. Ask what the rent covers.',
    }[verdict];
    const paidAs = perMonth === 1 ? `${money(amount)} a month${per}` : `${money(paid)} ${period === 'week' ? 'a week' : 'every 2 weeks'}${per} (about ${money(amount)} a month)`;
    const text =
      `Rent ${from} ${paidAs}. ${area.rentsLabel} for ${what} in ${area.name} is about ${money(reference)}.` +
      (why ? ' ' + why : '');
    return { ratio: Math.round(ratio * 100) / 100, verdict, headline, text, reference: Math.round(reference) };
  }

  // Straight-line distance in miles.
  function distanceMiles(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
  }

  // "1.9 miles from Purdue Memorial Union in a straight line: about 40
  // minutes on foot or 12 by bike, more by road."
  function campusTrip(area, lat, lon) {
    if (!area || !area.campus) return null;
    const miles = distanceMiles(lat, lon, area.campus.lat, area.campus.lon);
    if (miles == null || miles > 60) return null;
    const round5 = (m) => Math.max(5, Math.round(m / 5) * 5);
    // Roads are longer than a straight line: about 1.3 times in town.
    const road = miles * 1.3;
    const walk = round5((road / 3) * 60);
    const bike = round5((road / 10) * 60);
    const shown = miles.toFixed(1);
    let text = `${shown} miles from ${area.campus.name} in a straight line.`;
    if (road <= 3) text += ` By road, roughly ${walk} minutes on foot or ${bike} by bike.`;
    else if (road <= 8) text += ` By road, roughly ${bike} minutes by bike; too far to walk every day, so check the bus.`;
    else text += ' Most people drive or take the bus from here.';
    return { miles: Math.round(miles * 10) / 10, walkMinutes: walk, bikeMinutes: bike, text };
  }

  // Google Maps directions from the listing to campus, by bus. Opened only
  // when the user clicks.
  function directionsUrl(area, from) {
    if (!area || !area.campus || !from) return '';
    const p = new URLSearchParams({ api: '1', origin: String(from).slice(0, 200), destination: area.campus.query, travelmode: 'transit' });
    return 'https://www.google.com/maps/dir/?' + p.toString();
  }

  // The closest of a list of [name, lat, lon, ...] places, by a straight line.
  // Under a thousand places, so a plain scan is fast enough (well under 1 ms).
  function nearest(list, lat, lon) {
    if (!Array.isArray(list) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    let best = null;
    let bestMiles = Infinity;
    for (const p of list) {
      const m = distanceMiles(lat, lon, p[1], p[2]);
      if (m != null && m < bestMiles) {
        bestMiles = m;
        best = p;
      }
    }
    return best ? { place: best, miles: bestMiles } : null;
  }

  const milesText = (m) => (m < 0.05 ? 'under 0.1 mi' : m.toFixed(1) + ' mi');
  const walkText = (miles) => {
    const min = Math.max(1, Math.round(((miles * 1.3) / 3) * 60));
    return min <= 40 ? `about ${min} min walk` : `${(miles * 1.3).toFixed(1)} miles by road`;
  };

  // "Physics Building, 0.2 mi (about 5 min walk). Routes 22, 42 · about 230
  // buses each weekday."
  function nearestStop(lat, lon, places) {
    const data = places || root.BTD_PLACES;
    const n = data && nearest(data.transit.stops, lat, lon);
    if (!n || n.miles > 5) return null;
    const [name, , , routes, trips] = n.place;
    const list = String(routes).split(' ').filter(Boolean);
    return {
      name,
      miles: Math.round(n.miles * 100) / 100,
      routes: list,
      weekdayBuses: trips,
      text:
        `${name}, ${milesText(n.miles)} (${walkText(n.miles)}). ` +
        `${list.length === 1 ? 'Route' : 'Routes'} ${list.join(', ')}` +
        (trips ? ` · about ${trips} buses stop there each weekday.` : '.'),
      source: data.transit.source,
    };
  }

  function nearestGrocery(lat, lon, places) {
    const data = places || root.BTD_PLACES;
    const n = data && nearest(data.groceries.places, lat, lon);
    if (!n || n.miles > 15) return null;
    return {
      name: n.place[0],
      miles: Math.round(n.miles * 10) / 10,
      text: `${n.place[0]}, ${milesText(n.miles)} (${walkText(n.miles)}).`,
      source: data.groceries.source,
    };
  }

  root.BTD_AREA = { AREAS, areaFor, rentFor, compareRent, distanceMiles, campusTrip, directionsUrl, nearestStop, nearestGrocery, money };
})(typeof globalThis !== 'undefined' ? globalThis : this);
