/*
 * BehindTheDoor — public property records.
 *
 * Looks up who the county says owns the listed address, and compares that
 * with the name of whoever posted the listing.
 *
 * Pure functions (no DOM, no chrome.*, no network): the popup does the fetch,
 * so this file can be tested on its own.
 *
 * What is sent: only the street address from the listing, reduced to
 * letters, digits and spaces. What is read back: the deeded owner's name,
 * the property class and the parcel address. Owners' mailing addresses are
 * never requested.
 *
 * Exposes: BTD_RECORDS.{ sourceFor, parseAddress, buildQueryUrl, buildStreetQueryUrl, interpret, SOURCES }
 */
(function (root) {
  'use strict';

  // One entry per county whose parcel records are public and queryable.
  // To add a county, add an entry with the same shape.
  const SOURCES = [
    {
      id: 'tippecanoe-in',
      name: 'Tippecanoe County, IN',
      queryUrl: 'https://maps.tippecanoe.in.gov/server/rest/services/Parcels_FeatureService/FeatureServer/0/query',
      viewerUrl: 'https://maps.tippecanoe.in.gov/portal/apps/webappviewer/index.html?id=ba9f61d3932d4bbbbd32188060fd4172',
      state: 'IN',
      cities: ['lafayette', 'west lafayette', 'battle ground', 'dayton', 'clarks hill', 'romney', 'stockwell', 'buck creek', 'westpoint', 'west point', 'shadeland', 'otterbein', 'americus', 'montmorency'],
      zips: ['47901', '47902', '47903', '47904', '47905', '47906', '47907', '47909', '47920', '47924', '47930', '47941', '47981', '47983', '47992'],
      fields: { address: 'Address', city: 'Loccity', zip: 'LoczipCode', owner: 'mdeededOwner', propertyClass: 'mpropertyclass', confidential: 'mconfidential', transferDate: 'mtransferDate' },
      // FEMA flood map (DFIRM) and new-building permits since 2016, on the
      // same county server.
      floodUrl: 'https://maps.tippecanoe.in.gov/server/rest/services/FIRM/MapServer/0/query',
      permitsUrl: 'https://maps.tippecanoe.in.gov/server/rest/services/RecentBuildingPermits/MapServer/2/query',
    },
  ];

  // ---------- Flood zone ----------

  // The FEMA flood zone at a point (the parcel's centre).
  function buildFloodQueryUrl(source, lat, lon) {
    if (!source || !source.floodUrl || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const params = new URLSearchParams({
      geometry: `${lon.toFixed(6)},${lat.toFixed(6)}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
      returnGeometry: 'false',
      f: 'json',
    });
    return source.floodUrl + '?' + params.toString();
  }

  /**
   * { level: 'high' | 'moderate' | 'minimal', zone, label, text } or null
   * when the service did not answer.
   */
  function interpretFlood(response) {
    if (!response || typeof response !== 'object' || response.error || !Array.isArray(response.features)) return null;
    const zones = response.features.map((x) => (x && x.attributes) || {});
    const high = zones.find((a) => String(a.SFHA_TF).toUpperCase() === 'T' || /^(A|V)/i.test(String(a.FLD_ZONE || '')));
    if (high) {
      const zone = String(high.FLD_ZONE || 'A');
      const floodway = /floodway/i.test(String(high.ZONE_SUBTY || ''));
      return {
        level: 'high',
        zone,
        label: `In a FEMA high-risk flood zone (${zone}${floodway ? ', floodway' : ''})`,
        text: 'FEMA maps this spot as having a 1% or greater chance of flooding each year. Ask whether the building or its parking has flooded, and get renter’s insurance that covers flood damage to your things.',
      };
    }
    const moderate = zones.find((a) => /0\.2 ?PCT|500/i.test(String(a.ZONE_SUBTY || '')));
    if (moderate) {
      return {
        level: 'moderate',
        zone: String(moderate.FLD_ZONE || 'X'),
        label: 'Moderate flood risk (0.2% a year)',
        text: 'FEMA maps this spot in the 0.2%-a-year (500-year) flood area. Flooding is unlikely, but ask about the parking lot and basement units.',
      };
    }
    return {
      level: 'minimal',
      zone: zones.length ? String(zones[0].FLD_ZONE || 'X') : '',
      label: 'Outside FEMA’s mapped flood areas',
      text: 'FEMA’s flood map does not show a flood hazard here.',
    };
  }

  // ---------- When it was built ----------

  // New-building permits for the parcel's own address (as the county files it).
  function buildPermitsQueryUrl(source, parcelAddress) {
    const a = safe(parcelAddress);
    if (!source || !source.permitsUrl || !/^\d+ [A-Z0-9]/.test(a)) return null;
    const params = new URLSearchParams({
      where: `ADDRESS = '${a}' OR ADDRESS LIKE '${a} %'`,
      outFields: 'DATE,DESCRIPTN,UNITTYPE,UNITCOUNT,PERMITYEAR,BUILT_YEAR',
      orderByFields: 'DATE DESC',
      returnGeometry: 'false',
      resultRecordCount: '10',
      f: 'json',
    });
    return source.permitsUrl + '?' + params.toString();
  }

  /**
   * { builtYear, permitYear, units, description, text } for the newest
   * new-building permit, or null.
   */
  function interpretPermits(response) {
    if (!response || typeof response !== 'object' || !Array.isArray(response.features)) return null;
    const rows = response.features.map((x) => (x && x.attributes) || {});
    const NEW = /\b(new|multi-?family|apartment|apt|complex|residence|townhome|duplex|units?)\b/i;
    const row = rows.find((r) => /^(mul|sin|dup|two|tow)/i.test(String(r.UNITTYPE || '')) || NEW.test(String(r.DESCRIPTN || '')));
    if (!row) return null;
    const builtYear = Number(row.BUILT_YEAR) || null;
    const permitYear = Number(row.PERMITYEAR) || null;
    const units = Number(row.UNITCOUNT) || null;
    const what = String(row.DESCRIPTN || '').trim().slice(0, 80);
    const text = builtYear
      ? `Built in ${builtYear}${units && units > 1 ? `, ${units} units` : ''} (county building permit, ${permitYear || 'year unknown'}).`
      : `Building permit issued in ${permitYear || 'recent years'}${what ? ': ' + what.toLowerCase() : ''}. It may still be under construction.`;
    return { builtYear, permitYear, units, description: what, text };
  }

  // What is read back for each parcel. The parcel's centre point comes back
  // in latitude/longitude (for the distance to campus); its outline does not.
  function queryParams(source, where, count) {
    const f = source.fields;
    return new URLSearchParams({
      where,
      outFields: [f.address, f.city, f.zip, f.owner, f.propertyClass, f.confidential, f.transferDate].filter(Boolean).join(','),
      returnGeometry: 'false',
      returnCentroid: 'true',
      outSR: '4326',
      resultRecordCount: String(count),
      f: 'json',
    });
  }

  const DIRECTIONS = { N: 'N', S: 'S', E: 'E', W: 'W', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };
  const SUFFIXES = new Set(['ST', 'STREET', 'AVE', 'AVENUE', 'AV', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE', 'CT', 'COURT', 'BLVD', 'BOULEVARD', 'PL', 'PLACE', 'WAY', 'CIR', 'CIRCLE', 'TER', 'TERRACE', 'PKWY', 'PKY', 'PKWAY', 'PY', 'PARKWAY', 'HWY', 'HIGHWAY', 'TRL', 'TRAIL', 'PIKE', 'RUN', 'XING', 'CROSSING', 'SQ', 'SQUARE']);
  const UNIT = /(?:\b(?:apt|apartment|unit|suite|ste)\b\.?|#)\s*[a-z0-9-]+/gi;

  // Only letters, digits and single spaces survive: nothing from a listing
  // can reach the query as SQL or URL syntax.
  const safe = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  /**
   * "440 S. Grant St., Apt 3, West Lafayette, IN 47906" ->
   * { number: '440', direction: 'S', street: 'GRANT', city: 'west lafayette', zip: '47906', state: 'IN' }
   */
  function parseAddress(text) {
    const raw = String(text || '').replace(UNIT, ' ').slice(0, 200);
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const m = parts[0].match(/^\s*(\d{1,6})[a-z]?\s+(.+)$/i);
    if (!m) return null;
    const all = safe(m[2]).split(' ').filter(Boolean);
    let words = all.slice();
    let direction = '';
    // "2110 McCormick Road West Lafayette": no comma before the city. Cut
    // after the street type and keep the rest as the city.
    let cityFromStreet = '';
    const cutAt = words.findIndex((w, i) => i > 0 && SUFFIXES.has(w) && i < words.length - 1);
    if (cutAt !== -1 && words.slice(cutAt + 1).some((w) => !SUFFIXES.has(w) && !DIRECTIONS[w])) {
      cityFromStreet = words.slice(cutAt + 1).join(' ').toLowerCase();
      words = words.slice(0, cutAt + 1);
    }
    if (words.length > 2 && DIRECTIONS[words[0]]) direction = DIRECTIONS[words.shift()];
    // "SAGAMORE PKY W", "SAGAMORE W PKWY": drop street types and a trailing
    // direction in any order, since the county writes them both ways.
    while (words.length > 1 && (SUFFIXES.has(words[words.length - 1]) || DIRECTIONS[words[words.length - 1]])) words.pop();
    // "123 West St": the street is called West, not a direction.
    if (words.length === 1 && SUFFIXES.has(words[0]) && all.length === 2) {
      direction = '';
      words = [all[0]];
    }
    const street = words.join(' ');
    if (!street) return null;

    const rest = parts.slice(1).join(' ');
    const zipM = rest.match(/\b(\d{5})(?:-\d{4})?\b/);
    const stateM = rest.match(/\b([A-Z]{2})\b(?=\s*\d{5}|\s*$)/);
    const city = (cityFromStreet || parts[1] || '').replace(/\b[A-Z]{2}\b\s*\d{5}.*$/, '').replace(/\d{5}.*$/, '').trim().toLowerCase();
    return {
      number: m[1],
      direction,
      street,
      city: city.replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(),
      zip: zipM ? zipM[1] : '',
      state: stateM ? stateM[1] : '',
    };
  }

  function sourceFor(addr) {
    if (!addr) return null;
    return (
      SOURCES.find(
        (s) => (addr.zip && s.zips.includes(addr.zip)) || (!addr.zip && addr.city && s.cities.includes(addr.city) && (!addr.state || addr.state === s.state))
      ) || null
    );
  }

  function buildQueryUrl(source, addr) {
    const f = source.fields;
    // Matches "440 S GRANT ST" and "440 GRANT ST", but "2ND" never matches "22ND".
    const number = safe(addr.number).replace(/ /g, '');
    const street = safe(addr.street);
    if (!number || !street) return null;
    let where = `(${f.address} LIKE '${number} ${street}%' OR ${f.address} LIKE '${number} % ${street}%')`;
    if (addr.zip) where += ` AND ${f.zip} = '${safe(addr.zip)}'`;
    else if (addr.city) where += ` AND ${f.city} LIKE '${safe(addr.city)}%'`;
    return source.queryUrl + '?' + queryParams(source, where, 25).toString();
  }

  // The parcel at a point: the map pin a listing site publishes.
  function buildPointQueryUrl(source, lat, lon) {
    if (!source || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const params = queryParams(source, '1=1', 5);
    params.set('geometry', `${lon.toFixed(6)},${lat.toFixed(6)}`);
    params.set('geometryType', 'esriGeometryPoint');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
    return source.queryUrl + '?' + params.toString();
  }

  // Every parcel on the listed street. Used when the advertised address is
  // not a parcel of its own: apartment complexes often advertise an address
  // that the county files as a road or common area, or not at all.
  function buildStreetQueryUrl(source, addr) {
    const f = source.fields;
    const street = safe(addr.street);
    if (!street) return null;
    let where = `(${f.address} LIKE '% ${street} %' OR ${f.address} LIKE '% ${street}')`;
    if (addr.zip) where += ` AND ${f.zip} = '${safe(addr.zip)}'`;
    else if (addr.city) where += ` AND ${f.city} LIKE '${safe(addr.city)}%'`;
    return source.queryUrl + '?' + queryParams(source, where, 200).toString();
  }

  // ---------- Comparing names ----------

  const COMPANY = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|lp|llp|ltd|trust|trustees?|properties|property|holdings|partners|partnership|group|management|mgmt|realty|investments?|rentals?|apartments?|homes|housing|association|assn|bank|church|university|univ|foundation|county|city|state|board|authority|estate|ventures|capital|development|enterprises?)\b/i;
  const NOISE = new Set(['AND', 'THE', 'OF', 'A', 'AN', 'ET', 'AL', 'ETAL', 'ETUX', 'JR', 'SR', 'II', 'III', 'IV', 'MR', 'MRS', 'MS', 'DR', 'LLC', 'INC', 'TRUST', 'TRUSTEE', 'TRUSTEES', 'REVOCABLE', 'LIVING', 'FAMILY', 'H', 'W', 'JT', 'TEN', 'JTWROS', 'LIFE', 'ESTATE']);
  const tokens = (name) => safe(name).split(' ').filter((t) => t.length >= 2 && !NOISE.has(t));

  // Words too common in building names to identify one ("Village" is kept:
  // with the street already fixed it is distinctive enough).
  const GENERIC = new Set(['APARTMENTS', 'APARTMENT', 'APTS', 'APT', 'HOMES', 'HOME', 'HOUSE', 'HOUSING', 'RENTAL', 'RENTALS', 'LIVING', 'LAFAYETTE', 'WEST', 'EAST', 'NORTH', 'SOUTH', 'PURDUE', 'CAMPUS', 'AT', 'ON', 'IN', 'NEW', 'PROPERTIES', 'PROPERTY', 'MANAGEMENT', 'GROUP', 'PARTNERS', 'HOLDINGS', 'INVESTMENTS', 'COMMUNITY', 'RESIDENCES', 'UNIT', 'BEDROOM', 'BED', 'BATH', 'FOR', 'RENT', 'ROOM', 'STUDIO', 'CO', 'LP']);
  // How many distinctive words a building's name shares with its owner's name.
  function buildingNameScore(owner, title) {
    const own = new Set(safe(owner).split(' ').filter((t) => !NOISE.has(t) && !GENERIC.has(t)));
    const words = [...new Set(safe(title).split(' ').filter((t) => t.length >= 2 && !NOISE.has(t) && !GENERIC.has(t)))];
    const shared = words.filter((t) => own.has(t));
    // Every distinctive word of the name must be in the owner's name ("John
    // Purdue Block" never matches "SMITH JOHN"), the owner must be a company,
    // and a number alone ("52") is not enough.
    if (!words.length || shared.length < words.length || !COMPANY.test(owner)) return 0;
    return shared.some((t) => /[A-Z]{4,}/.test(t)) ? shared.length : 0;
  }

  function namesMatch(owner, lister) {
    const a = new Set(tokens(owner));
    const b = tokens(lister);
    // A shared surname or company word of 3+ letters counts as a match.
    return b.some((t) => t.length >= 3 && a.has(t));
  }

  // ---------- Reading the answer ----------

  const PUBLIC_OWNER = /^exempt/i;

  /**
   * Returns { status, source, owner, ownerIsCompany, propertyClass, address,
   *           matchedBy, matches, flags[], note }
   * status: 'found' | 'not-found' | 'redacted' | 'error'
   * matchedBy: 'address' (the listed address is the parcel) or 'name' (the
   *            parcel on the same street whose owner matches the listing's name)
   * opts: { title, streetResponse } -- streetResponse is the answer to
   *       buildStreetQueryUrl, asked for when the address alone was not enough.
   */
  function interpret(source, addr, response, listerName, opts) {
    opts = opts || {};
    const listed = [addr.number, addr.direction, addr.street].filter(Boolean).join(' ');
    const out = { status: 'error', source: source.name, viewerUrl: source.viewerUrl, owner: '', ownerIsCompany: false, propertyClass: '', address: '', matchedBy: '', matches: null, flags: [], note: '' };
    if (!response || typeof response !== 'object' || response.error || !Array.isArray(response.features)) {
      out.note = 'The county records service did not answer.';
      return out;
    }
    const f = source.fields;
    // Each row is the parcel's fields plus its centre point, when given.
    const rowsOf = (r) =>
      r && Array.isArray(r.features)
        ? r.features
            .map((x) => {
              const a = Object.assign({}, (x && x.attributes) || {});
              const c = x && x.centroid;
              if (c && Number.isFinite(c.x) && Number.isFinite(c.y) && Math.abs(c.y) <= 90 && Math.abs(c.x) <= 180) {
                a.__lat = c.y;
                a.__lon = c.x;
              }
              return a;
            })
            .filter((a) => a[f.address])
        : [];
    const rows = rowsOf(response);
    // Prefer the parcel whose direction matches ("440 S GRANT" over "440 N GRANT").
    rows.sort((x, y) => (safe(y[f.address]).startsWith(listed) ? 1 : 0) - (safe(x[f.address]).startsWith(listed) ? 1 : 0));

    let group = rows.length ? rows.filter((a) => a[f.address] === rows[0][f.address]) : [];
    out.matchedBy = group.length ? 'address' : '';

    // The listed address is missing or is a public parcel: look for the
    // building on the same street whose owner carries the listing's name.
    const needsBuilding = !group.length || PUBLIC_OWNER.test(String(group[0][f.propertyClass] || ''));
    if (needsBuilding && opts.title) {
      let best = null;
      let bestScore = 0;
      for (const a of rowsOf(opts.streetResponse)) {
        if (PUBLIC_OWNER.test(String(a[f.propertyClass] || ''))) continue;
        const score = buildingNameScore(a[f.owner], opts.title);
        if (score > bestScore) {
          best = a;
          bestScore = score;
        }
      }
      if (best) {
        group = rowsOf(opts.streetResponse).filter((a) => a[f.address] === best[f.address]);
        out.matchedBy = 'name';
      }
    }
    // Still nothing: the parcel under the map pin the listing site publishes
    // (Alight at "2243 Sagamore Pky W" is filed as 2243 US HWY 52 W). A road
    // or other public parcel there says nothing about the building.
    if (out.matchedBy !== 'name' && (!group.length || PUBLIC_OWNER.test(String(group[0][f.propertyClass] || '')))) {
      const at = rowsOf(opts.pointResponse).filter((a) => !PUBLIC_OWNER.test(String(a[f.propertyClass] || '')) && String(a[f.owner] || '').trim());
      if (at.length) {
        group = at.filter((a) => a[f.address] === at[0][f.address]);
        out.matchedBy = 'map';
      }
    }

    if (!group.length) {
      out.status = 'not-found';
      out.note = 'Large and new buildings are often filed under a different address, so this alone is not a warning. Open the county map and click the building to see its owner.';
      // Company-owned apartment buildings on the same street, nearest number
      // first: one of them may be this building. Shown as a lead, never as a
      // match.
      const num = parseInt(addr.number, 10);
      const seen = new Set();
      out.nearby = rowsOf(opts.streetResponse)
        .filter((a) => /apartment/i.test(String(a[f.propertyClass] || '')) && COMPANY.test(String(a[f.owner] || '')) && /^\d/.test(String(a[f.address])))
        .map((a) => ({ address: String(a[f.address]), owner: String(a[f.owner]).trim(), propertyClass: String(a[f.propertyClass]), gap: Math.abs(parseInt(a[f.address], 10) - num) }))
        .filter((a) => Number.isFinite(a.gap) && a.gap <= 300 && !seen.has(a.address) && seen.add(a.address))
        .sort((a, b) => a.gap - b.gap)
        .slice(0, 2)
        .map(({ address, owner, propertyClass }) => ({ address, owner, propertyClass }));
      return out;
    }

    const best = group[0];
    const owners = [...new Set(group.map((a) => String(a[f.owner] || '').trim()).filter(Boolean))];
    out.address = String(best[f.address] || '');
    out.propertyClass = String(best[f.propertyClass] || '');
    const located = group.find((a) => Number.isFinite(a.__lat));
    if (located) {
      out.lat = located.__lat;
      out.lon = located.__lon;
    }
    // The date the current owner's deed was recorded (milliseconds).
    const sold = f.transferDate ? Number(best[f.transferDate]) : NaN;
    if (Number.isFinite(sold) && sold > 0) out.ownerSince = new Date(sold).toISOString().slice(0, 10);
    if (String(best[f.confidential] || '').toUpperCase() === 'Y' || !owners.length) {
      out.status = 'redacted';
      out.note = 'The owner name for this parcel is kept confidential in public records.';
      return out;
    }

    out.status = 'found';
    out.owner = owners.length > 3 ? owners.slice(0, 3).join('; ') + ` (+${owners.length - 3} more)` : owners.join('; ');
    out.ownerIsCompany = owners.some((o) => COMPANY.test(o));

    const cls = out.propertyClass.toLowerCase();
    const notes = [];
    if (out.matchedBy === 'name') {
      notes.push(`The county files this building under ${out.address}, not the advertised number. The owner's name matches the listing.`);
    } else if (out.matchedBy === 'map') {
      notes.push(`The county has no parcel at the advertised number. This is the parcel at the spot the listing site marks on its map, filed as ${out.address}. Check on the county map that it is the building.`);
    } else if (PUBLIC_OWNER.test(cls)) {
      notes.push('Records show a public owner at this address. For apartment complexes this is often a road or common-area parcel next to the buildings. Use the county map to find the building itself.');
    }
    if (/vacant/.test(cls)) {
      out.flags.push({
        id: 'vacant-land',
        severity: 'low',
        title: 'Records still show vacant land here',
        advice: 'Normal for a building finished in the last year or so. For an older home it means the home may not exist: visit before you pay.',
        evidence: { before: '', match: out.propertyClass, after: '' },
      });
    }

    if (listerName && !PUBLIC_OWNER.test(cls)) {
      out.matches = owners.some((o) => namesMatch(o, listerName));
      // A parcel found only under the map pin may be the house next door:
      // its owner is shown, but not held against the lister.
      if (!out.matches && !out.ownerIsCompany && out.matchedBy === 'map') {
        notes.push('The owner of the parcel at the map pin is a person, not the lister. The pin may sit on a neighbouring lot, so ask the lister for the exact address before drawing conclusions.');
      } else if (!out.matches && !out.ownerIsCompany) {
        out.flags.push({
          id: 'owner-mismatch',
          severity: 'medium',
          title: 'Lister is not the owner on record',
          advice: 'A person owns this home, and someone else posted it. That can be a family member or a manager, but scammers also re-post homes they do not own. Ask how they are connected to the owner.',
          evidence: { before: 'Listed by ', match: String(listerName).slice(0, 80), after: ` · owner on record: ${out.owner.slice(0, 120)}` },
        });
      } else if (!out.matches) {
        notes.push('A company owns this property; the lister may manage it for them. To be sure, contact the company yourself rather than through the lister.');
      }
    }

    // A home that changed hands in the last few months, posted by someone who
    // is not the new owner: scammers re-post photos of homes that just sold.
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const days = Number.isFinite(sold) && sold > 0 ? (now - sold) / 86400000 : Infinity;
    if (out.matchedBy === 'address' && !out.ownerIsCompany && days >= 0 && days <= 120 && out.matches !== true && !PUBLIC_OWNER.test(cls)) {
      out.flags.push({
        id: 'recent-sale',
        severity: 'low',
        title: 'This home changed owners recently',
        advice: 'Homes that just sold are often re-posted by scammers using the sale photos. Ask the lister how they are connected to the new owner, and see the inside before paying.',
        evidence: { before: 'Owner on record since ', match: out.ownerSince, after: '' },
      });
    }
    out.note = notes.join(' ');
    return out;
  }

  root.BTD_RECORDS = { SOURCES, parseAddress, sourceFor, buildQueryUrl, buildStreetQueryUrl, interpret, namesMatch, buildingNameScore, buildPointQueryUrl, buildFloodQueryUrl, interpretFlood, buildPermitsQueryUrl, interpretPermits };
})(typeof globalThis !== 'undefined' ? globalThis : this);
