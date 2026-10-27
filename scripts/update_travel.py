"""Refresh data/travel.json with real public transport journey times from Transitous.

Transitous (https://transitous.org) is a free, community-run journey planner for Europe built on
MOTIS. For every base city in config.json it stores:
  * city -> ground: fastest journey leaving the city's main station on a Saturday morning, for
    every ground within the city's reach
  * night return: whether a journey back leaves the ground after 22:30 and arrives by 03:00
  * ground <-> ground (within 160 km): fastest journey on a Saturday afternoon, for same-day doubles
Station coordinates are checked once against OpenStreetMap. Results are cached and refreshed after
REFRESH_DAYS. Each run makes at most MAX_CALLS requests, shortest trips first, so a big backlog is
filled over a few nights.
"""
import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import get_json, km, load, save  # noqa: E402

BASE = os.environ.get('TRANSITOUS_URL', 'https://api.transitous.org')
NOMINATIM = os.environ.get('NOMINATIM_URL', 'https://nominatim.openstreetmap.org/search')
VERSIONS = ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']
REFRESH_DAYS = int(os.environ.get('REFRESH_DAYS', '21'))
MAX_CALLS = int(os.environ.get('MAX_CALLS', '1200'))
MAX_EST_MIN = 240      # skip city -> ground trips estimated longer than this
NIGHT_MAX_MIN = 180    # only check late trains for trips up to this long
PAIR_KM = 160
UTC = dt.timezone.utc
CC2 = {'ITA': 'it', 'ENG': 'gb', 'WAL': 'gb', 'SCO': 'gb', 'NED': 'nl'}

calls = 0
api_path = None


def plan(frm, to, local_start, tz, window_s):
    """Return a list of (start_local, end_local, minutes) itineraries, [] if none, None on error."""
    global calls, api_path
    if calls >= MAX_CALLS:
        return None
    t = local_start.replace(tzinfo=ZoneInfo(tz)).astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    params = {
        'fromPlace': f'{frm[0]},{frm[1]}', 'toPlace': f'{to[0]},{to[1]}', 'time': t,
        'searchWindow': window_s, 'maxPreTransitTime': 1800, 'maxPostTransitTime': 1800,
        'detailedTransfers': 'false',
    }
    for v in ([api_path] if api_path else VERSIONS):
        calls += 1
        status, data = get_json(f'{BASE}/api/{v}/plan', params, timeout=60, retries=1)
        time.sleep(1.0)  # be gentle with a free community service
        if status == 404 and not api_path:
            continue
        if data is None:
            print(f'    HTTP {status}')
            return None
        api_path = v
        out = []
        for it in data.get('itineraries', []):
            try:
                s = dt.datetime.fromisoformat(it['startTime'].replace('Z', '+00:00')).astimezone(ZoneInfo(tz))
                e = dt.datetime.fromisoformat(it['endTime'].replace('Z', '+00:00')).astimezone(ZoneInfo(tz))
                out.append((s, e, round(it['duration'] / 60)))
            except (KeyError, ValueError, TypeError):
                continue
        return out
    return None


def estimate(cfg, cc, dist_km):
    a, b, p = cfg['estimate'].get(cc, cfg['estimate']['ENG'])
    return a + b * dist_km ** p


def next_saturday(today):
    d = today + dt.timedelta(days=3)
    return d + dt.timedelta(days=(5 - d.weekday()) % 7)


def stale(entry, today, night=False):
    if not entry or 't' not in entry:
        return True
    if night and entry.get('m') and entry['m'] <= NIGHT_MAX_MIN and 'n' not in entry:  # late check failed last time
        return True
    return (today - dt.date.fromisoformat(entry['t'])).days >= REFRESH_DAYS


def station_points(cfg, travel):
    """Main-station coordinates per city, checked once against OpenStreetMap."""
    geo = travel.setdefault('hubgeo', {})
    for key, h in cfg['hubs'].items():
        if key in geo:
            continue
        params = {'q': f"{h['station']} railway station", 'format': 'jsonv2', 'limit': 1}
        if CC2.get(h['cc']):
            params['countrycodes'] = CC2[h['cc']]
        status, data = get_json(NOMINATIM, params)
        time.sleep(1.1)  # Nominatim usage policy: max 1 request per second
        if data:
            lat, lon = float(data[0]['lat']), float(data[0]['lon'])
            d = km(lat, lon, h['lat'], h['lon'])
            if d <= 3:
                geo[key] = {'lat': round(lat, 5), 'lon': round(lon, 5), 'ok': True}
                continue
            print(f'  {h["station"]}: OpenStreetMap result is {d:.1f} km from config; keeping config coordinates')
        geo[key] = {'lat': h['lat'], 'lon': h['lon'], 'ok': False}
    return {k: (v['lat'], v['lon']) for k, v in geo.items() if k in cfg['hubs']}


def main():
    cfg = load('config.json')
    venues = (load('venues.json', {}) or {}).get('venues', {})
    for k, g in cfg['grounds'].items():
        venues[k] = g
    fx = load('fixtures.json', {}) or {}
    travel = load('travel.json', None) or {}
    travel.setdefault('hub', {}); travel.setdefault('gg', {})
    today = dt.date.today()
    sat = next_saturday(today)
    horizon = (today + dt.timedelta(days=150)).isoformat()
    points = station_points(cfg, travel)

    upcoming = {r[5] for r in fx.get('fix', []) if today.isoformat() <= r[0] <= horizon}
    needed = sorted(k for k, g in venues.items() if g.get('lat') is not None and (k in upcoming or k in cfg['grounds']))

    # Work list of city -> ground trips, shortest first
    jobs = []
    for hk, h in cfg['hubs'].items():
        store = travel['hub'].setdefault(hk, {})
        for gk in needed:
            g = venues[gk]
            d = km(h['lat'], h['lon'], g['lat'], g['lon'])
            if d > h['radiusKm']:
                continue
            est = estimate(cfg, h['cc'], d)
            if est > MAX_EST_MIN or not stale(store.get(gk), today, night=True):
                continue
            jobs.append((est, hk, gk))
    jobs.sort()
    print(f'{len(cfg["hubs"])} cities, {len(needed)} grounds, {len(jobs)} city-to-ground trips to fetch; '
          f'journeys planned for Saturday {sat}')

    done = 0
    for est, hk, gk in jobs:
        if calls >= MAX_CALLS:
            break
        h, g = cfg['hubs'][hk], venues[gk]
        hub_pt, gpt, tz = points[hk], (g['lat'], g['lon']), h['tz']
        out = plan(hub_pt, gpt, dt.datetime.combine(sat, dt.time(9, 0)), tz, 3 * 3600)
        if out is None:
            continue
        entry = {'t': today.isoformat()}
        if out:
            entry['m'] = min(o[2] for o in out)
        if entry.get('m') and entry['m'] <= NIGHT_MAX_MIN:
            back = plan(gpt, hub_pt, dt.datetime.combine(sat, dt.time(22, 30)), tz, 3 * 3600)
            if back is not None:
                limit = dt.datetime.combine(sat + dt.timedelta(days=1), dt.time(3, 0)).replace(tzinfo=ZoneInfo(tz))
                ok = [b for b in back if b[1] <= limit]
                entry['n'] = bool(ok)
                if ok:
                    entry['nm'] = min(b[2] for b in ok)
                    entry['last'] = max(b[0] for b in ok).strftime('%H:%M')
        travel['hub'][hk][gk] = entry
        done += 1
    print(f'  fetched {done} city-to-ground trips')

    # Ground <-> ground for same-day doubles, closest first
    pairs = []
    for i, a in enumerate(needed):
        for b in needed[i + 1:]:
            ga, gb = venues[a], venues[b]
            d = km(ga['lat'], ga['lon'], gb['lat'], gb['lon'])
            if d <= PAIR_KM and stale(travel['gg'].get(f'{a}|{b}'), today):
                pairs.append((d, a, b))
    pairs.sort()
    got = 0
    for d, a, b in pairs:
        if calls >= MAX_CALLS:
            break
        ga, gb = venues[a], venues[b]
        tz = 'Europe/London' if ga.get('cc') in ('ENG', 'WAL', 'SCO') else ('Europe/Rome' if ga.get('cc') == 'ITA' else 'Europe/Amsterdam')
        out = plan((ga['lat'], ga['lon']), (gb['lat'], gb['lon']), dt.datetime.combine(sat, dt.time(14, 30)), tz, 3 * 3600)
        if out is None:
            continue
        travel['gg'][f'{a}|{b}'] = {'t': today.isoformat(), **({'m': min(o[2] for o in out)} if out else {})}
        got += 1
    print(f'  fetched {got} of {len(pairs)} ground-to-ground trips')

    travel['updated'] = dt.datetime.now(UTC).strftime('%Y-%m-%dT%H:%MZ')
    travel['source'] = 'Transitous' + (f' /api/{api_path}' if api_path else '')
    save('travel.json', travel)
    hubs_n = sum(1 for v in travel['hub'].values() for e in v.values() if e.get('m'))
    print(f'{calls} requests made. {hubs_n} city-to-ground and '
          f'{sum(1 for e in travel["gg"].values() if e.get("m"))} ground-to-ground journey times stored.')
    if calls >= MAX_CALLS:
        print('Request limit reached; the rest will be filled in on the next run.')


if __name__ == '__main__':
    main()
