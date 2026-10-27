"""Refresh data/travel.json with real public transport journey times from Transitous.

Transitous (https://transitous.org) is a free, community-run journey planner for Europe built on
MOTIS. For every base city it stores:
  * hub -> ground: fastest journey leaving the base city's main station on a Saturday morning
  * night return: whether a journey back to the base city leaves the ground after 22:30 and
    arrives by 03:00
  * ground <-> ground (within 160 km, same base city): fastest journey on a Saturday afternoon,
    used for same-day doubles
Results are cached and refreshed after REFRESH_DAYS, so daily runs only make a few requests.
"""
import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import get_json, km, load, save  # noqa: E402

BASE = os.environ.get('TRANSITOUS_URL', 'https://api.transitous.org')
VERSIONS = ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']
REFRESH_DAYS = int(os.environ.get('REFRESH_DAYS', '21'))
MAX_CALLS = int(os.environ.get('MAX_CALLS', '900'))
PAIR_KM = 160
UTC = dt.timezone.utc

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
    versions = [api_path] if api_path else VERSIONS
    for v in versions:
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


def next_saturday(today):
    d = today + dt.timedelta(days=3)
    return d + dt.timedelta(days=(5 - d.weekday()) % 7)


def stale(entry, today):
    if not entry or 't' not in entry:
        return True
    if 'm' in entry and 'n' not in entry:  # the late-return check failed last time; try again
        return True
    return (today - dt.date.fromisoformat(entry['t'])).days >= REFRESH_DAYS


def main():
    cfg = load('config.json')
    venues = (load('venues.json', {}) or {}).get('venues', {})
    for k, g in cfg['grounds'].items():
        venues.setdefault(k, g)
    fx = load('fixtures.json', {}) or {}
    travel = load('travel.json', None) or {}
    travel.setdefault('hub', {}); travel.setdefault('gg', {})
    today = dt.date.today()
    sat = next_saturday(today)
    horizon = (today + dt.timedelta(days=150)).isoformat()

    # Grounds that have a match coming up (plus every hand-checked ground)
    upcoming = {r[5] for r in fx.get('fix', []) if today.isoformat() <= r[0] <= horizon}
    needed = {k for k, g in venues.items() if g.get('r') and (k in upcoming or k in cfg['grounds'])}
    print(f'{len(needed)} grounds to cover; journeys planned for Saturday {sat}')

    # 1) base city -> ground, and the late trip back
    for hub_key, hub in cfg['hubs'].items():
        hub_pt, tz = (hub['lat'], hub['lon']), hub['tz']
        store = travel['hub'].setdefault(hub_key, {})
        for gk in sorted(k for k in needed if venues[k]['r'] == hub_key):
            if not stale(store.get(gk), today):
                continue
            g = venues[gk]
            out = plan(hub_pt, (g['lat'], g['lon']), dt.datetime.combine(sat, dt.time(9, 0)), tz, 3 * 3600)
            if out is None:
                if calls >= MAX_CALLS:
                    break
                continue
            back = plan((g['lat'], g['lon']), hub_pt, dt.datetime.combine(sat, dt.time(22, 30)), tz, 3 * 3600)
            entry = {'t': today.isoformat()}
            if out:
                entry['m'] = min(o[2] for o in out)
            if back is not None:
                limit = dt.datetime.combine(sat + dt.timedelta(days=1), dt.time(3, 0)).replace(tzinfo=ZoneInfo(tz))
                ok = [b for b in back if b[1] <= limit]
                entry['n'] = bool(ok)
                if ok:
                    entry['nm'] = min(b[2] for b in ok)
                    entry['last'] = max(b[0] for b in ok).strftime('%H:%M')
            store[gk] = entry
            print(f'  {hub_key} -> {gk}: {entry}')

    # 2) ground <-> ground for same-day doubles
    for hub_key, hub in cfg['hubs'].items():
        keys = sorted(k for k in needed if venues[k]['r'] == hub_key)
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                ga, gb = venues[a], venues[b]
                if km(ga['lat'], ga['lon'], gb['lat'], gb['lon']) > PAIR_KM:
                    continue
                pk = f'{a}|{b}'
                if not stale(travel['gg'].get(pk), today):
                    continue
                out = plan((ga['lat'], ga['lon']), (gb['lat'], gb['lon']),
                           dt.datetime.combine(sat, dt.time(14, 30)), hub['tz'], 3 * 3600)
                if out is None:
                    if calls >= MAX_CALLS:
                        break
                    continue
                travel['gg'][pk] = {'t': today.isoformat(), **({'m': min(o[2] for o in out)} if out else {})}
            if calls >= MAX_CALLS:
                break

    travel['updated'] = dt.datetime.now(UTC).strftime('%Y-%m-%dT%H:%MZ')
    travel['source'] = 'Transitous' + (f' /api/{api_path}' if api_path else '')
    save('travel.json', travel)
    hubs_n = sum(len(v) for v in travel['hub'].values())
    print(f'{calls} requests made. Stored {hubs_n} city-to-ground and {len(travel["gg"])} ground-to-ground journeys.')
    if calls >= MAX_CALLS:
        print('Request limit reached; the rest will be filled in on the next run.')


if __name__ == '__main__':
    main()
