# BehindTheDoor

TECH 12000 project (Group 5): a Chrome extension that checks a rental listing
for common scam warning signs and gives it a 5-star reliability rating.

It works on any rental website. It has dedicated readers for Facebook
Marketplace and Craigslist. On Zillow, Trulia, HotPads, Apartments.com,
Realtor.com, Redfin, Rent.com, Zumper, PadMapper, Apartment List, RentCafe,
Furnished Finder, SpareRoom, Roomster, Purdue Off-Campus Housing and other
sites, it reads the listing data those sites publish (schema.org/JSON-LD),
then falls back to the page text. You can also paste a listing or a message
from a landlord.

For a building with many units it shows the range: lowest to highest rent,
fewest to most bedrooms, and whether rent is priced per person (common in
student housing). When a listing opens over search results (Zillow), only the
open listing is read. Data a site hides in the page is used only when it
matches what is on screen.

**Facebook posts:** outside Marketplace (a group, a page, your feed), a page
holds many people's posts, so the popup asks you to open one post (click its
time, like "2h"). An opened post, on its own page or in a box over the feed,
is read on its own: its first line as the title, "Rent: $1,000" or the rent
written in the text, its "Location:" line or the town it names, and the author
as the lister. Comments under it are not read.

**Airbnb and Vrbo:** "$524 for 5 nights" is shown as $105 a night and is not
compared with monthly rents. The owner card explains that the address is shown
only after booking, and to pay only inside the site.

**Reviews and site text:** renters' reviews on a listing page are not read
as the listing (a bad review is not a scam sign), and when there is no
description, a listing site's own fee table and links are not warnings.

**Zillow and other building pages:** the units list's base rents win over the
site's hidden total ("$950 – $975", not "$1,764 total"). Plans priced per
bedroom ("Individual Leases", or a 4-bed cheaper than a 3-bed) are marked per
person; a per-person studio or 1-bed is compared with the whole unit.

It also reads a property's own website (for example station21wl.com): the
property's name, the address from the page footer, and the range of its
floor-plan prices. When bigger floor plans cost less than smaller ones, the
prices are per bedroom, and it says so.

## How the report reads

1. **The listing:** name, address, rent, bedrooms, and what is missing.
2. **At a glance:** the star rating, then one line each for warning signs,
   rent, owner and distance to campus. Each line jumps to its details.
3. **Things to check:** each warning with the words that raised it, and the
   full list of what the scam check looked for, passed or found.
4. **Rent and location**, **Who owns it**, **Before you pay or sign**.

The scam check looks for: payment before a tour (including "sign first",
lockbox or door codes sent after paying, keys by mail), payment that is hard
to get back (wire, gift cards, crypto, payment apps, money orders, and fake
"Airbnb/Zillow will hold your deposit" offers), pressure, no tours, requests
for codes, ID, bank details or a Google Form application, contact moved off
the site, copied scam wording, a brand-new seller account, rent far below
the area, and details that do not agree: a title and description that
describe different homes ("Apartment B" vs "single-family home"), wording
copied from a home-for-sale ad ("make this your dream home"), and a "2 blocks
from campus" claim when the site's own map pin is miles away. "Zero application fee" and links to real rental platforms
(TurboTenant, AppFolio, Buildium, ...) are not flagged.

## Rent and location (Lafayette–West Lafayette)

- **Is the rent normal?** The rent is compared with HUD's 2026 Fair Market
  Rents for the Lafayette–West Lafayette area (studio $894, 1 bed $1,032,
  2 bed $1,242, 3 bed $1,489, 4 bed $1,992; rent plus basic utilities). Rooms
  and per-person prices are compared with one person's share. Less than half
  the area's rent raises the "unusually low" warning.
- **How far from campus?** The county parcel's centre point gives the straight
  line distance to Purdue Memorial Union, with rough walking and biking times,
  and a button for bus directions in Google Maps.
- **Around the building** (answered in the popup, no clicking needed):
  - **Nearest CityBus stop**: its name, distance, routes and about how many
    buses stop there each weekday (CityBus's public GTFS data).
  - **Nearest supermarket** and its distance (OpenStreetMap).
  - **Flood map**: whether FEMA maps the building in a high-risk (1% a year)
    or moderate (0.2% a year) flood zone, from the county's copy of FEMA's
    flood map.
  - **Built**: the year and number of units from the county's new-building
    permits (2016 onward), e.g. The Landing, 2019, 114 units.
- **Explore the area:** groceries, bus stops, laundromats and pharmacies
  nearby, Street View, the FEMA flood map, and recent police reports
  (SpotCrime), each opened only when you click it. "Who owns it" adds
  searches for reviews of the building and the owning company (Google, BBB).
- Rent paid weekly or every two weeks is compared as a monthly amount. A
  roommate post is compared with one room's share.
- Without a street address, the distance is measured from the site's own
  approximate map pin and says so.
- **Before you pay or sign:** four steps, a link to find a complex's official
  website, and Purdue's renting guide, Student Legal Services and Off-Campus
  Housing.

The table lives in `src/area.js`; update it each October when HUD publishes
the next year's rents.

## Install (for testing)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open a rental listing and click the BehindTheDoor icon in the toolbar.

## Privacy and security

- Permissions: `activeTab` and `scripting` only. The extension reads a page
  only when you click its icon, and only that tab. It has no access to other
  sites and runs nothing in the background.
- Network requests go only to the county's public parcel service
  (`maps.tippecanoe.in.gov`), and only for Tippecanoe County addresses. The
  listing's street (letters and digits only) is sent to read the owner on
  record (and, if that number is not on record, the site's map pin, to read
  the parcel there), the property type, the date the owner's deed was recorded, and the
  parcel's centre point (for the distance to campus). If the exact address is
  not a parcel of its own, one more request lists the parcels on that street,
  to find the building whose owner carries the listing's name. Two more
  requests go to the same county server: the parcel's centre point, to read
  FEMA's flood zone there, and the parcel's own address, to read its
  new-building permit. Owners' mailing addresses are never requested. The
  Content Security Policy allows no other host.
- The bus stops and supermarkets are a file inside the extension
  (`src/places-data.js`); finding the nearest one sends nothing anywhere.
- "See it on Google Maps", the bus directions, the website search and the
  photo search open Google only when you press them.
- It never looks up contact details or background information about people.
- Page text is shown with `textContent` only, so a listing cannot inject code
  into the popup. A strict Content Security Policy is set in `manifest.json`.

## Public property records

For listings in Tippecanoe County, IN, the popup's "Who owns it" card shows
the owner on record, the county parcel and the property type:

- Apartment complexes often advertise an address the county files as a road
  or common area, or not at all (52 Flats at 3004 Pemberly Dr is filed as
  3073 Pemberly Dr; Cheswick Village at 3422 Cheswick Ct as 3400 Cheswick
  Ct; Station 21 at 2110 McCormick Rd as 2106 McCormick Rd). The extension
  then finds the company-owned parcel on the same street whose owner's name
  contains every distinctive word of the listing's name.
- A person owns the home and someone else posted it: a "check this" warning
  (scammers re-post homes they do not own).
- A company owns it and a person posted it: a note only; the person is
  probably a manager.
- The parcel is still vacant land: a note (normal for brand-new buildings).
- A person's home that changed owners in the last four months, posted by
  someone else: a note (scammers re-post homes that just sold).
- When the advertised number is not on record, the extension also asks for
  the parcel under the map pin the listing site publishes (Apartments.com's
  Alight West Lafayette, "2243 Sagamore Pky W", is filed as 2243 US HWY 52 W,
  owner SCION WL APARTMENTS LLC). A match on the building's name still wins;
  a road or other public parcel under the pin is ignored.
- An address that is not on record, or public land, is explained, not
  flagged: it is too common for real complexes to count as a warning. The
  card then names up to two company-owned apartment buildings on the same
  street, nearest number first, as places to check on the county map (for
  The Pines at 1117 Anthrop Dr: 1105 and 1155 Anthrop Dr).
- A listing with no street number (common on Marketplace) is not looked up;
  the card says to ask for the address and names the street if the text
  mentions one.

To support another county, add an entry to `SOURCES` in `src/records.js` and
its host to `connect-src` in `manifest.json`.

## Updating the data

Each October, update the HUD rents in `src/area.js`. When CityBus changes its
routes (the bundled feed runs to 2027-01-01), rebuild `src/places-data.js`:

```bash
mkdir -p /tmp/btd-data && curl -L -o /tmp/btd-data/citybus.zip https://bus.gocitybus.com/GTFSRT/citybus-lafayette-in-us.zip
python3 -I tools/build_transit.py /tmp/btd-data/citybus.zip > /tmp/btd-data/transit.json
curl -o /tmp/btd-data/groceries.json --data-urlencode 'data=[out:json][timeout:60];(nwr["shop"~"^(supermarket|grocery)$"](40.21,-87.10,40.57,-86.69););out center tags;' https://overpass-api.de/api/interpreter
python3 -I tools/build_places.py /tmp/btd-data/transit.json /tmp/btd-data/groceries.json src/places-data.js
```

## Speed

The reader reads each part of the page's text once (the browser has to lay
the page out for every read), and works out the whole page's text only when a
step needs it. On a page with 500 search results around the listing it takes
about 9-28 ms, down from 14-37 ms. `tests/bench.html` measures it.

## What it does not check

Property records and area rents outside Lafayette–West Lafayette, listing
photos (use the photo search button), other ads by the same person, and text
that is not in English. A good rating is not proof a listing is real.

## Files

| | |
|---|---|
| `manifest.json` | the extension's settings and permissions |
| `popup.html`, `popup.js`, `styles.css` | the popup |
| `src/extractor.js` | reads the listing from the page |
| `src/analyzer.js` | the warning-sign rules and the score |
| `src/records.js` | public property-records lookup and owner comparison |
| `src/area.js` | area rents (HUD), distance to campus, nearest bus stop and supermarket, renter help links |
| `src/places-data.js` | CityBus stops and supermarkets (generated by `tools/`) |
| `tools/` | scripts that rebuild `src/places-data.js` from public data |
| `icons/` | toolbar and store icons |
| `tests/` | offline tests, test pages (`fixtures/`, made-up content) and the preview, timing and live-check pages |
| `CHANGELOG.md` | what changed in each version |

## Tests

Before every push, run all four:

```bash
node --test tests/*.test.js
```

For the extractor, serve this folder and open the test page:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then visit http://127.0.0.1:8765/tests/extractor.html. The tab title reads
PASS or FAIL. To see the real popup for every test page (with live county
records), visit http://127.0.0.1:8765/tests/popup-preview.html; every frame
should show a report except the two "open one listing/post" pages. For speed,
http://127.0.0.1:8765/tests/bench.html times the reader on large pages.

To check real listings, save a few pages into `tests/live-snapshots/` (git
ignores that folder: they are other people's listings), list them in
`tests/live-snapshots/index.json` as `[["page.html", "www.craigslist.org"]]`,
and open http://127.0.0.1:8765/tests/live-check.html.
