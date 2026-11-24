# Changelog

## 1.9.0 (2026-11-18)

- New warnings when a listing's details do not agree: the site's map pin is
  miles from the "2 blocks from campus" it claims, the title and description
  describe different homes, or the text is copied from a home-for-sale ad.
- Facebook: a post opened in a box over the feed or a page is read on its own
  ("Location:" and "Rent:" lines, the author as lister); shared Marketplace
  links (`/commerce/listing/`) are read as listings.
- Outside Tippecanoe County the owner card says the lookup does not cover it,
  instead of asking for a street address.
- A street with no house number ("Covington St") is named when the card asks
  for the full address.
- Review fixes: a parcel found only under the map pin is never held against
  the lister; "stops on campus" no longer counts as a claim to be near campus;
  the checklist only lists the map check when there was a map pin; a single
  home's bedroom count is not lowered by stray labels; a landlord's own
  website keeps the fee and link checks.

## 1.8.1 (2026-11-17)

- Renters' reviews are not read as the listing; a listing site's own fee table
  is not a warning; "About <building>" is the description (Apartments.com).
- Per-bed buildings compare the lowest price with a share of the largest unit.
- When the address is not on record, the parcel under the site's map pin is
  looked up (Alight West Lafayette -> 2243 US HWY 52 W, SCION WL APARTMENTS LLC).
- Zillow: a header block with no price no longer hides the units list.

## 1.8.0 (2026-11-17)

- Reads pages up to about 40% faster on large pages.
- Nearest CityBus stop (routes, weekday buses) and supermarket, bundled from
  public data; FEMA flood zone and year built from county records.

## 1.7.0 (2026-11-16)

- Zillow per-person prices and unit tables, Facebook group feeds and posts,
  property-site slogans and "$1,490 to $1,575" prices, Airbnb nightly prices,
  nearby apartment buildings when an address is not on record.

## 1.6.0 (2026-11-16)

- "At a glance" summary, the full scam checklist, area links (groceries,
  bus stops, flood map, police reports, reviews), fixes from real Craigslist
  listings (biweekly rent, roommate posts, street in the title).

## 1.5.0 (2026-11-16)

- Rent compared with HUD 2026 rents, distance to campus, owner since, and a
  "Before you pay or sign" card with Purdue renter help.

## 1.4.x (2026-11-16)

- Reads the open listing on Zillow and Apartments.com, rent and bed ranges,
  per-person prices, property websites, and finds complexes' real owners.

## 1.3.0 (2026-11-16)

- Owner on record from Tippecanoe County parcel records.
