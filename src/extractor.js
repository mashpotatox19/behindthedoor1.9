/*
 * BehindTheDoor — rental listing reader.
 *
 * btdExtractListing() is injected into the active tab with
 * chrome.scripting.executeScript({ func }), so it MUST be self-contained:
 * no references to anything outside its own body.
 *
 * It runs in the extension's isolated world, only after the user clicks the
 * toolbar button (activeTab). It reads the page and returns plain data; it
 * never sends anything anywhere.
 *
 * How a listing is read, most reliable source first:
 *   1. a reader for the site (Facebook Marketplace, Craigslist),
 *   2. the schema.org data (JSON-LD) most rental sites publish for search
 *      engines (Zillow, Apartments.com, Rent.com, Realtor.com, ...),
 *   3. Open Graph tags,
 *   4. the visible text of the page's main region.
 */
async function btdExtractListing() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Reading an element's visible text makes the browser lay the page out
  // and walk the whole element, so each element is read once. The cache is
  // cleared after "See more" is clicked, since the text changes then.
  let textCache = new Map();
  const textOf = (el) => {
    if (!el) return '';
    let t = textCache.get(el);
    if (t === undefined) {
      t = el.innerText || '';
      textCache.set(el, t);
    }
    return t;
  };
  const toNumber = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object') return toNumber(v.value != null ? v.value : v.minValue);
    const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // ---------- Which site is this? ----------
  const SITES = [
    ['facebook.com', 'facebook', 'Facebook Marketplace'],
    ['craigslist.org', 'craigslist', 'Craigslist'],
    ['zillow.com', 'zillow', 'Zillow'],
    ['trulia.com', 'trulia', 'Trulia'],
    ['hotpads.com', 'hotpads', 'HotPads'],
    ['apartments.com', 'apartments', 'Apartments.com'],
    ['realtor.com', 'realtor', 'Realtor.com'],
    ['redfin.com', 'redfin', 'Redfin'],
    ['rent.com', 'rent', 'Rent.com'],
    ['apartmentguide.com', 'apartmentguide', 'Apartment Guide'],
    ['zumper.com', 'zumper', 'Zumper'],
    ['padmapper.com', 'padmapper', 'PadMapper'],
    ['apartmentlist.com', 'apartmentlist', 'Apartment List'],
    ['apartmentfinder.com', 'apartmentfinder', 'ApartmentFinder'],
    ['forrent.com', 'forrent', 'ForRent'],
    ['rentals.com', 'rentals', 'Rentals.com'],
    ['homes.com', 'homes', 'Homes.com'],
    ['rentcafe.com', 'rentcafe', 'RentCafe'],
    ['furnishedfinder.com', 'furnishedfinder', 'Furnished Finder'],
    ['spareroom.com', 'spareroom', 'SpareRoom'],
    ['roomster.com', 'roomster', 'Roomster'],
    ['roomies.com', 'roomies', 'Roomies'],
    ['sublet.com', 'sublet', 'Sublet.com'],
    ['nextdoor.com', 'nextdoor', 'Nextdoor'],
    ['offcampushousing.purdue.edu', 'purdue', 'Purdue Off-Campus Housing'],
    ['airbnb.com', 'airbnb', 'Airbnb'],
    ['vrbo.com', 'vrbo', 'Vrbo'],
  ];
  const host = location.hostname.toLowerCase().replace(/\.$/, '');
  const site = SITES.find(([d]) => host === d || host.endsWith('.' + d));
  const source = site ? site[1] : 'web';
  const siteName = site ? site[2] : host.replace(/^www\./, '');

  // ---------- Prices ----------
  const CUR = '[$£€₹₱]';
  const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?';
  const PRICE_START = new RegExp(
    `^(?:(?:monthly rent|rent|price|from|starting at|starts at)\\s*:?\\s*)?(?:[A-Z]{1,3}\\s?)?${CUR}\\s?\\d`,
    'i'
  );
  const PRICE_PARTS = new RegExp(
    `(${CUR})\\s?${NUM}(?:\\s?(?:[-–]|to)\\s?${CUR}?\\s?${NUM})?\\*?\\+?\\s*(?:\\/\\s*|per\\s+|a\\s+)?(mo(?:nth)?(?:ly)?|wk|week(?:ly)?|night(?:ly)?|day|daily|yr|year(?:ly)?)?\\b`,
    'i'
  );
  const parsePrice = (line) => {
    const m = String(line || '').match(PRICE_PARTS);
    if (!m) return null;
    const amount = parseFloat(m[2].replace(/,/g, ''));
    if (!(amount > 0)) return null;
    const raw = (m[4] || '').toLowerCase();
    const period = !raw
      ? ''
      : /^mo/.test(raw)
        ? 'month'
        : /^(wk|week)/.test(raw)
          ? 'week'
          : /^night/.test(raw)
            ? 'night'
            : /^(day|daily)/.test(raw)
              ? 'day'
              : 'year';
    const high = m[3] ? parseFloat(m[3].replace(/,/g, '')) : null;
    let text = m[1] + amount.toLocaleString('en-US');
    if (high && high > amount) text += ' – ' + m[1] + high.toLocaleString('en-US');
    if (period) text += ' / ' + period;
    return { amount, high: high && high > amount ? high : null, period, text, currency: m[1] };
  };

  // ---------- Structured data (schema.org JSON-LD) ----------
  const HOUSING = /^(apartment|apartmentcomplex|house|singlefamilyresidence|residence|gatedresidencecommunity|accommodation|room|suite|realestatelisting|product|place|lodgingbusiness|offer|aggregateoffer)$/i;
  const typesOf = (n) => [].concat(n['@type'] || []).map((t) => String(t).replace(/^.*[/#]/, ''));
  const ld = { name: '', description: '', price: null, address: '', locality: '', beds: null, siteName: '', siteAddress: '', lat: null, lon: null };
  // A map position: { latitude, longitude } on the node or in its "geo".
  const geoOf = (n) => {
    const g = n.geo && typeof n.geo === 'object' && !Array.isArray(n.geo) ? n.geo : n;
    const lat = parseFloat(g.latitude);
    const lon = parseFloat(g.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon) ? { lat, lon } : null;
  };
  const nodes = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(s.textContent);
    } catch (e) {
      continue;
    }
    const stack = [data];
    let guard = 0;
    while (stack.length && guard++ < 3000) {
      const n = stack.pop();
      if (Array.isArray(n)) {
        for (const v of n) stack.push(v);
      } else if (n && typeof n === 'object') {
        nodes.push(n);
        // A list of search results describes other homes, not this one.
        for (const [k, v] of Object.entries(n)) if (v && typeof v === 'object' && k !== 'itemListElement') stack.push(v);
      }
    }
  }
  for (const n of nodes) {
    const types = typesOf(n);
    // A property's own website describes the property as a business.
    if (source === 'web' && types.some((t) => /^(localbusiness|organization|realestateagent)$/i.test(t)) && n.address && typeof n.name === 'string') {
      const a = n.address;
      if (!ld.siteName) ld.siteName = clean(n.name);
      if (!ld.siteAddress && typeof a === 'object') {
        ld.siteAddress = clean([a.streetAddress, a.addressLocality, [a.addressRegion, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '));
      }
    }
    if (!types.some((t) => HOUSING.test(t))) continue;
    // "Place" alone, without an address, is a city or area page.
    if (types.every((t) => /^(place|product)$/i.test(t)) && !n.address && !n.offers && n.price == null) continue;
    const isOffer = types.some((t) => /offer$/i.test(t));
    if (!isOffer) {
      if (!ld.name && typeof n.name === 'string') ld.name = clean(n.name);
      if (typeof n.description === 'string' && clean(n.description).length > ld.description.length) {
        ld.description = String(n.description).replace(/<[^>]*>/g, ' ').replace(/[^\S\n]+/g, ' ').trim();
      }
      if (ld.beds == null) ld.beds = toNumber(n.numberOfBedrooms) || toNumber(n.numberOfRooms);
    }
    if (ld.lat == null && !isOffer && (n.address || !ld.address)) {
      const g = geoOf(n);
      if (g) {
        ld.lat = g.lat;
        ld.lon = g.lon;
      }
    }
    if (!ld.locality && n.address && typeof n.address === 'object') {
      const a = n.address;
      ld.locality = clean([a.addressLocality, [a.addressRegion, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '));
    }
    if (!ld.address && n.address) {
      const a = n.address;
      ld.address =
        typeof a === 'string'
          ? clean(a)
          : clean(
              [a.streetAddress, a.addressLocality, [a.addressRegion, a.postalCode].filter(Boolean).join(' ')]
                .filter(Boolean)
                .join(', ')
            );
    }
    if (!ld.price) {
      const spec = n.priceSpecification && !Array.isArray(n.priceSpecification) ? n.priceSpecification : {};
      const amount = toNumber(n.price) || toNumber(n.lowPrice) || toNumber(spec.price) || toNumber(spec.minPrice);
      if (amount) {
        const code = String(n.priceCurrency || spec.priceCurrency || 'USD').toUpperCase();
        const sym = { USD: '$', GBP: '£', EUR: '€', INR: '₹', PHP: '₱' }[code] || code + ' ';
        const unit = String(spec.unitText || spec.unitCode || '').toLowerCase();
        const period = /mon/.test(unit) ? 'month' : /wee|wk/.test(unit) ? 'week' : /day|dai|night/.test(unit) ? 'day' : '';
        const high = toNumber(n.highPrice) || toNumber(spec.maxPrice);
        ld.price = { amount, high: high && high > amount ? high : null, period, currency: sym };
      }
    }
  }
  const meta = (name) => {
    for (const el of document.querySelectorAll('meta[property], meta[name]')) {
      if (el.getAttribute('property') === name || el.getAttribute('name') === name) return clean(el.getAttribute('content'));
    }
    return '';
  };

  // ---------- The listing's region of the page ----------
  // A listing opened over search results (Facebook, Zillow, ...) sits in a
  // dialog; read that, not the results behind it.
  const fbDialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    .filter((el) => isVisible(el) && textOf(el).length > 300 && /[$£€₱₹]\s?\d/.test(textOf(el)))
    .sort((a, b) => textOf(b).length - textOf(a).length);
  const candidates = [...document.querySelectorAll('main, [role="main"], article')]
    .filter(isVisible)
    .sort((a, b) => textOf(b).length - textOf(a).length);
  // A listing shown beside or over search results (Zillow, ...): the panel
  // is the largest block around the listing's heading that does not also
  // hold the results' heading.
  const SKIP_H1 = /^(marketplace|notifications|chats?|facebook)$/i;
  const SEARCH_HEADING = /\b(rental listings|rentals available|for rent|rentals)$/i;
  const h1s = [...document.querySelectorAll('h1')].filter((h) => isVisible(h) && clean(textOf(h)) && !SKIP_H1.test(clean(textOf(h))));
  const listingH1 = h1s.find((h) => !SEARCH_HEADING.test(clean(textOf(h))));
  let panel = null;
  // A second copy of the listing's own heading (a sticky bar) does not mark
  // the edge of the listing; only a different heading does.
  const listingText = listingH1 ? clean(textOf(listingH1)) : '';
  const others = h1s.filter((h) => h !== listingH1 && clean(textOf(h)) !== listingText);
  if (listingH1 && others.length) {
    let el = listingH1;
    while (el.parentElement && el.parentElement !== document.body && !others.some((o) => el.parentElement.contains(o))) el = el.parentElement;
    // A block with no price is only the listing's header; the rest of the
    // listing is elsewhere, so it is not used on its own.
    if (textOf(el).length > 200 && /[$£€₱₹]\s?\d/.test(textOf(el))) panel = el;
  }
  let root = fbDialogs[0] || panel || candidates[0] || document.body;
  if (source === 'craigslist') root = document.querySelector('section.body, .body, #pagecontainer') || document.body;

  // A Facebook group: one post, opened on its own page or over the feed, is
  // a listing. The feed is many people's posts, like a page of results.
  let path = '';
  try {
    path = new URL(location.href).pathname;
  } catch (e) {
    path = '';
  }
  // Anything on Facebook outside Marketplace is posts: a group, a page, the
  // news feed, or one post opened in a box over them ("RTN Management's Post").
  const fbPosts = source === 'facebook' && !/\/(marketplace|commerce)\//.test(path);
  let fbPost = null;
  let isFeed = false;
  if (fbPosts) {
    const topArticles = (scope) =>
      [...scope.querySelectorAll('[role="article"]')].filter((a) => isVisible(a) && textOf(a).length > 60 && !(a.parentElement && a.parentElement.closest('[role="article"]')));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => isVisible(d) && topArticles(d).length);
    if (dialog) fbPost = topArticles(dialog)[0];
    else if (/\/(posts|permalink)\//.test(path) || /[?&]multi_permalinks=/.test(location.href)) fbPost = topArticles(document)[0] || null;
    if (fbPost) root = fbPost;
    else isFeed = true;
  }

  // Expand a truncated description ("See more"). Only plain expander
  // buttons: never links, submit buttons or anything inside a form.
  let expanded = 0;
  for (const btn of root.querySelectorAll('[role="button"], button')) {
    if (expanded >= 3) break;
    const label = clean(btn.textContent).toLowerCase();
    if (!/^(see more|read more|show more|more)$/.test(label)) continue;
    if (btn.closest('a[href], form') || (btn.tagName === 'BUTTON' && btn.type === 'submit')) continue;
    if (btn.getAttribute('aria-expanded') === 'true' || !isVisible(btn)) continue;
    btn.click();
    expanded++;
  }
  if (expanded) {
    await sleep(350);
    textCache = new Map();
  }

  // Visible text, line by line, without menus, headers, footers and sidebars,
  // cut where unrelated listings start.
  const END_OF_LISTING = /^(today's picks|similar listings|similar items|similar homes|similar rentals|similar properties|related listings|nearby rentals|nearby homes|nearby apartments|more rentals.*|you may also like|you might also like|recommended for you|recently viewed|people also viewed|more from this seller|sponsored|find (apartments|homes|rentals|places) similar to .*|similar to this (home|listing|property)|reviews for .{2,80}|renter reviews( \d+ reviews?)?|resident reviews|ratings (and|&) reviews|write a review)$/i;
  // Renters' reviews are other people's words about the building, not the
  // listing: they are cut off above (and a bad review is not a scam sign).
  const toLines = (text) => String(text || '').split('\n').map(clean).filter(Boolean);
  const furniture = new Set();
  for (const el of root.querySelectorAll(
    'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]'
  )) {
    // A header that holds the listing's own title is the listing (Apartments.com).
    if (listingH1 && el.contains(listingH1)) continue;
    for (const l of toLines(textOf(el))) furniture.add(l);
  }
  let lines = toLines(textOf(root)).filter((l) => !furniture.has(l));
  const cut = lines.findIndex((l, i) => i > 5 && END_OF_LISTING.test(l));
  if (cut !== -1) lines = lines.slice(0, cut);

  const priceLines = lines.filter((l) => PRICE_START.test(l) && l.length < 80);

  // The structured data must describe the home on screen. If its street
  // address is not in the visible text (a results page, a listing opened in
  // a panel, a stale page after in-site navigation), it is not used at all.
  const shownText = lines.join('\n').toUpperCase();
  // The whole page's lines and text, worked out only if a step needs them.
  let bodyLinesCache = null;
  const bodyLines = () => bodyLinesCache || (bodyLinesCache = toLines(textOf(document.body)));
  let pageTextCache = null;
  const pageText = () => pageTextCache || (pageTextCache = clean(textOf(document.body)).toUpperCase());
  if (ld.price && !shownText.includes(ld.price.amount.toLocaleString('en-US'))) ld.price = null;
  if (ld.description && !shownText.includes(clean(ld.description).slice(0, 50).toUpperCase())) ld.description = '';
  if (ld.address) {
    const sm = ld.address.match(/^\s*(\d{1,6})[a-z]?\s+(?:[NSEW]\.?\s+)?([A-Za-z0-9]+)/i);
    const onScreen = !sm || (shownText.includes(sm[1]) && shownText.includes(sm[2].toUpperCase()));
    if (!onScreen) {
      ld.name = '';
      ld.description = '';
      ld.price = null;
      ld.address = '';
      ld.beds = null;
      ld.lat = null;
      ld.lon = null;
      ld.locality = '';
    }
  }
  // The map position in the page's tags (Apartments.com), when its data has
  // none. Not on a page of results, where it would be the town's.
  if (ld.lat == null && !isFeed) {
    const la = parseFloat(meta('place:location:latitude') || meta('og:latitude'));
    const lo = parseFloat(meta('place:location:longitude') || meta('og:longitude'));
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la || lo)) {
      ld.lat = la;
      ld.lon = lo;
    }
  }

  // A full street address written on the page ("3422 Cheswick Ct, West Lafayette, IN 47906").
  const ADDRESS_LINE_NO_COMMA = /^(\d{1,6}[A-Za-z]?\s+[A-Za-z0-9 .'#/-]{2,80}?,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)\s*$/;
  const ADDRESS_LINE = /^(\d{1,6}[A-Za-z]?\s+[A-Za-z0-9 .'#/-]{2,60},\s*[A-Za-z .'-]{2,40},\s*[A-Z]{2}\b(?:\s*\d{5}(?:-\d{4})?)?)\s*$/;
  let shownAddress = '';
  const addressLines = source === 'web' ? lines.slice(0, 80).concat(bodyLines().slice(-80)) : lines.slice(0, 80);
  for (const l of addressLines) {
    const m = l.length < 140 && (l.match(ADDRESS_LINE) || l.match(ADDRESS_LINE_NO_COMMA));
    if (m) {
      shownAddress = clean(m[1]);
      break;
    }
  }

  // ---------- Title ----------
  let title = '';
  if (source === 'craigslist') title = clean((document.querySelector('#titletextonly') || {}).textContent);
  if (!title && source !== 'facebook') title = ld.name;
  if (!title) {
    for (const h of root.querySelectorAll('h1')) {
      const t = clean(textOf(h));
      if (t && isVisible(h) && !SKIP_H1.test(t) && !SEARCH_HEADING.test(t)) {
        title = t;
        break;
      }
    }
  }
  if (!title) title = meta('og:title');
  if (!title) {
    title = document.title
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/^Marketplace\s*[–-]\s*/i, '')
      .replace(/\s*[|–-]\s*(facebook|zillow|trulia|craigslist|apartments\.com|realtor\.com|redfin|rent\.com|zumper|hotpads)\b.*$/i, '')
      .trim();
  }
  if (/^(facebook|marketplace|craigslist|zillow)$/i.test(title)) title = '';
  const PAGE_NAME = /^(home|floor ?plans?( (&|and) pricing)?|pricing|amenities|gallery|photos|faq|contact( us)?|apply( now)?|availability|neighborhood|location|residents|about( us)?)\b/i;
  // A marketing line ("YOUR NEW WEST LAFAYETTE APARTMENT AWAITS") is not the
  // property's name; the site's name is.
  const SLOGAN = /\b(your|welcome|awaits|discover|experience|you'?ll love|perfect|dream|luxury living|new home|starts here|begins here|live (here|well|better|the life))\b/i;
  if (source === 'web' && (!title || PAGE_NAME.test(title) || SLOGAN.test(title))) {
    const fromDoc = document.title.split(/\s+[|–-]\s+/).map(clean).find((t) => t && !PAGE_NAME.test(t) && !SLOGAN.test(t));
    title = ld.siteName || meta('og:site_name') || fromDoc || title;
  }

  // ---------- Price ----------
  const fmt = (p) => {
    let text = p.currency + p.amount.toLocaleString('en-US');
    if (p.high) text += ' – ' + p.currency + p.high.toLocaleString('en-US');
    if (p.period) text += ' / ' + p.period;
    if (p.total) text += ` ($${p.total.toLocaleString('en-US')} for ${p.nights} nights)`;
    return text;
  };
  const priceOf = (line) => {
    const p = parsePrice(line);
    return p && p.amount >= 100 && p.amount <= 50000 ? p : null;
  };
  let price = null;
  if (source === 'craigslist') price = parsePrice((document.querySelector('.postingtitletext .price, .price') || {}).textContent);

  // 1. A labelled summary: "Monthly Rent" / "$595 - $820".
  if (!price) {
    for (let i = 0; i < Math.min(lines.length - 1, 120); i++) {
      if (/^(monthly rent|rent|price|rent range|monthly price)$/i.test(lines[i]) && PRICE_START.test(lines[i + 1])) {
        price = priceOf(lines[i + 1]);
        if (price) {
          const m = lines[i + 1].match(PRICE_PARTS);
          price.high = m && m[3] ? parseFloat(m[3].replace(/,/g, '')) : null;
          break;
        }
      }
    }
  }
  // A table of units: the lowest to the highest base rent listed in it.
  const UNITS = /^(available units|pricing (&|and) (availability|floor ?plans)|floor ?plans|pricing|units|availability|rent prices)$/i;
  const UNITS_END = /^(what's special|facts,? features.*|facts (and|&) features|amenities|unit amenities|community amenities|fees (and|&) policies|fees|neighborhood|nearby.*|schools|location|reviews|renter reviews|getting around|about .{2,60}|contact this property|similar.*)$/i;
  let units = [];
  lines.forEach((l, i) => {
    if (!UNITS.test(l)) return;
    const found = [];
    for (let j = i + 1; j < lines.length && j < i + 500; j++) {
      if (UNITS_END.test(lines[j])) break;
      if (PRICE_START.test(lines[j]) && lines[j].length < 40) {
        const p = priceOf(lines[j]);
        if (p) found.push(p);
      }
    }
    if (found.length > units.length) units = found;
  });
  const unitsPrice = () => {
    const lo = Math.min(...units.map((p) => p.amount));
    const hi = Math.max(...units.map((p) => p.high || p.amount));
    return { amount: lo, high: hi > lo ? hi : null, period: (units.find((p) => p.period) || {}).period || '', currency: units[0].currency };
  };

  // 2. The site's own structured data (checked against the screen above),
  // unless the page lists its units: Zillow's data can hold the total with
  // fees ($1,764) while the units say the base rent ($950+).
  if (!price && source !== 'facebook' && ld.price && units.length < 2) price = Object.assign({}, ld.price);

  // 3. The units table.
  if (!price && units.length) price = unitsPrice();
  // 4. A property's own website lists only its own plans: their range.
  if (!price && source === 'web' && priceLines.length >= 2) {
    const ps = priceLines.map(priceOf).filter(Boolean);
    if (ps.length >= 2) {
      const lo = Math.min(...ps.map((p) => p.amount));
      const hi = Math.max(...ps.map((p) => p.high || p.amount));
      price = { amount: lo, high: hi > lo ? hi : null, period: (ps.find((p) => p.period) || {}).period || '', currency: ps[0].currency };
    }
  }
  // Short stays (Airbnb, Vrbo): "$524 for 5 nights" is a total; show the
  // nightly price.
  if (!price && (source === 'airbnb' || source === 'vrbo')) {
    for (let i = 0; i < lines.length && !price; i++) {
      const both = lines[i] + ' ' + (lines[i + 1] || '');
      const m = both.match(/^\$\s?([\d,]+(?:\.\d\d)?)\s*(?:total\s*)?for\s*(\d{1,2})\s*nights?\b/i);
      if (m && lines[i].length < 40) {
        const total = parseFloat(m[1].replace(/,/g, ''));
        const nights = parseInt(m[2], 10);
        if (total > 0 && nights > 0) price = { amount: Math.round(total / nights), period: 'night', currency: '$', total, nights };
      }
    }
  }
  // 5. The first price on the page.
  if (!price && priceLines.length) price = priceOf(priceLines[0]);
  // A property's own website may keep its plans outside the main region.
  if (!price && source === 'web') {
    const ps = bodyLines().filter((l) => PRICE_START.test(l) && l.length < 80).map(priceOf).filter(Boolean);
    if (ps.length) {
      const lo = Math.min(...ps.map((p) => p.amount));
      const hi = Math.max(...ps.map((p) => p.high || p.amount));
      price = { amount: lo, high: hi > lo ? hi : null, period: (ps.find((p) => p.period) || {}).period || '', currency: ps[0].currency };
    }
  }
  if (!price) {
    const amount = toNumber(meta('product:price:amount') || meta('og:price:amount'));
    if (amount) price = { amount, period: '', currency: '$' };
  }
  // How often the rent is paid: "rent period: weekly" (Craigslist), or
  // "biweekly" in the title or next to the price.
  const cgAttrs = source === 'craigslist' ? [...document.querySelectorAll('.attrgroup')].map((g) => clean(textOf(g))).join(' | ') : '';
  if (price) {
    const rp = (cgAttrs.match(/rent period:?\s*\|?\s*(daily|weekly|monthly)\b/i) || [])[1];
    const shownPrice = price.currency + price.amount.toLocaleString('en-US');
    const priceLine = lines.find((l) => l.includes(shownPrice)) || '';
    if (/\bbi-?weekly\b|\bevery (two|2) weeks\b/i.test(title + ' ' + priceLine)) price.period = '2 weeks';
    else if (rp && !price.period) price.period = { daily: 'day', weekly: 'week', monthly: 'month' }[rp.toLowerCase()];
    // "Rent: $1,000": rent with no period is monthly in the US.
    else if (!price.period && /^(monthly )?rent\s*:/i.test(priceLine)) price.period = 'month';
  }
  if (price && !price.period) {
    // "$1,200" on one line, "/mo" or "per month" on the next.
    const shown = price.currency + price.amount.toLocaleString('en-US');
    const i = lines.findIndex((l) => l.includes(shown));
    const near = i !== -1 ? (lines[i] + ' ' + (lines[i + 1] || '')).toLowerCase() : '';
    // "rent period: monthly" (Craigslist) or "850.00 / Month" elsewhere.
    const plain = String(price.amount).replace(/\./g, '\\.');
    const monthLine = new RegExp(`(^|[^\\d,])${plain}(\\.00)?\\s*(\\/|per|a)\\s*mo(nth)?\\b`, 'i');
    if (/(\/\s*|per |a )mo(nth)?\b|monthly/.test(near) || lines.some((l) => /^rent period:?\s*monthly$/i.test(l) || (l.length < 60 && monthLine.test(l)))) price.period = 'month';
  }
  // Student housing is often priced per person (per bed), not per unit. Only
  // a price or a short label counts: "$45 application fee per person" does not.
  const FEE = /\b(fee|fees|deposit|application|parking|pet|utilit(y|ies)|insurance|over the age)\b/i;
  let perPerson =
    /\bby[- ]the[- ]bed\b|\bindividual(ly)? leas(e|es|ed|ing)\b|\bper[- ]bed(room)? (pricing|lease)/i.test(lines.join('\n')) ||
    lines.slice(0, 200).some(
      (l) =>
        !FEE.test(l) &&
        (/[$£€₹₱]\s?[\d,]+(\.\d\d)?\+?\s*(\/|per)\s*(person|bed|bedroom|student)\b/i.test(l) ||
          (l.length < 60 && /\/\s*(person|bed)\b|\bper (person|bed|bedroom|student)\b/i.test(l)))
    );
  if (price) price.text = fmt(price);

  // ---------- Location ----------
  let place = '';
  let listedText = '';
  const listedLine = lines.find((l) => /^listed\b/i.test(l));
  if (listedLine) {
    listedText = listedLine;
    const m = listedLine.match(/\bin\s+(.+)$/i);
    if (m) place = m[1].trim();
  }
  if (source === 'craigslist') {
    const addr = document.querySelector('.mapaddress');
    const small = document.querySelector('.postingtitletext small');
    // "2409 Fleming Drive", "7TH STREET near CINCINATTI ST", or just the
    // words "google map" when the poster gave no street.
    const mapText = clean(addr && addr.textContent).replace(/\s+near\s+.*$/i, '');
    place = (/google map/i.test(mapText) ? '' : mapText) || clean(small && small.textContent).replace(/^\(|\)$/g, '') || place;
    // No number on the map: the title often starts with the address
    // ("525 N 7TH STREET APT #2 $450 ...").
    if (!/^\s*\d{1,6}[a-z]?\s/i.test(place)) {
      const STREET = /^\s*(\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,3}?\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|cir|circle|pkwy|trl|trail|pike)\b\.?)/i;
      const t = (title.match(STREET) || [])[1];
      if (t) place = clean(t);
    }
    if (!place && ld.locality) place = ld.locality;
  }
  // A street without its town ("2409 Fleming Drive"): the posting's data has it.
  const streetNum = (place.match(/^\s*(\d{1,6})[a-z]?\s/i) || [])[1];
  if (streetNum && !/,\s*[A-Z]{2}\b/.test(place) && ld.locality) {
    place = ld.address.startsWith(streetNum + ' ') && /,/.test(ld.address) ? ld.address : place + ', ' + ld.locality;
  }
  if (!place && shownAddress) place = shownAddress;
  if (!place && ld.address) place = ld.address;
  if (!place && ld.siteAddress) {
    const sm = ld.siteAddress.match(/^\s*(\d{1,6})[a-z]?\s+(?:[NSEW]\.?\s+)?([A-Za-z0-9]+)/i);
    if (sm && pageText().includes(sm[1]) && pageText().includes(sm[2].toUpperCase())) place = ld.siteAddress;
  }
  const looksLikePlace = (l) => /,\s*[A-Z]{2}\b/.test(l) && l.length < 90 && !/^listed\b/i.test(l);
  if (!place || source === 'facebook') {
    // On Facebook rental listings the street address sits right under the price.
    const pIdx = lines.findIndex((l) => PRICE_START.test(l));
    const near = pIdx !== -1 ? lines.slice(pIdx + 1, pIdx + 5).find(looksLikePlace) : null;
    if (near) place = near;
  }
  if (!place) {
    const approxIdx = lines.findIndex((l) => /^location is approximate$/i.test(l));
    if (approxIdx > 0) place = lines[approxIdx - 1];
  }
  // "Lafayette, Indiana, United States" (Airbnb and others name the town only).
  if (!place) {
    const STATES = 'Alabama AL Alaska AK Arizona AZ Arkansas AR California CA Colorado CO Connecticut CT Delaware DE Florida FL Georgia GA Hawaii HI Idaho ID Illinois IL Indiana IN Iowa IA Kansas KS Kentucky KY Louisiana LA Maine ME Maryland MD Massachusetts MA Michigan MI Minnesota MN Mississippi MS Missouri MO Montana MT Nebraska NE Nevada NV Ohio OH Oklahoma OK Oregon OR Pennsylvania PA Tennessee TN Texas TX Utah UT Vermont VT Virginia VA Washington WA Wisconsin WI Wyoming WY';
    const code = {};
    STATES.split(' ').forEach((w, i, a) => {
      if (i % 2 === 0) code[w] = a[i + 1];
    });
    for (const l of lines.slice(0, 400)) {
      const m = l.length < 80 && l.match(/^([A-Z][A-Za-z .'-]{1,40}), ([A-Z][a-z]+), United States$/);
      if (m && code[m[2]]) {
        place = `${m[1]}, ${code[m[2]]}`;
        break;
      }
    }
  }

  // ---------- Description ----------
  let description = '';
  if (source === 'craigslist') {
    const body = document.querySelector('#postingbody');
    if (body) description = textOf(body).replace(/^\s*QR Code Link to This Post\s*/i, '').trim();
  }
  if (!description) {
    const START = /^(description|about (this|the) (home|house|property|apartment|unit|place|rental|listing|space|room)|what's special|overview|property description|details from the (owner|landlord|seller)|the space)$/i;
    const STOP = /^(see less|see translation|seller information|seller details|rental location|location is approximate|message|send seller a message|today's picks|sponsored|facts (and|&) features|features|amenities|unit amenities|community amenities|fees|fees and policies|policies|price history|neighborhood|schools|nearby schools|getting around|location|map|contact|contact (the )?(property|landlord|manager)|office hours|lease terms|tour|request a tour|floor ?plans|pricing (and|&) floor ?plans|unique features)$/i;
    // Apartments.com and others head it "About <the building's name>".
    const aboutName = title ? 'about ' + title.toLowerCase() : '';
    const idx = lines.findIndex((l) => START.test(l) || (aboutName && l.toLowerCase() === aboutName));
    if (idx !== -1) {
      const out = [];
      for (let i = idx + 1; i < lines.length && out.length < 60; i++) {
        if (STOP.test(lines[i])) break;
        out.push(lines[i]);
      }
      description = out.join('\n');
    }
  }
  if (!description && source !== 'facebook' && ld.description.length >= 40) description = ld.description;
  if (!description) {
    // Fallback: the longest paragraph on the page is almost always the description.
    let longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (longest.length < 80) {
      const og = meta('og:description');
      if (og.length > longest.length) longest = og;
    }
    if (longest.length >= 80) description = longest;
  }
  description = description.replace(/\s*…?\s*see (more|less)$/i, '').trim();

  // ---------- A Facebook group post ----------
  // Author, time, then the post; comments start after Like/Comment/Share.
  let fbAuthor = '';
  if (fbPost) {
    const UI = /^(like|comment|share|send|follow|reply|see translation|·|\d+|\d+ comments?|\d+ shares?|all reactions:?.*)$/i;
    const endAt = lines.findIndex((l) => /^(most relevant|all comments|newest|write a (public )?comment.*|view (more|all|\d+) (previous )?comments?)$/i.test(l));
    const post = (endAt > 0 ? lines.slice(0, endAt) : lines).filter((l) => !UI.test(l));
    const timeAt = post.findIndex((l, i) => i < 4 && /^(\d+\s?(m|h|d|w|min|mins|hr|hrs|y)|just now|yesterday|(january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}.*)\s*·?$/i.test(l));
    // "RTN Management is in West Lafayette, IN." -> the author, and a town.
    const head = (post[0] || '').match(/^(.{2,80}?) (?:is|was) (?:in|at) (.{2,60}?)\.?$/);
    fbAuthor = head ? head[1] : post[0] || '';
    const body = post.slice(timeAt !== -1 ? timeAt + 1 : 1);
    lines = post;
    description = body.join('\n').slice(0, 5000);
    // The post's first line, cut to a title's length at a word, without the
    // emoji around it ("House For Rent 🏠").
    const first = (body[0] || title).replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9$).!?]+$/g, '');
    title = first.length <= 90 ? first : first.slice(0, 90).replace(/\s+\S*$/, '') + '…';
    // "Location: 📍 Covington St, West Lafayette, IN 47906"
    const loc = body.map((l) => l.match(/^(?:location|address|where)\s*:\s*[^A-Za-z0-9]*(.{4,120})$/i)).find(Boolean);
    // The post's own "Location:" line wins over anything guessed near the
    // price (which may be that same line with its label still on).
    if (loc) place = clean(loc[1]);
    if (!place && head && /,\s*[A-Z]{2}\b/.test(head[2])) place = clean(head[2]);
  }

  // A price written in the text ("Rent is $900 per month for the room").
  if (!price) {
    const text = description + '\n' + lines.slice(0, 80).join('\n');
    const m = text.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d{3,5})(?:\.\d\d)?\s*(?:\/|per|a)\s*(month|mo)\b/i) || text.match(/\brent\b[^.$\n]{0,20}\$\s?(\d{1,3}(?:,\d{3})+|\d{3,5})(?:\.\d\d)?/i);
    const amount = m ? parseFloat(m[1].replace(/,/g, '')) : 0;
    if (amount >= 100 && amount <= 50000) {
      price = { amount, period: m[2] || /per month|a month|\/\s*mo/i.test(m[0]) ? 'month' : '', currency: '$' };
      price.text = fmt(price);
    }
  }
  // Only the town in the text ("my room at The Ivy in West Lafayette").
  if (!place) {
    const text = title + '\n' + description;
    const town = text.match(/\b(West Lafayette|Lafayette)\b/);
    if (town && (/\b(purdue|indiana|tippecanoe)\b/i.test(text) || /\bIN\b/.test(text))) place = `${town[1]}, IN`;
  }

  // ---------- Seller + unit details ----------
  let sellerJoinedYear = null;
  const joined = lines.join('\n').match(/joined facebook in (\d{4})/i);
  if (joined) sellerJoinedYear = parseInt(joined[1], 10);

  // Every bedroom count the listing shows ("2 beds", "1-3 beds", "Studio,
  // 1 bath", "2 - 4 bd"): a building has a range, a home has one number.
  const attrs = source === 'craigslist' ? clean(textOf(document.querySelector('.attrgroup'))) : '';
  const BED_LINE = /^(studio|\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(beds?|bd|bds|bedrooms?|br)?\b/i;
  const counts = [];
  // A range written on the page ("Studio-2 beds", "2 - 4 bd") marks a
  // building with several unit sizes.
  let rangeShown = false;
  const countBeds = (list) => {
    for (const l of list) {
      if (!l || l.length > 60 || /filter/i.test(l)) continue;
      const m = l.match(BED_LINE);
      if (!m || (!m[3] && !/^studio/i.test(m[1]))) continue;
      counts.push(/^studio/i.test(m[1]) ? 0 : parseInt(m[1], 10));
      if (m[2]) {
        counts.push(parseInt(m[2], 10));
        rangeShown = true;
      }
    }
  };
  countBeds([title, attrs].concat(lines.slice(0, 400)));
  // A property's own website may keep its plans outside the main region.
  if (!counts.length && source === 'web') countBeds(bodyLines().slice(0, 600));
  if (!counts.length) {
    const unitText = [title, attrs, lines.slice(0, 40).join('\n')].join('\n');
    const bedMatch = unitText.match(/(\d+)\s*(?:beds?|bedrooms?|bds?|br)\b/i);
    if (bedMatch) counts.push(parseInt(bedMatch[1], 10));
    else if (/\bstudio\b/i.test(unitText)) counts.push(0);
  }
  const plausible = counts.filter((n) => n >= 0 && n <= 12);
  // A single home: the page data's count wins over stray labels. A building
  // whose page shows a range: the fewest bedrooms shown (its data often
  // describes just one unit).
  let beds =
    rangeShown && plausible.length
      ? Math.min(...plausible, ld.beds != null ? ld.beds : Infinity)
      : ld.beds != null
        ? ld.beds
        : plausible.length
          ? Math.min(...plausible)
          : null;
  const bedsMax = plausible.length ? Math.max(...plausible, beds || 0) : beds;

  // Floor plans whose rent falls as the bedrooms rise ("2 Bedroom ... $820",
  // "4 Bedroom ... $595") are priced per bedroom, even when the page does not
  // say so: a whole bigger unit never costs less.
  if (!perPerson) {
    const plans = [];
    lines.forEach((l, i) => {
      if (!PRICE_START.test(l) && !/\$\s?\d/.test(l)) return;
      const p = priceOf(l);
      if (!p) return;
      // "4 bed $499+" on one line (Zillow's plan filters).
      const same = l.length <= 40 && l.match(BED_LINE);
      if (same && same[3] && !same[2] && !/^studio/i.test(same[1])) {
        plans.push({ beds: parseInt(same[1], 10), amount: p.amount });
        return;
      }
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const m = lines[j].length <= 60 && lines[j].match(BED_LINE);
        if (m && m[3] && !m[2]) {
          plans.push({ beds: parseInt(m[1], 10), amount: p.amount });
          break;
        }
      }
    });
    const sizes = plans.map((p) => p.beds);
    if (plans.length >= 2 && Math.max(...sizes) > Math.min(...sizes)) {
      const priceAt = (n) => Math.min(...plans.filter((p) => p.beds === n).map((p) => p.amount));
      if (priceAt(Math.max(...sizes)) < priceAt(Math.min(...sizes))) perPerson = true;
    }
  }

  // One room in a shared home: priced per room, whatever the home's size.
  const isRoom = /\b(private|shared|furnished)\s+(bed)?room\b|\b(bed)?room\s+(for rent|available|in a)\b|\bsublet room\b|\broom ?mates?\b|\btake over my (room|spot)\b|\bmy room (at|in)\b|\b(iso|seeking|looking for|need(ed|ing)?) (a )?(female |male )?(roommate|subleaser|tenant for (a|one) room)\b/i.test(title);
  const hasStreetAddress = /^\s*\d{1,6}[a-z]?\s+\S/i.test(place);
  let streetHint = '';
  if (!hasStreetAddress) {
    const sm = (description + '\n' + lines.slice(0, 60).join('\n')).match(
      /\b(?:on|at|off)\s+((?:[NSEW]\.?\s+)?[A-Z][a-z]{2,20}(?:\s[A-Z][a-z]{2,20})?\s(?:St|Street|Dr|Drive|Ave|Avenue|Rd|Road|Ln|Lane|Ct|Court|Blvd|Way|Pl|Place|Cir|Circle|Pkwy|Trl|Trail|Pike))\b/
    );
    if (sm) streetHint = sm[1];
    // "Covington St, West Lafayette, IN": a street with no house number.
    const first = place.split(',')[0].trim();
    if (!streetHint && /^[A-Za-z][A-Za-z .'-]{1,40} (St|Street|Dr|Drive|Ave|Avenue|Rd|Road|Ln|Lane|Ct|Court|Blvd|Way|Pl|Place|Cir|Circle|Pkwy|Trl|Trail|Pike)\.?$/i.test(first)) streetHint = first;
  }

  // ---------- Who posted it ----------
  // Only the name shown on the listing; used to compare with the owner on
  // public record. Nothing else about the person is read.
  let listerName = '';
  const looksLikeName = (l) => l.length >= 3 && l.length <= 80 && !/\d{3}|https?:|@|seller details|see profile|message|follow|rating/i.test(l);
  const sellerIdx = lines.findIndex((l) => /^(seller information|seller details|listed by|posted by|landlord|property manager|managed by|contact)$/i.test(l));
  if (sellerIdx !== -1) {
    listerName = lines.slice(sellerIdx + 1, sellerIdx + 4).find((l) => looksLikeName(l) && !/^(seller|details|joined)/i.test(l)) || '';
  }
  if (!listerName) {
    const m = lines.join('\n').match(/^(?:listed by|posted by|managed by|landlord|property manager|owner)\s*:\s*(.+)$/im);
    if (m && looksLikeName(clean(m[1]))) listerName = clean(m[1]);
  }
  if (!listerName && fbAuthor && looksLikeName(fbAuthor)) listerName = fbAuthor;

  // ---------- Main photo (for a reverse image search on request) ----------
  let photoUrl = '';
  let bestArea = 0;
  for (const img of root.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    const area = r.width * r.height;
    const src = img.currentSrc || img.src || '';
    if (area > bestArea && area >= 150 * 150 && /^https:\/\//i.test(src)) {
      bestArea = area;
      photoUrl = src;
    }
  }
  const ogImage = meta('og:image');
  if (!photoUrl && /^https:\/\//i.test(ogImage)) photoUrl = ogImage;

  // ---------- What to scan ----------
  // Facebook: the whole listing panel (short, and written by the seller).
  // Elsewhere: the seller's description when one was found, so page
  // furniture ("Application fee $50" tables, office e-mails, ads) does not
  // raise flags. Without one, the main region's text.
  let scope = 'page';
  let fullText = lines.join('\n');
  if (source !== 'facebook' && description.length >= 80) {
    scope = 'description';
    fullText = [title, description].filter(Boolean).join('\n');
  }

  // A property's own website lists its floor plans: that is not a results page.
  const looksLikeResults = isFeed || (source !== 'web' && !description && priceLines.length >= 6 && !panel);
  const isListing = !looksLikeResults && Boolean((price || description) && (title || description));
  // A stay priced by the night (Airbnb, Vrbo): not compared with monthly rents.
  const shortStay = source === 'airbnb' || source === 'vrbo' || (price && (price.period === 'night' || price.period === 'day'));

  return {
    source,
    siteName,
    url: window.location.href,
    isListing,
    looksLikeResults,
    scope,
    title,
    priceText: price ? price.text : '',
    priceAmount: price ? price.amount : null,
    priceHigh: price && price.high ? price.high : null,
    perPerson,
    pricePeriod: price ? price.period : '',
    priceCurrency: price ? price.currency : '',
    location: place,
    listedText,
    description,
    sellerJoinedYear,
    beds,
    bedsMax: bedsMax != null && bedsMax !== beds ? bedsMax : null,
    isRoom,
    hasStreetAddress,
    streetHint,
    listerName: listerName.slice(0, 80),
    // The site's own map position for this home, when it publishes one.
    isFeed,
    shortStay: Boolean(shortStay),
    lat: ld.lat,
    lon: ld.lon,
    photoUrl: photoUrl.slice(0, 2000),
    fullText: fullText.slice(0, 20000),
  };
}
