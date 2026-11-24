/*
 * BehindTheDoor — popup.
 *
 * Security notes:
 *  - Everything that comes from a web page is untrusted. It is only ever put
 *    on screen with textContent / createElement, never innerHTML, so a
 *    listing cannot inject markup or script into the extension.
 *  - The page is read only when the user opens the popup (activeTab), in
 *    Chrome's isolated world. The only network requests go to the county
 *    parcel service, for Tippecanoe County addresses.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STAR_PATH = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z';
  const READ_TIMEOUT_MS = 10000;
  const SITE_URLS = {
    zillow: 'https://www.zillow.com/homes/for_rent/',
    apartments: 'https://www.apartments.com/',
    craigslist: 'https://www.craigslist.org/',
    facebook: 'https://www.facebook.com/marketplace/category/propertyrentals',
  };

  // Text from the page, bounded and coerced to a string.
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500);

  function show(view) {
    const changed = $(view).hidden;
    for (const id of ['view-loading', 'view-empty', 'view-report']) $(id).hidden = id !== view;
    if (changed) window.scrollTo(0, 0);
  }

  // Each scan gets a number, so a slow records answer from an earlier scan
  // never lands on a newer report.
  let scanSeq = 0;

  function showEmpty(title, text) {
    $('empty-title').textContent = title;
    $('empty-text').textContent = text || '';
    $('empty-detail').textContent = '';
    show('view-empty');
  }

  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function whyNot(err) {
    const msg = String((err && err.message) || err || '');
    if (msg === 'timeout') return 'The page took too long to answer. Wait for it to finish loading, then press Scan again.';
    if (/cannot access (contents|a chrome)|cannot be scripted|extensions gallery|chrome:\/\/|missing host permission|must request permission/i.test(msg)) {
      return 'Chrome did not give BehindTheDoor access to this page. Reload the page (Cmd+R), then click the BehindTheDoor icon again. ' +
        'If it still fails, check chrome://extensions → BehindTheDoor → Details → Site access.';
    }
    if (/error page/i.test(msg)) return 'This tab is showing an error page. Reload it and try again.';
    return 'Something went wrong while reading the page. Reload it and press Scan again.';
  }

  // ---------- Reading the current tab ----------

  async function scanTab() {
    const seq = ++scanSeq;
    $('back').hidden = true;
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      tab = null;
    }
    if (!tab || tab.id == null) {
      showEmpty('No tab to check', 'Open a rental listing in this window, then click BehindTheDoor again.');
      return;
    }
    if (tab.url && !/^https?:\/\//i.test(tab.url)) {
      showEmpty('Open a rental listing', 'BehindTheDoor reads rental listings on websites. Pick a site below, or paste the listing text.');
      return;
    }

    show('view-loading');
    let listing;
    try {
      const results = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: btdExtractListing }),
        READ_TIMEOUT_MS
      );
      listing = results && results[0] && results[0].result;
    } catch (err) {
      showEmpty('Could not read this page', whyNot(err));
      // Chrome's own words, so a problem can be reported precisely.
      $('empty-detail').textContent = 'Details: ' + str(err && err.message ? err.message : err, 200);
      return;
    }
    if (!listing || typeof listing !== 'object') {
      showEmpty('Could not read this page', 'The page did not return anything. Reload it and press Scan again.');
      return;
    }
    if (!listing.isListing) {
      if (listing.isFeed) {
        showEmpty(
          'Open one post',
          'This page shows many people’s posts (a group, a page or your feed). Click the time under a post (like “2h”) to open that post on its own, then press Scan again.'
        );
      } else if (listing.looksLikeResults) {
        showEmpty('Open one listing', 'This looks like a page of search results. Open a single listing, then press Scan again.');
      } else {
        showEmpty(
          'No rental listing found',
          `Nothing on this ${str(listing.siteName, 60) || 'page'} looks like a rental listing. Open a listing, or paste its text below.`
        );
      }
      return;
    }
    if (seq !== scanSeq) return;
    glance = {};
    // The area's rents are a fixed table, so the comparison is ready at once
    // and the low-rent check can use it.
    const area = BTD_AREA.areaFor(listing.location);
    listing.rent = area ? BTD_AREA.compareRent(listing, area) : null;
    // How far the site's own map pin is from campus, so a description that
    // claims "2 blocks from campus" can be checked against it.
    const pinTrip = area && Number.isFinite(listing.lat) ? BTD_AREA.campusTrip(area, listing.lat, listing.lon) : null;
    listing.campusMiles = pinTrip ? pinTrip.miles : null;
    render(listing, BTD.analyze(listing), { kind: 'page' });
    showArea(listing, area);
    showSteps(listing, area, null);
    showPhotoSearch(listing);
    checkRecords(listing, seq, area);
  }

  // ---------- At a glance ----------
  // One line per answer, filled in as each becomes known. A line jumps to
  // the card that explains it.

  let glance = {};
  const GLANCE = [
    ['flags', 'Warning signs', 'warnings'],
    ['rent', 'Rent', 'area-card'],
    ['owner', 'Owner', 'records-card'],
    ['campus', 'To campus', 'area-card'],
    ['bus', 'Nearest bus', 'area-card'],
    ['flood', 'Flood map', 'area-card'],
  ];

  function setGlance(key, value, tone) {
    glance[key] = { value: str(value, 60), tone: tone || 'neutral' };
    renderGlance();
  }

  function renderGlance() {
    const ul = $('glance');
    ul.textContent = '';
    for (const [key, label, target] of GLANCE) {
      const g = glance[key];
      if (!g) continue;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'glance-row';
      btn.dataset.tone = g.tone;
      const l = document.createElement('span');
      l.className = 'glance-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'glance-value';
      v.textContent = g.value;
      btn.append(l, v);
      btn.addEventListener('click', () => {
        const el = $(target);
        if (el && !el.hidden) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    ul.hidden = !ul.children.length;
  }

  // A link that opens in a new tab, only when the user clicks it.
  function linkChip(label, url) {
    const a = document.createElement('a');
    a.className = 'link-chip';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    return a;
  }

  // "west lafayette" -> "West Lafayette"
  const titleCase = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());

  function cityOf(listing) {
    const place = str(listing.location, 200);
    const addr = BTD_RECORDS.parseAddress(place);
    if (addr && addr.city && addr.state) return { city: titleCase(addr.city), state: addr.state };
    const m = place.match(/(?:^|,)\s*([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/);
    return m ? { city: m[1].trim(), state: m[2] } : null;
  }

  // Places nearby, Street View, flood zone and police reports, as links.
  function exploreLinks(listing, at) {
    const place = str(listing.location, 200);
    if (!place) return [];
    const where = listing.hasStreetAddress === false && listing.streetHint ? `${str(listing.streetHint, 60)}, ${place}` : place;
    const near = (what) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${what} near ${where}`);
    const links = [
      ['Groceries', near('grocery store')],
      ['Bus stops', near('bus stop')],
      ['Laundromats', near('laundromat')],
      ['Pharmacies', near('pharmacy')],
    ];
    if (at && Number.isFinite(at.lat) && listing.hasStreetAddress !== false) {
      links.push(['Street View', `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${at.lat.toFixed(6)},${at.lon.toFixed(6)}`]);
    }
    if (listing.hasStreetAddress !== false) links.push(['Flood map (FEMA)', 'https://msc.fema.gov/portal/search?AddressQuery=' + encodeURIComponent(place)]);
    const c = cityOf(listing);
    if (c) links.push(['Police reports nearby', `https://spotcrime.com/${encodeURIComponent(c.state)}/${encodeURIComponent(c.city)}`]);
    return links;
  }

  function showExplore(listing, at) {
    const links = exploreLinks(listing, at);
    const box = $('explore-links');
    box.textContent = '';
    for (const [label, url] of links) box.appendChild(linkChip(label, url));
    $('explore-row').hidden = !links.length;
    if (links.length) $('area-card').hidden = false;
  }

  // ---------- Rent and location ----------

  const money = BTD_AREA.money;
  const RENT_SHORT = { 'far-below': ['Much lower than usual', 'warn'], below: ['A bit below usual', 'note'], typical: ['About normal', 'good'], above: ['Above usual', 'note'] };

  function showArea(listing, area) {
    const card = $('area-card');
    card.hidden = !area;
    $('rent-row').hidden = true;
    $('campus-row').hidden = true;
    for (const id of ['nearby-row', 'nearby-flood-label', 'nearby-flood', 'nearby-flood-note', 'records-built-label', 'records-built']) $(id).hidden = true;
    $('rent-ref').hidden = !area;
    showExplore(listing, listing);
    if (!area) return;

    const rent = listing.rent;
    $('rent-row').hidden = !rent;
    if (rent) {
      $('rent-verdict').textContent = rent.headline;
      $('rent-verdict').dataset.verdict = rent.verdict;
      $('rent-text').textContent = rent.text;
      setGlance('rent', RENT_SHORT[rent.verdict][0], RENT_SHORT[rent.verdict][1]);
    } else {
      setGlance('rent', listing.shortStay ? 'Nightly stay, not compared' : listing.priceText ? 'Not compared (bedrooms unknown)' : 'No price shown', 'neutral');
    }
    const ref = $('rent-ref');
    ref.textContent = '';
    const table = area.rents.map((r, b) => `${b === 0 ? 'studio' : b + ' bed'} ${money(r)}`).join(' · ');
    ref.append(document.createTextNode(`${area.rentsLabel}, ${area.name}: ${table}. `));
    const src = document.createElement('a');
    src.href = area.rentsUrl;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = 'Source';
    ref.appendChild(src);

    // Directions work from the address alone; the distance comes once the
    // county has placed the building.
    const place = str(listing.location, 200);
    const from = listing.hasStreetAddress === false && listing.streetHint ? `${str(listing.streetHint, 60)}, ${place}` : place;
    const url = BTD_AREA.directionsUrl(area, from);
    $('campus-row').hidden = !url;
    $('campus-link').href = url || '#';
    $('campus-link').textContent = `Bus directions to ${area.campus.short}`;
    $('campus-verdict').textContent = `Getting to ${area.campus.short}`;
    $('campus-text').textContent =
      listing.hasStreetAddress === false
        ? 'The listing gives no street address, so the distance cannot be measured yet. The directions start from the area it names.'
        : 'Measuring the distance from county records…';
    if (url) setGlance('campus', 'Measuring…', 'neutral');
  }

  function showCampusTrip(area, result, listing) {
    if (!area || $('campus-row').hidden) return;
    // The county's parcel first; else the map position the site publishes.
    const at = result && Number.isFinite(result.lat) ? result : listing && Number.isFinite(listing.lat) ? listing : null;
    const trip = at ? BTD_AREA.campusTrip(area, at.lat, at.lon) : null;
    // Without a street address the site's pin is only near the home.
    const approx = at === listing && listing.hasStreetAddress === false;
    if (trip) {
      $('campus-verdict').textContent = `${approx ? 'About ' : ''}${trip.miles.toFixed(1)} miles from ${area.campus.short}`;
      $('campus-text').textContent = approx ? `${trip.text} Measured from the site's approximate map pin, since the listing gives no street address.` : trip.text;
      const how = trip.miles * 1.3 <= 3 ? `${trip.walkMinutes} min walk` : `${trip.bikeMinutes} min by bike`;
      setGlance('campus', `${approx ? 'About ' : ''}${trip.miles.toFixed(1)} mi · ${how}`, 'neutral');
      if (!approx) showExplore(listing, at);
    } else {
      if (!/no street address/.test($('campus-text').textContent)) {
        $('campus-text').textContent = 'The county could not place this building, so open the directions to see the trip.';
      }
      setGlance('campus', 'See bus directions', 'neutral');
    }
  }

  // ---------- Before you pay or sign ----------

  function showSteps(listing, area, records) {
    $('steps-card').hidden = false;
    // A building with many units has an office worth finding on your own.
    const title = str(listing.title, 120);
    const office = $('office-link');
    const complex = listing.bedsMax || listing.priceHigh || (records && records.ownerIsCompany && records.matchedBy === 'name');
    office.hidden = !(title && complex && listing.source !== 'web');
    if (!office.hidden) {
      const city = (str(listing.location, 200).split(',').slice(-2).join(' ') || '').trim();
      office.href = 'https://www.google.com/search?q=' + encodeURIComponent(`${title} ${city}`.trim());
    }
    const help = $('help');
    const links = $('help-links');
    links.textContent = '';
    help.hidden = !(area && area.help && area.help.length);
    if (help.hidden) return;
    for (const h of area.help) {
      const a = document.createElement('a');
      a.className = 'btn';
      a.href = h.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = h.label;
      links.appendChild(a);
    }
  }

  // ---------- Public property records ----------

  function setRecords(status, note) {
    $('records-status').textContent = status;
    $('records-note').textContent = note || '';
  }

  async function fetchJson(url) {
    const res = await withTimeout(
      fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }),
      READ_TIMEOUT_MS
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function checkRecords(listing, seq, area) {
    const result = await lookUpRecords(listing, seq);
    if (seq !== scanSeq) return;
    showCampusTrip(area, result, listing);
    showReviews(listing, result);
    if (result) showSteps(listing, area, result);
    if (!area) return;

    // Where the building is: the county's parcel, else the site's own pin.
    const fromCounty = result && Number.isFinite(result.lat);
    const at = fromCounty ? result : Number.isFinite(listing.lat) ? listing : null;
    if (!at) return;
    const approx = !fromCounty && listing.hasStreetAddress === false;
    showNearby(at, approx);
    // The flood map and the building permit come from the same county
    // server, in parallel. A pin that is only near the home says nothing
    // about its flood zone, so that is skipped.
    const source = BTD_RECORDS.SOURCES.find((s) => s.id === 'tippecanoe-in');
    await Promise.all([approx ? null : showFlood(source, at, seq), fromCounty && result.status === 'found' ? showBuilt(source, result.address, seq) : null]);
  }

  // ---------- Around the building ----------

  function showNearby(at, approx) {
    const bus = BTD_AREA.nearestStop(at.lat, at.lon);
    const shop = BTD_AREA.nearestGrocery(at.lat, at.lon);
    if (!bus && !shop) return;
    $('nearby-row').hidden = false;
    $('nearby-bus').textContent = bus ? bus.text : 'No CityBus stop within 5 miles.';
    $('nearby-grocery').textContent = shop ? shop.text : 'None within 15 miles.';
    const about = approx ? 'About: measured from the site’s approximate map pin. ' : '';
    $('nearby-ref').textContent = `${about}Straight-line distances. Bus: ${bus ? bus.source : 'CityBus'}. Stores: ${shop ? shop.source : 'OpenStreetMap'}.`;
    if (bus) setGlance('bus', `${bus.miles < 0.1 ? 'Under 0.1' : bus.miles.toFixed(1)} mi · route${bus.routes.length === 1 ? '' : 's'} ${bus.routes.slice(0, 4).join(', ')}`, 'neutral');
  }

  async function showFlood(source, at, seq) {
    const url = BTD_RECORDS.buildFloodQueryUrl(source, at.lat, at.lon);
    if (!url) return;
    const show = (text, note) => {
      $('nearby-flood-label').hidden = false;
      $('nearby-flood').hidden = false;
      $('nearby-flood').textContent = text;
      $('nearby-flood-note').textContent = note || '';
      $('nearby-flood-note').hidden = !note;
    };
    show('Checking FEMA’s flood map…');
    let flood = null;
    try {
      flood = BTD_RECORDS.interpretFlood(await fetchJson(url));
    } catch (e) {
      flood = null;
    }
    if (seq !== scanSeq) return;
    if (!flood) {
      show('Could not check the flood map.');
      return;
    }
    show(flood.label, flood.level === 'minimal' ? '' : flood.text);
    const tone = { high: 'warn', moderate: 'note', minimal: 'good' }[flood.level];
    setGlance('flood', { high: 'High-risk flood zone', moderate: 'Moderate flood risk', minimal: 'Not in a mapped flood area' }[flood.level], tone);
  }

  async function showBuilt(source, parcelAddress, seq) {
    const url = BTD_RECORDS.buildPermitsQueryUrl(source, parcelAddress);
    if (!url) return;
    let built = null;
    try {
      built = BTD_RECORDS.interpretPermits(await fetchJson(url));
    } catch (e) {
      built = null;
    }
    if (seq !== scanSeq || !built) return;
    $('records-built-label').hidden = false;
    $('records-built').hidden = false;
    $('records-built').textContent = built.text;
  }

  // What other renters say about the building, and the owning company's
  // record, as searches the user opens.
  function showReviews(listing, result) {
    const box = $('reviews-links');
    box.textContent = '';
    const title = str(listing.title, 100);
    const c = cityOf(listing);
    const where = c ? `${c.city} ${c.state}` : '';
    const company = result && result.status === 'found' && result.ownerIsCompany && !/^exempt/i.test(result.propertyClass);
    const complex = listing.bedsMax || listing.priceHigh || listing.source === 'web' || (company && result.matchedBy === 'name');
    const links = [];
    if (title && complex) {
      links.push([`Reviews of ${title.length > 30 ? title.slice(0, 29) + '…' : title}`, 'https://www.google.com/search?q=' + encodeURIComponent(`"${title}" ${where} reviews`)]);
    }
    if (company) {
      const owner = String(result.owner).split(';')[0].trim();
      links.push(['Owner on the BBB', 'https://www.bbb.org/search?find_text=' + encodeURIComponent(owner) + (where ? '&find_loc=' + encodeURIComponent(c.city + ', ' + c.state) : '')]);
      links.push(['Owner reviews', 'https://www.google.com/search?q=' + encodeURIComponent(`"${owner}" reviews`)]);
    }
    for (const [label, url] of links) box.appendChild(linkChip(label, url));
    box.hidden = !links.length;
  }

  function monthYear(iso) {
    const d = new Date(String(iso) + 'T12:00:00Z');
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // Shows the owner card and returns the county's answer, or null.
  async function lookUpRecords(listing, seq) {
    const R = BTD_RECORDS;
    const card = $('records-card');
    const link = $('records-link');
    card.hidden = false;
    $('records-facts').hidden = true;
    link.hidden = true;

    const addr = R.parseAddress(listing.location);
    // A town outside the county ("Bloomington, IN 47407"): asking for the
    // street would not help, the lookup does not cover it.
    if (!addr && /,\s*[A-Z]{2}\b/.test(str(listing.location, 200)) && !BTD_AREA.areaFor(listing.location)) {
      setRecords(
        'Owner lookup covers Tippecanoe County, IN for now.',
        'To see who owns a home elsewhere, get the street address from the lister and search it on that county’s assessor or GIS website.'
      );
      setGlance('owner', 'Not checked outside Tippecanoe County', 'neutral');
      return;
    }
    if (!addr && listing.shortStay) {
      const site = str(listing.siteName, 40) || 'The site';
      setRecords(
        `${site} shows the exact address only after you book.`,
        `Book and pay only inside ${site}. A host who asks you to pay by email, text, a payment app or another website is running a scam.`
      );
      setGlance('owner', 'Address shown after booking', 'neutral');
      return;
    }
    if (!addr) {
      const hint = str(listing.streetHint, 60);
      setRecords(
        'The listing does not give a street address.',
        `Ask the lister for the full address${hint ? ' (the listing mentions ' + hint + ')' : ''}. Then open the listing again and this card will show who owns the home.`
      );
      setGlance('owner', 'Ask for the street address', 'note');
      return;
    }
    const source = R.sourceFor(addr);
    if (!source) {
      setRecords(
        'Owner lookup covers Tippecanoe County, IN for now.',
        'To see who owns this address, search it on the county assessor’s or GIS website.'
      );
      setGlance('owner', 'Not checked outside Tippecanoe County', 'neutral');
      return;
    }
    link.href = source.viewerUrl;
    link.hidden = false;
    setRecords(`Checking ${source.name} records…`);
    setGlance('owner', 'Checking county records…', 'neutral');

    const title = str(listing.title, 200);
    let result;
    try {
      const url = R.buildQueryUrl(source, addr);
      if (!url) throw new Error('no query');
      const data = await fetchJson(url);
      if (seq !== scanSeq) return;
      result = R.interpret(source, addr, data, listing.listerName, { title });
      // The advertised address is missing or public land: complexes are often
      // filed under another number on the same street, or under another
      // street altogether. Both follow-up questions go out at once: the
      // parcels on the street (to match the building's name) and the parcel
      // under the site's map pin.
      if (result.status === 'not-found' || /^exempt/i.test(result.propertyClass)) {
        const quiet = (url) => (url ? fetchJson(url).catch(() => null) : Promise.resolve(null));
        const [streetData, pointData] = await Promise.all([
          quiet(title ? R.buildStreetQueryUrl(source, addr) : null),
          quiet(listing.hasStreetAddress !== false ? R.buildPointQueryUrl(source, listing.lat, listing.lon) : null),
        ]);
        if (seq !== scanSeq) return;
        if (streetData || pointData) {
          result = R.interpret(source, addr, data, listing.listerName, { title, streetResponse: streetData, pointResponse: pointData });
        }
      }
    } catch (err) {
      if (seq !== scanSeq) return;
      setRecords('Could not reach county records.', 'Check your internet connection, or look the address up yourself on the county map.');
      setGlance('owner', 'Could not check', 'neutral');
      return;
    }

    if (result.status === 'found' || result.status === 'redacted') {
      $('records-facts').hidden = false;
      $('records-owner').textContent = result.status === 'redacted' ? 'Confidential' : result.owner;
      $('records-parcel').textContent = result.address || '—';
      $('records-class').textContent = result.propertyClass || 'Unknown';
      $('records-lister').textContent = listing.listerName ? str(listing.listerName, 80) : 'Not named on the listing';
      const since = result.ownerSince ? monthYear(result.ownerSince) : '';
      $('records-since').textContent = since;
      $('records-since').hidden = !since;
      $('records-since-label').hidden = !since;
    }
    const notes = [];
    if (result.status === 'found') {
      if (result.matches === true) notes.push('The name on the listing matches the owner on record.');
      if (result.note) notes.push(result.note);
      if (result.matches == null && !/^exempt/i.test(result.propertyClass)) {
        notes.push('Make sure whoever you deal with is the owner or works for them.');
      }
      const status = result.matchedBy === 'name' ? `Building found in ${source.name} records.` : result.matchedBy === 'map' ? `Parcel at the site's map pin, ${source.name} records.` : `Found in ${source.name} records.`;
      setRecords(status, notes.join(' '));
      const short = (o) => (o.length > 28 ? o.slice(0, 27) + '…' : o);
      if (result.flags.some((f) => f.id === 'owner-mismatch')) setGlance('owner', 'Lister is not the owner', 'warn');
      else if (result.matches === true) setGlance('owner', 'Matches the lister', 'good');
      else if (/^exempt/i.test(result.propertyClass)) setGlance('owner', 'Public land at this number', 'neutral');
      else if (result.ownerIsCompany) setGlance('owner', short(result.owner), result.matchedBy === 'name' ? 'good' : 'neutral');
      else setGlance('owner', 'A person owns it', 'neutral');
    } else if (result.status === 'not-found') {
      const near = Array.isArray(result.nearby) ? result.nearby : [];
      const lead = near.length
        ? ` Apartment buildings on record nearby on this street: ${near.map((n) => `${n.address} (${n.owner}, ${n.propertyClass})`).join('; ')}. One of them may be this building; click it on the county map to be sure.`
        : '';
      setRecords('This address is not in county parcel records.', result.note + lead);
      setGlance('owner', 'Not on county record', 'neutral');
    } else if (result.status === 'redacted') {
      setRecords('Found, but the owner’s name is confidential.', result.note);
      setGlance('owner', 'Name kept private', 'neutral');
    } else {
      setRecords('Could not read county records.', result.note);
      setGlance('owner', 'Could not check', 'neutral');
    }

    if (result.flags.length) {
      listing.extraFlags = result.flags;
      render(listing, BTD.analyze(listing), { kind: 'page' });
    }
    return result;
  }

  // ---------- Reverse photo search (only when the user asks) ----------

  let photoUrl = '';
  function showPhotoSearch(listing) {
    photoUrl = /^https:\/\//i.test(listing.photoUrl || '') ? String(listing.photoUrl).slice(0, 2000) : '';
    $('photos-card').hidden = !photoUrl;
  }

  // ---------- Report ----------

  function star(fraction) {
    const wrap = document.createElement('span');
    wrap.className = 'star';
    const make = () => {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', STAR_PATH);
      svg.appendChild(path);
      return svg;
    };
    wrap.appendChild(make());
    if (fraction > 0) {
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = Math.round(fraction * 100) + '%';
      fill.appendChild(make());
      wrap.appendChild(fill);
    }
    return wrap;
  }

  function chip(text, missing) {
    const li = document.createElement('li');
    li.className = missing ? 'chip missing' : 'chip';
    li.textContent = text;
    return li;
  }

  function flagCard(flag) {
    const sev = ['high', 'medium', 'low'].includes(flag.severity) ? flag.severity : 'low';
    const card = document.createElement('div');
    card.className = 'flag ' + sev;

    const heading = document.createElement('div');
    heading.className = 'flag-heading';
    const symbol = document.createElement('span');
    symbol.className = 'symbol';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = sev === 'low' ? 'i' : '!';
    const title = document.createElement('strong');
    title.textContent = flag.title;
    const badge = document.createElement('span');
    badge.className = 'sev';
    badge.textContent = { high: 'Red flag', medium: 'Check this', low: 'Note' }[sev];
    heading.append(symbol, title, badge);

    const advice = document.createElement('p');
    advice.textContent = flag.advice;
    card.append(heading, advice);

    const ev = flag.evidence;
    if (ev && ev.match) {
      const quote = document.createElement('p');
      quote.className = 'evidence';
      const mark = document.createElement('mark');
      mark.textContent = str(ev.match, 300);
      quote.append(document.createTextNode(str(ev.before, 300)), mark, document.createTextNode(str(ev.after, 300)));
      card.appendChild(quote);
    }
    return card;
  }

  function render(listing, report, opts) {
    const kind = opts.kind; // 'page' | 'paste' | 'demo'
    $('demo-banner').hidden = kind !== 'demo';

    const site = kind === 'paste' ? 'Pasted text' : str(listing.siteName, 60);
    const title = str(listing.title, 200);
    const place = str(listing.location, 200);
    $('listing-eyebrow').textContent = site ? `${site} listing` : 'Listing';
    $('listing-title').textContent = title || place || (kind === 'paste' ? 'Text you pasted' : 'Untitled listing');
    $('listing-sub').textContent = title && place ? place : '';

    const meta = $('listing-meta');
    meta.textContent = '';
    if (listing.priceText) {
      const strong = document.createElement('strong');
      strong.textContent = str(listing.priceText, 60);
      meta.appendChild(strong);
    }
    if (listing.listedText) meta.append(document.createTextNode((listing.priceText ? ' · ' : '') + str(listing.listedText, 120)));

    // Facts first; only what is missing is called out.
    const details = $('listing-details');
    details.textContent = '';
    if (kind !== 'paste') {
      const beds = Number.isFinite(listing.beds) ? listing.beds : null;
      const most = Number.isFinite(listing.bedsMax) && listing.bedsMax > beds ? listing.bedsMax : null;
      const bedName = (n) => (n === 0 ? 'Studio' : `${n} bed${n === 1 ? '' : 's'}`);
      if (listing.isRoom) details.append(chip(beds ? `Room in a ${beds}-bed home` : 'Room in a shared home'));
      else if (beds != null && most != null) details.append(chip(`${beds === 0 ? 'Studio' : beds} – ${most} bed${most === 1 ? '' : 's'}`));
      else if (beds != null) details.append(chip(bedName(beds)));
      if (listing.priceHigh) details.append(chip('Price depends on the unit'));
      if (listing.perPerson) details.append(chip('Priced per person'));
      if (listing.shortStay) details.append(chip('Short stay, priced per night'));
      if (!listing.priceText) details.append(chip('No price shown', true));
      if (!place) details.append(chip('No address shown', true));
      else if (kind === 'page' && listing.hasStreetAddress === false) details.append(chip('Area only, no street address', true));
      if (!listing.description) details.append(chip('No description', true));
    }

    // A map of the place, opened only if the user clicks.
    const maps = $('maps-link');
    const where = listing.hasStreetAddress === false && listing.streetHint ? `${str(listing.streetHint, 60)}, ${place}` : place;
    maps.hidden = kind !== 'page' || !where;
    if (!maps.hidden) maps.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(where);

    $('result-card').dataset.level = report.level.key;
    const stars = $('stars');
    stars.textContent = '';
    for (let i = 0; i < 5; i++) stars.appendChild(star(Math.max(0, Math.min(1, report.stars - i))));
    stars.setAttribute('aria-label', `${report.stars} out of 5 stars`);
    $('stars-value').textContent = Number.isInteger(report.stars) ? String(report.stars) : report.stars.toFixed(1);
    $('level-pill').textContent = report.level.label;
    $('summary').textContent = report.summary;

    const notes = [];
    if (kind === 'page' && listing.scope === 'page' && listing.source !== 'facebook') {
      notes.push('No seller description was found, so the visible page text was scanned. A warning may come from another part of the page.');
    }
    if (kind === 'page' && !listing.priceText) notes.push('No price was found, so the rent was not checked.');
    $('limited-notice').textContent = notes.join(' ');
    $('limited-notice').hidden = notes.length === 0;

    const flags = $('flags');
    flags.textContent = '';
    $('flags-heading').textContent = report.flags.length ? `Things to check (${report.flags.length})` : 'Things to check';
    if (!report.flags.length) {
      const none = document.createElement('div');
      none.className = 'no-flags';
      none.textContent = 'Nothing in the listing text looks like a scam.';
      flags.appendChild(none);
    } else {
      for (const f of report.flags) flags.appendChild(flagCard(f));
    }
    const n = report.flags.length;
    const serious = report.flags.filter((f) => f.severity === 'high').length;
    setGlance('flags', n ? `${n} to look at${serious ? `, ${serious} serious` : ''}` : 'None found', serious ? 'bad' : n ? 'warn' : 'good');

    // Every check, passed or not, so the rating says what it rests on.
    const checks = Array.isArray(report.checks) ? report.checks : [];
    const list = $('checked-list');
    list.textContent = '';
    for (const c of checks) {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : 'found';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = c.ok ? '✓' : '!';
      li.append(mark, document.createTextNode(c.label));
      list.appendChild(li);
    }
    const foundCount = checks.filter((c) => !c.ok).length;
    $('checked').hidden = !checks.length;
    $('checked-summary').textContent = `What the scam check looked for: ${checks.length} things${foundCount ? `, ${foundCount} found` : ', none found'}`;

    $('back').hidden = kind === 'page';
    if (kind !== 'page') {
      $('records-card').hidden = true;
      $('photos-card').hidden = true;
      $('area-card').hidden = true;
      $('steps-card').hidden = true;
    }
    show('view-report');
  }

  // ---------- Wiring ----------

  function init() {
    try {
      $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {
      $('version').textContent = '';
    }

    $('rescan').addEventListener('click', scanTab);
    $('photo-search').addEventListener('click', () => {
      if (photoUrl) chrome.tabs.create({ url: 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(photoUrl) });
    });
    $('back').addEventListener('click', () => show('view-empty'));

    $('show-demo').addEventListener('click', () => {
      const demo = Object.assign({ siteName: 'Demo' }, BTD.DEMO_LISTING);
      glance = {};
      render(demo, BTD.analyze(demo), { kind: 'demo' });
    });

    const paste = $('paste-text');
    const scanPaste = $('scan-paste');
    paste.addEventListener('input', () => {
      scanPaste.disabled = paste.value.trim().length < 20;
    });
    scanPaste.addEventListener('click', () => {
      const text = paste.value.trim().slice(0, 20000);
      if (text.length < 20) return;
      const listing = { source: 'paste', title: '', description: text, fullText: text, scope: 'description' };
      glance = {};
      render(listing, BTD.analyze(listing), { kind: 'paste' });
    });

    for (const btn of document.querySelectorAll('[data-site]')) {
      btn.addEventListener('click', () => {
        const url = SITE_URLS[btn.dataset.site];
        if (url) chrome.tabs.create({ url });
      });
    }

    scanTab();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
