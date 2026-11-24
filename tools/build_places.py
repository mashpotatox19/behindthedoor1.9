import json, re, sys
transit = json.load(open(sys.argv[1]))
osm = json.load(open(sys.argv[2]))
stops = []
for name, lat, lon, routes, trips in transit['stops']:
    name = re.sub(r'\s*:\s*(BUS)?\d+[A-Z]{0,2}\s*$', '', name).strip()
    stops.append([name, lat, lon, routes, trips])
groceries = []
for e in osm['elements']:
    t = e.get('tags', {})
    if t.get('shop') not in ('supermarket', 'grocery') or not t.get('name'):
        continue
    lat = e.get('lat', e.get('center', {}).get('lat'))
    lon = e.get('lon', e.get('center', {}).get('lon'))
    if lat is None:
        continue
    groceries.append([t['name'].strip(), round(lat, 5), round(lon, 5)])
groceries.sort()
data = {
    'transit': {'source': 'CityBus of Greater Lafayette (GTFS ' + transit['meta']['version'] + ', service ' + transit['meta']['from'] + ' to ' + transit['meta']['to'] + ')', 'url': transit['meta']['url'], 'stops': stops},
    'groceries': {'source': 'OpenStreetMap contributors (ODbL), supermarkets in Tippecanoe County, 2026-11-17', 'url': 'https://www.openstreetmap.org/copyright', 'places': groceries},
}
js = ('/*\n * BehindTheDoor - places near a listing, for Lafayette-West Lafayette.\n'
      ' * Built by tools/build_transit.py and tools/build_places.py from public data\n * (see README, "Updating the data"); do not edit by hand.\n'
      ' *  - CityBus stops: name, latitude, longitude, routes, weekday departures.\n'
      ' *  - Supermarkets: name, latitude, longitude. (c) OpenStreetMap contributors, ODbL.\n */\n'
      '(function (root) {\n  \'use strict\';\n  root.BTD_PLACES = ' + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';\n'
      '})(typeof globalThis !== \'undefined\' ? globalThis : this);\n')
open(sys.argv[3], 'w').write(js)
print(len(stops), 'stops,', len(groceries), 'groceries,', len(js), 'bytes')
