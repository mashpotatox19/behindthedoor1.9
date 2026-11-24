/*
 * BehindTheDoor — text analyzer.
 * Pure functions, no DOM or chrome.* access, so it can be tested on its own.
 * Exposes: BTD.analyze(listing) and BTD.DEMO_LISTING
 */
(function (root) {
  'use strict';

  // Points removed from the 100-point reliability score per warning.
  const WEIGHTS = { high: 40, medium: 20, low: 10 };
  const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

  // "G" = gap that stays inside one sentence / one line.
  const G = (n) => `[^.!?\\n]{0,${n}}`;
  const rx = (source) => new RegExp(source, 'i');

  const RULES = [
    {
      id: 'pay-before-viewing',
      severity: 'high',
      title: 'Payment requested before touring/viewing',
      advice:
        'The description appears to ask for money before an in-person or virtual tour. Do not pay to view a property.',
      patterns: [
        rx(`\\b(deposit|payment|fee|money|rent)\\b${G(60)}\\b(before|prior to|in order to|to (schedule|book|arrange|get))\\b${G(30)}\\b(view|viewing|tour|touring|showing|seeing|see|visit)`),
        rx(`\\b(before|prior to)\\b${G(30)}\\b(viewing|tour|showing|seeing|visit)\\b${G(60)}\\b(deposit|payment|pay|fee)\\b`),
        rx(`\\b(pay|send|deposit)\\b${G(40)}\\bsight unseen\\b`),
        // "Sign the lease first, then I will arrange a viewing."
        rx(`\\bsign\\b${G(30)}\\b(lease|contract|agreement)\\b${G(40)}\\b(before|prior to)\\b${G(30)}\\b(view|viewing|tour|showing|seeing|see|visit)`),
      ],
    },
    {
      id: 'fake-platform-payment',
      severity: 'high',
      title: 'Says a website will hold your payment',
      advice:
        'Airbnb, Zillow, Facebook, PayPal and others do not hold deposits for private rentals. Emails or invoices that say so are fake.',
      patterns: [
        rx(`\\b(airbnb|zillow|facebook|marketplace|paypal|amazon|ebay|trulia|apartments\\.com)\\b${G(40)}\\b(hold|holds|protect|protects|secure|secures|guarantee|guarantees|escrow)\\b${G(20)}\\b(payment|deposit|money|funds|transaction)`),
        rx(`\\b(payment|deposit|money|funds)\\b${G(30)}\\b(held|protected|secured|guaranteed) by\\b${G(20)}\\b(airbnb|zillow|facebook|paypal|amazon|ebay|trulia)\\b`),
        rx(`\\b(rental|payment|deposit) (protection|guarantee) (program|policy|service)\\b`),
      ],
    },
    {
      id: 'code-after-payment',
      severity: 'high',
      title: 'Lockbox or door code sent after you pay',
      advice:
        'Getting a lockbox or door code only after paying is a common scam: the code fails or the home is someone else\'s. Meet a person at the property.',
      patterns: [
        rx(`\\b(lock ?box|key ?box|door code|key ?code|access code|gate code|keypad)\\b${G(60)}\\b(after|once|when|as soon as)\\b${G(30)}\\b(pay|paid|payment|deposit|receive|transfer)`),
        rx(`\\b(after|once|when|as soon as)\\b${G(30)}\\b(pay|paid|payment|deposit|receive)\\b${G(60)}\\b(lock ?box|key ?box|door code|key ?code|access code|keypad)\\b`),
      ],
    },
    {
      id: 'untraceable-payment',
      severity: 'high',
      title: 'Hard-to-trace payment method',
      advice:
        'Wire transfers, gift cards and cryptocurrency are almost impossible to recover. Legitimate landlords do not require them.',
      patterns: [
        rx(`\\b(wire transfer|western union|money ?gram|gift ?cards?|bitcoin|btc|crypto(currency)?|usdt|steam cards?|itunes cards?|prepaid (debit )?cards?)\\b`),
        rx(`\\bwire (me |us )?(the |your )?(money|funds|payment|deposit)\\b`),
      ],
    },
    {
      id: 'keys-by-mail',
      severity: 'high',
      title: 'Keys to be mailed or shipped',
      advice:
        'Offering to mail the keys after payment is a classic rental scam. Keys should be handed over in person at the property.',
      patterns: [
        rx(`\\b(mail|ship|send|courier|fedex|dhl|overnight)\\b${G(40)}\\bkeys?\\b`),
        rx(`\\bkeys?\\b${G(40)}\\b(mailed|shipped|sent|delivered|courier|fedex|dhl)\\b`),
      ],
    },
    {
      id: 'verification-code',
      severity: 'high',
      title: 'Asks for a verification code',
      advice:
        'Never share a code that was texted to you. Scammers use it to take over accounts or create phone numbers in your name.',
      patterns: [
        rx(`\\b(verification|confirmation|security|6[- ]digit|six[- ]digit) code\\b`),
        rx(`\\bcode\\b${G(30)}\\b(sent|texted) to your (phone|number)\\b`),
      ],
    },
    {
      id: 'viewing-restrictions',
      severity: 'medium',
      title: 'Viewing restrictions',
      advice:
        'The listing suggests the property cannot be viewed. Ask for a verifiable tour before paying or sharing sensitive information.',
      patterns: [
        rx(`\\bno (in[- ]person |physical )?(showings?|viewings?|tours?|visits?)\\b`),
        rx(`\\b(can ?not|can't|unable to|won't be able to|not able to|not available to) (show|meet|be there|give (a |you a )?tours?)\\b`),
        rx(`\\b(drive by|view (it )?from (the )?outside|exterior only|outside only)\\b`),
        rx(`\\bsight unseen\\b`),
        rx(`\\b(virtual|video) (tours?|showings?) only\\b`),
        rx(`\\bdo not disturb (the )?(current )?(tenants?|occupants?|residents?)\\b`),
      ],
    },
    {
      id: 'payment-pressure',
      severity: 'medium',
      title: 'Pressure to pay quickly',
      advice:
        'Urgency linked to a payment is a warning sign. A legitimate renter should have time to verify details and review paperwork.',
      patterns: [
        rx(`\\bfirst (person|one|applicant|to)\\b${G(30)}\\b(send|sends|pay|pays|deposit|deposits|put down|puts down)\\b`),
        rx(`\\b(send|pay|deposit|wire|transfer)\\b${G(40)}\\b(today|right now|immediately|asap|right away|within \\d+ ?(hours?|hrs?))\\b`),
        rx(`\\b(many|several|lots of|a lot of|other) (people|others|applicants|renters)?\\s?(are |is )?(already )?interested\\b`),
        rx(`\\b(deposit|payment)\\b${G(30)}\\b(holds?|secures?|reserves?) (it|the (place|unit|home|house|apartment|property))\\b`),
      ],
    },
    {
      id: 'landlord-away',
      severity: 'medium',
      title: 'Landlord says they are away',
      advice:
        'Being away is not evidence of fraud, but it makes independent verification of management authority more important.',
      patterns: [
        rx(`\\b(out of (the )?(country|state|town)|overseas|abroad|missionary|mission (trip|work)|deployed|deployment|offshore|oil rig|on a (business|work) trip)\\b`),
        rx(`\\b(i|we) (have |had |just |recently )*(relocated|moved|been transferred) (to|for|out)\\b`),
      ],
    },
    {
      id: 'p2p-payment',
      severity: 'medium',
      title: 'Payment app requested',
      advice:
        'Zelle, Cash App and Venmo payments work like cash and are rarely refunded. Only use them with people you have verified.',
      patterns: [rx(`\\b(zelle|cash ?app|venmo|paypal (friends|f&f|f and f)|apple cash|chime)\\b`), rx(`\\bmoney ?orders?\\b`)],
    },
    {
      id: 'form-application',
      severity: 'medium',
      title: 'Application through a Google Form',
      advice:
        'Real property managers use a rental application portal, not a Google Form. Do not type your Social Security number, ID or bank details into one.',
      patterns: [rx(`\\b(docs\\.google\\.com\\/forms|forms\\.gle)\\/\\S*`), rx(`\\b(fill|complete)\\b${G(20)}\\b(google form|the form i (sent|will send))\\b`)],
    },
    {
      id: 'sensitive-info',
      severity: 'medium',
      title: 'Asks for sensitive personal information',
      advice:
        'Do not send ID photos, bank details or your Social Security number before you have verified the landlord and seen the property.',
      patterns: [
        rx(`\\b(social security( number)?|ssn)\\b`),
        rx(`\\b(bank account|routing number|credit card (number|details|info))\\b`),
        rx(`\\b(copy|photo|picture|scan) of (your |a valid |valid )?(id\\b|i\\.d\\.|driver'?s? licen[sc]e|passport)`),
      ],
    },
    {
      id: 'off-platform-contact',
      severity: 'low',
      title: 'Unusual contact instructions',
      advice:
        'The description directs contact to an external messaging service. Confirm the contact matches the legitimate property manager.',
      patterns: [
        rx(`\\b(telegram|whats ?app|kik|google (voice|chat|hangouts)|hangouts|snapchat)\\b`),
        rx(`\\b(text|email|e-mail|contact|reach|message)\\b${G(30)}\\b(only|directly|instead)\\b`),
        rx(`\\b(do not|don't) (message|reply|respond|contact)\\b${G(20)}\\b(here|on facebook|messenger|marketplace|craigslist|zillow|(this|the) (site|app|website))\\b`),
        // A personal webmail address in the ad. Property managers' own
        // domains are not flagged. Lengths are bounded so a long run of
        // letters cannot make the match slow.
        rx(`\\b[a-z0-9._%+-]{1,64}@(gmail|yahoo|ymail|hotmail|outlook|live|aol|icloud|me|proton(mail)?|gmx|mail|yandex)\\.[a-z]{2,6}\\b`),
      ],
    },
    {
      id: 'upfront-fee',
      // A site's own fee table ("Application Fee $50") is not the lister asking.
      ownWordsOnly: true,
      severity: 'low',
      title: 'Upfront fee mentioned',
      advice:
        'Application and screening fees are common, but only pay them after a tour and through a company you can verify.',
      // "Zero application fee" / "no admin fee" is the opposite.
      patterns: [rx(`(?<!\\b(no|zero|free|waived|without)\\s)\\b(application|background check|credit (check|report)|screening|processing|admin(istration)?) fees?\\b(?!\\s+(waived|is waived|are waived))`)],
    },
    {
      id: 'external-link',
      ownWordsOnly: true,
      severity: 'low',
      title: 'External link in the description',
      advice:
        'Links to outside sites are often used for fake applications or credit-report sign-ups. Do not enter personal details there.',
      // Rental platforms landlords really use for applications are not flagged.
      patterns: [
        rx(`\\b(bit\\.ly|tinyurl\\.com|rb\\.gy|cutt\\.ly|is\\.gd|t\\.ly)\\/\\S+`),
        rx(`\\bhttps?:\\/\\/(?!docs\\.google\\.com\\/forms|forms\\.gle)(?!(?:[a-z0-9-]+\\.)*(?:turbotenant|appfolio|buildium|managebuilding|rentcafe|avail|rentredi|zillow|apartments|rentmanager|entrata|realpage|rentspree|tenantcloud|purdue|spareroom|roomster|roomies|facebook|airbnb|vrbo|craigslist)\\.(?:com|co|edu)\\b)\\S+`),
      ],
    },
    {
      id: 'no-screening',
      severity: 'low',
      title: 'No screening or paperwork',
      advice:
        'Promises of no credit check, no lease or no paperwork are used to rush renters. A real rental should come with a written lease.',
      patterns: [
        rx(`\\bno (credit|background) checks?\\b`),
        rx(`\\bno (lease|paperwork|contract)( is)?( needed| required)?\\b`),
        rx(`\\bbad credit (ok|okay|welcome|accepted)\\b`),
      ],
    },
    {
      id: 'scam-script',
      severity: 'low',
      title: 'Wording common in scam scripts',
      advice:
        'This phrasing shows up often in copy-pasted scam messages. On its own it proves nothing, but be extra careful.',
      patterns: [
        rx(`\\b(god[- ]fearing|not after the money|absolute care|as if it (were|was) your own|as your own)\\b`),
        rx(`\\bhonest (and|&) (trustworthy|responsible|reliable) (tenant|person|family)\\b`),
        rx(`\\bkindly (get back|contact|send|fill|provide|text|email|reply|reach)\\b`),
      ],
    },
  ];

  function normalize(text) {
    return String(text || '')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  // Evidence: the matched phrase plus ~60 characters of context either side,
  // trimmed to whole words.
  function snippet(text, index, length) {
    const RADIUS = 60;
    let start = Math.max(0, index - RADIUS);
    let end = Math.min(text.length, index + length + RADIUS);
    if (start > 0) {
      const sp = text.indexOf(' ', start);
      if (sp !== -1 && sp < index) start = sp + 1;
    }
    if (end < text.length) {
      const sp = text.lastIndexOf(' ', end);
      if (sp > index + length) end = sp;
    }
    const clean = (s) => s.replace(/\n/g, ' ');
    return {
      before: (start > 0 ? '…' : '') + clean(text.slice(start, index)),
      match: clean(text.slice(index, index + length)),
      after: clean(text.slice(index + length, end)) + (end < text.length ? '…' : ''),
    };
  }

  // What the check looked for, in renters' words: each line shows as passed
  // (ok) or found, so a good rating says what it is based on.
  const CHECKS = [
    { ids: ['pay-before-viewing', 'code-after-payment', 'keys-by-mail'], ok: 'No request to pay before you see it', bad: 'Wants money before you see it' },
    { ids: ['untraceable-payment', 'p2p-payment', 'fake-platform-payment'], ok: 'No wire, gift card, crypto or payment-app demand', bad: 'Payment that is hard to get back' },
    { ids: ['payment-pressure'], ok: 'No pressure to pay fast', bad: 'Pressure to pay fast' },
    { ids: ['viewing-restrictions', 'landlord-away'], ok: 'Nothing stops you from touring it', bad: 'You may not be able to tour it' },
    { ids: ['verification-code', 'sensitive-info', 'form-application'], ok: 'No request for codes, ID or bank details', bad: 'Asks for codes, ID or bank details' },
    { ids: ['off-platform-contact', 'external-link'], ok: 'Contact stays on the site', bad: 'Moves contact off the site' },
    { ids: ['scam-script', 'no-screening', 'upfront-fee'], ok: 'No copied scam wording', bad: 'Wording often seen in scams' },
    { ids: ['new-account'], ok: 'Seller account is not brand new', bad: 'Seller account is brand new', when: (l) => l.sellerJoinedYear != null },
    { ids: ['low-price'], ok: 'Rent is not suspiciously low', bad: 'Rent is suspiciously low', when: (l) => Number(l.priceAmount) > 0 },
    { ids: ['type-mismatch', 'sale-listing-copy'], ok: 'Title and description describe the same rental', bad: 'Title and description do not agree' },
    // Only when the site gave a map pin in the Lafayette area to compare with.
    { ids: ['location-mismatch'], ok: 'Map pin matches where it says it is', bad: 'Map pin is far from where it says it is', when: (l) => l.campusMiles != null && Number.isFinite(Number(l.campusMiles)) },
  ];

  function levelFor(score, flagCount) {
    if (flagCount === 0) return { key: 'good', label: 'No warning signs found' };
    if (score >= 70) return { key: 'low', label: 'Low concern' };
    if (score >= 40) return { key: 'medium', label: 'Moderate concern' };
    return { key: 'high', label: 'High concern' };
  }

  function summaryFor(flags) {
    const n = flags.length;
    if (n === 0) {
      return 'No scam wording was found in the text. That is not proof the listing is real — still verify the landlord and tour the property.';
    }
    const high = flags.filter((f) => f.severity === 'high').length;
    const signs = n === 1 ? '1 warning sign' : `${n} warning signs`;
    if (high > 0) {
      return `${signs} found, ${high} of them serious. Do not send money or personal details.`;
    }
    return `${signs} found. Verify the landlord and see the property before paying anything.`;
  }

  /**
   * listing: { title, description, fullText, priceAmount, pricePeriod,
   *            priceText, beds, sellerJoinedYear, ... }
   * returns: { score, stars, level, summary, flags[] }
   */
  function analyze(listing, now) {
    listing = listing || {};
    const text = normalize(listing.fullText || [listing.title, listing.description].filter(Boolean).join('\n')).slice(0, 20000);
    const flags = [];

    // Without a description, a listing site's whole page was scanned: its fee
    // tables and links are the site's, not the lister's words.
    // A landlord's own website ('web') is the lister's own words, so it stays in.
    const siteText = listing.scope === 'page' && !['facebook', 'craigslist', 'paste', 'demo', 'web', undefined].includes(listing.source);
    for (const rule of RULES) {
      if (rule.ownWordsOnly && siteText) continue;
      for (const pattern of rule.patterns) {
        const m = pattern.exec(text);
        if (m) {
          // Extend the highlight to the end of a partly matched word.
          let length = m[0].length;
          while (/\w/.test(text[m.index + length] || '') && /\w$/.test(m[0])) length++;
          flags.push({
            id: rule.id,
            severity: rule.severity,
            title: rule.title,
            advice: rule.advice,
            evidence: snippet(text, m.index, length),
          });
          break;
        }
      }
    }

    // Seller account age (Facebook shows "Joined Facebook in 2024").
    const year = Number(listing.sellerJoinedYear);
    const thisYear = (now || new Date()).getFullYear();
    if (year && year >= thisYear - 1 && year <= thisYear) {
      const brandNew = year === thisYear;
      flags.push({
        id: 'new-account',
        severity: brandNew ? 'medium' : 'low',
        title: brandNew ? 'Seller account is brand new' : 'Seller account is fairly new',
        advice:
          'Scam listings are often posted from recently created or hijacked profiles. Look at the seller profile, other listings and reviews.',
        evidence: { before: '', match: `Joined Facebook in ${year}`, after: '' },
      });
    }

    // Very low monthly rent. Where the area's rents are known (listing.rent,
    // from area.js), below half of them; elsewhere, conservative floors below
    // which a whole US unit is rarely rented.
    const amount = Number(listing.priceAmount);
    const rent = listing.rent && Number.isFinite(listing.rent.ratio) ? listing.rent : null;
    // The area comparison has already turned weekly rent into monthly.
    const monthly = rent || !listing.pricePeriod || /^mo/i.test(listing.pricePeriod);
    const dollars = /\$/.test(listing.priceText || '');
    const beds = Number(listing.beds) || 0;
    // A room in a shared home is priced per room, whatever the home's size.
    const floor = listing.isRoom || listing.perPerson ? 250 : beds >= 3 ? 800 : beds === 2 ? 600 : 400;
    const tooLow = rent ? rent.ratio < 0.5 : amount < floor;
    if (amount > 0 && monthly && dollars && tooLow) {
      flags.push({
        id: 'low-price',
        severity: 'low',
        title: 'Rent looks unusually low',
        advice: rent
          ? `Less than half the usual rent for a home like this here (about $${Number(rent.reference).toLocaleString('en-US')}). A price far below the area is the most common bait in rental scams.`
          : 'A price far below similar rentals is the most common bait in rental scams. Compare with other listings in the same area.',
        evidence: { before: '', match: listing.priceText, after: '' },
      });
    }

    // A home-for-sale ad posted as a rental: scammers copy sale listings.
    const SALE = /\bmake (this|it) your (dream )?home\b|\byour dream home\b|\b(listing agent|buyer'?s agent|closing costs|down payment|mls ?#|mls number)\b/i;
    const sale = SALE.exec(text);
    if (sale) {
      flags.push({
        id: 'sale-listing-copy',
        severity: 'low',
        title: 'Wording from a home-for-sale ad',
        advice:
          'Scammers often copy a home-for-sale ad and post it as a rental. Search the address on Zillow or Realtor.com: if it is for sale, the "landlord" is probably not real.',
        evidence: snippet(text, sale.index, sale[0].length),
      });
    }

    // The title and the description describe different homes ("Apartment B"
    // in the title, "single-family home" in the text): a pasted description.
    const title = String(listing.title || '');
    const desc = String(listing.description || '');
    const typeClash =
      (/\b(apartment|apt\.?|condo|unit [a-z0-9]{1,4})\b/i.test(title) && /\bsingle[- ]family (home|house|residence)\b|\bdetached (home|house)\b/i.exec(desc)) ||
      (/\b(single[- ]family|house|home for rent)\b/i.test(title) && /\b(apartment|apt) (complex|building|community)\b|\bin our apartment community\b/i.exec(desc));
    if (typeClash) {
      flags.push({
        id: 'type-mismatch',
        severity: 'low',
        title: 'Title and description describe different homes',
        advice: `The title says "${title.slice(0, 60)}", but the description describes something else. A description pasted from another ad is a common sign of a fake listing. Ask which it is, and see it in person.`,
        evidence: { before: '', match: typeClash[0], after: '' },
      });
    }

    // "2 blocks from Mackey Arena", but the site's map pin is miles away.
    // listing.campusMiles is filled in by the popup from the map pin.
    const NEAR = /\b(\d|one|two|three|four|five|a few|a couple( of)?)\s+blocks?\s+(from|to|of|away from)\s+(campus|purdue|mackey( arena)?|ross[- ]ade|the memorial union|pmu|the university)\b|\b(walk|walking distance|steps|a short walk|minutes? walk)\s+(to|from)\s+(campus|purdue|mackey)\b|\bacross (the street )?from (campus|purdue)\b/i;
    const near = NEAR.exec(text);
    const miles = Number(listing.campusMiles);
    if (near && Number.isFinite(miles) && miles > 2) {
      flags.push({
        id: 'location-mismatch',
        severity: 'medium',
        title: 'Says it is next to campus, but the map says otherwise',
        advice: `The listing's own map pin is about ${miles.toFixed(1)} miles from campus. A location that does not match the description is a common sign of a copied or fake ad. Ask for the full address and check it on a map.`,
        evidence: snippet(text, near.index, near[0].length),
      });
    }

    // Findings from outside the text, e.g. public property records.
    for (const f of Array.isArray(listing.extraFlags) ? listing.extraFlags : []) {
      if (f && WEIGHTS[f.severity] != null && !flags.some((g) => g.id === f.id)) flags.push(f);
    }

    flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const penalty = flags.reduce((sum, f) => sum + WEIGHTS[f.severity], 0);
    const score = Math.max(0, 100 - penalty);
    // 100-point score -> 5 stars, in half-star steps.
    const stars = Math.round(score / 10) / 2;

    const found = new Set(flags.map((f) => f.id));
    const checks = CHECKS.filter((c) => !c.when || c.when(listing)).map((c) => {
      const hit = c.ids.some((id) => found.has(id));
      return { ok: !hit, label: hit ? c.bad : c.ok };
    });

    return {
      score,
      stars,
      level: levelFor(score, flags.length),
      summary: summaryFor(flags),
      flags,
      checks,
    };
  }

  const DEMO_LISTING = {
    source: 'demo',
    title: '2 Beds 1 Bath House',
    location: '222 2nd Street, Baltimore, MD',
    priceText: '$850 / Month',
    priceAmount: 850,
    pricePeriod: 'month',
    beds: 2,
    description:
      'Cozy two bedroom home available for rent. First person to send the deposit today gets priority. ' +
      'A deposit is required before viewing the property. Contact me only on Telegram. ' +
      'I am currently out of the country. No in-person showings are available.',
  };
  DEMO_LISTING.fullText = DEMO_LISTING.description;

  root.BTD = { analyze, normalize, DEMO_LISTING, RULES };
})(typeof globalThis !== 'undefined' ? globalThis : this);

