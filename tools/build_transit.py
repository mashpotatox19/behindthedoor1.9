import csv, io, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding='utf-8-sig'))
feed = next(rd('feed_info.txt'))
weekday = {r['service_id'] for r in rd('calendar.txt') if r['monday'] == '1' and r['friday'] == '1'}
routes = {r['route_id']: (r['route_short_name'] or r['route_long_name']).strip() for r in rd('routes.txt')}
trips = {r['trip_id']: (r['route_id'], r['service_id']) for r in rd('trips.txt')}
by_stop = {}
for r in rd('stop_times.txt'):
    t = trips.get(r['trip_id'])
    if not t:
        continue
    s = by_stop.setdefault(r['stop_id'], [set(), 0])
    s[0].add(routes.get(t[0], '?'))
    if t[1] in weekday:
        s[1] += 1
out = []
for r in rd('stops.txt'):
    s = by_stop.get(r['stop_id'])
    if not s or r.get('location_type', '0') not in ('', '0'):
        continue
    key = lambda x: (len(x), x)
    out.append([r['stop_name'].strip(), round(float(r['stop_lat']), 5), round(float(r['stop_lon']), 5), ' '.join(sorted(s[0], key=key)), s[1]])
out.sort(key=lambda x: (x[1], x[2]))
meta = {'source': 'CityBus of Greater Lafayette GTFS', 'url': 'https://www.in.gov/citybuslafayette/about/gtfsgis-data-download/', 'version': feed['feed_version'], 'from': feed['feed_start_date'], 'to': feed['feed_end_date']}
print(json.dumps(meta), len(out), file=sys.stderr)
print(json.dumps({'meta': meta, 'stops': out}, separators=(',', ':')))
