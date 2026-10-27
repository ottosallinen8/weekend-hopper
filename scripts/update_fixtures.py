"""Refresh data/fixtures.json and data/venues.json.

Sources, per league in data/config.json:
  * API-Football (all leagues, incl. lower leagues, cups and European games) when the
    API_FOOTBALL_KEY environment variable is set.
  * openfootball (Serie A, Premier League, Championship, Eredivisie) otherwise, or when
    API-Football fails for a league.
If both fail for a league, the previous day's fixtures for that league are kept.
New grounds from API-Football are located with OpenStreetMap Nominatim and cached.
"""
import datetime as dt
import os
import re
import sys
import time
import unicodedata
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import get_json, km, load, nearest_hub, save, season_years  # noqa: E402

AF_BASE = 'https://v3.football.api-sports.io'
OF_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master'
NOMINATIM = 'https://nominatim.openstreetmap.org/search'
MAX_GEOCODES = int(os.environ.get('MAX_GEOCODES', '200'))
TZ_BY_CC = {'it': 'Europe/Rome', 'gb': 'Europe/London', 'nl': 'Europe/Amsterdam'}
CC3 = {'it': 'ITA', 'nl': 'NED', 'be': 'BEL', 'ch': 'SUI', 'de': 'GER', 'fr': 'FRA', 'es': 'ESP', 'pt': 'POR',
       'at': 'AUT', 'dk': 'DEN', 'ie': 'IRL', 'lu': 'LUX'}
UK_NATION = {'England': 'ENG', 'Wales': 'WAL', 'Scotland': 'SCO', 'Northern Ireland': 'NIR', 'Cymru / Wales': 'WAL'}
SKIP_STATUS = {'CANC', 'ABD', 'AWD', 'WO', 'PST'}
DONE_STATUS = {'FT', 'AET', 'PEN'}

geocodes_used = 0


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


# ---------- venues ----------

def country_code(addr, fallback_cc):
    cc = (addr or {}).get('country_code', fallback_cc or '').lower()
    if cc == 'gb':
        return UK_NATION.get((addr or {}).get('state', ''), 'ENG')
    return CC3.get(cc, cc.upper() or '???')


def geocode(name, city, cc):
    global geocodes_used
    queries = [f'{name}, {city}' if city else name, name]
    for q in queries:
        if geocodes_used >= MAX_GEOCODES:
            return None
        geocodes_used += 1
        params = {'q': q, 'format': 'jsonv2', 'limit': 1, 'addressdetails': 1}
        if cc:
            params['countrycodes'] = cc
        status, data = get_json(NOMINATIM, params)
        time.sleep(1.1)  # Nominatim usage policy: max 1 request per second
        if data:
            hit = data[0]
            return float(hit['lat']), float(hit['lon']), hit.get('address', {})
    return None


def resolve_venue(v, lg, cfg, vstore):
    """Map an API-Football venue to a venue key, creating and geocoding it if new."""
    vid = v.get('id')
    name = (v.get('name') or '').strip()
    city = (v.get('city') or '').strip()
    ref = str(vid) if vid else 'n:' + slug(name + '-' + city)
    if not name and not vid:
        return None
    known = vstore['af'].get(ref)
    if known:
        return known
    failed_on = vstore['failed'].get(ref)
    if failed_on and (dt.date.today() - dt.date.fromisoformat(failed_on)).days < 30:
        return None
    hit = geocode(name, city, lg.get('cc'))
    if not hit:
        vstore['failed'][ref] = dt.date.today().isoformat()
        return None
    lat, lon, addr = hit
    for key, g in cfg['grounds'].items():  # same place as a hand-checked ground?
        if km(lat, lon, g['lat'], g['lon']) <= 2.0:
            vstore['af'][ref] = key
            return key
    key = 'af' + str(vid) if vid else ref.replace(':', '-')
    vstore['venues'][key] = {
        'n': name or city, 'c': city, 'lat': round(lat, 5), 'lon': round(lon, 5),
        'cc': country_code(addr, lg.get('cc')), 'r': nearest_hub(cfg, lat, lon), 'rc': None, 'acc': None,
    }
    vstore['af'][ref] = key
    vstore['failed'].pop(ref, None)
    return key


# ---------- API-Football ----------

def fetch_api_football(lg, season, api_key, cfg, vstore, today):
    status, data = get_json(f'{AF_BASE}/fixtures', {'league': lg['af'], 'season': season},
                            headers={'x-apisports-key': api_key}, timeout=60)
    if not data:
        print(f'  API-Football HTTP {status}')
        return None
    errors = data.get('errors')
    if errors:
        print(f'  API-Football error: {errors}')
        return None
    recs, horizon = [], today + dt.timedelta(days=35)
    for item in data.get('response', []):
        fx, teams, goals = item['fixture'], item['teams'], item.get('goals') or {}
        st = (fx.get('status') or {}).get('short', 'NS')
        if st in SKIP_STATUS:
            continue
        venue = resolve_venue(fx.get('venue') or {}, lg, cfg, vstore)
        if not venue:
            continue
        g = vstore['venues'].get(venue) or cfg['grounds'].get(venue)
        tzname = cfg['hubs'][g['r']]['tz'] if g and g.get('r') else TZ_BY_CC.get(lg.get('cc'), 'Europe/Paris')
        when = dt.datetime.fromisoformat(fx['date'].replace('Z', '+00:00')).astimezone(ZoneInfo(tzname))
        date = when.date().isoformat()
        flag = 2 if st == 'TBD' else (1 if when.date() > horizon and st not in DONE_STATUS else 0)
        time_s = '' if st == 'TBD' else when.strftime('%H:%M')
        score = f"{goals.get('home')}-{goals.get('away')}" if st in DONE_STATUS and goals.get('home') is not None else ''
        recs.append([date, time_s, teams['home']['name'], teams['away']['name'], venue, flag, score])
    return recs


# ---------- openfootball ----------

def fetch_openfootball(lg, slabel, cfg, overrides):
    status, data = get_json(f"{OF_BASE}/{slabel}/{lg['of']}.json")
    if not data:
        print(f'  openfootball HTTP {status}')
        return None
    matches = data.get('matches', [])
    fixed_rounds = set()
    for o in overrides:
        if o.get('league') != lg['name']:
            continue
        for m in matches:
            if m['team1'] == o['home'] and m['team2'] == o['away'] and abs(
                    (dt.date.fromisoformat(m['date']) - dt.date.fromisoformat(o['date'])).days) <= 5:
                m['date'], m['time'] = o['date'], o['time']
                fixed_rounds.add(m.get('round'))
    rounds = {}
    for m in matches:
        rounds.setdefault(m.get('round'), []).append(m)
    recs, unknown = [], set()
    for rnd, ms in rounds.items():
        dates = {m['date'] for m in ms}
        times = {m.get('time') for m in ms}
        placeholder = len(dates) == 1 and len(times) == 1 and len(ms) >= 8 and rnd not in fixed_rounds
        for m in ms:
            c1, c2 = cfg['clubs'].get(m['team1']), cfg['clubs'].get(m['team2'])
            if not c1 or not c2:
                unknown.update(t for t in (m['team1'], m['team2']) if t not in cfg['clubs'])
                continue
            flag = 2 if not m.get('time') else (1 if placeholder else 0)
            sc = m.get('score')
            ft = sc.get('ft') if isinstance(sc, dict) else (sc if isinstance(sc, list) and len(sc) == 2 else None)
            recs.append([m['date'], m.get('time') or '', c1['short'], c2['short'], c1['ground'], flag,
                         f'{ft[0]}-{ft[1]}' if ft else ''])
    if unknown:
        print(f'  clubs missing from config.json (skipped): {sorted(unknown)}')
    return recs


# ---------- main ----------

def main():
    cfg = load('config.json')
    overrides = (load('overrides.json', {}) or {}).get('fixes', [])
    vstore = load('venues.json', None) or {}
    vstore.setdefault('venues', {}); vstore.setdefault('af', {}); vstore.setdefault('failed', {})
    for key, g in cfg['grounds'].items():  # hand-checked grounds always win
        vstore['venues'][key] = dict(g, curated=True)
    previous = load('fixtures.json', None) or {}
    prev_by_league = {}
    if previous.get('fix'):
        for row in previous['fix']:
            lname = previous['leagues'][row[4]]
            prev_by_league.setdefault(lname, []).append(
                [row[0], row[1], previous['teams'][row[2]], previous['teams'][row[3]], row[5], row[6], row[7]])

    today = dt.date.today()
    season, slabel = season_years(today)
    api_key = os.environ.get('API_FOOTBALL_KEY', '').strip()
    print(f'Season {slabel}; API-Football {"on" if api_key else "off (no key)"}')

    by_league, sources = {}, {}
    for lg in cfg['leagues']:
        print(lg['name'])
        recs, src = None, None
        if api_key and lg.get('af'):
            recs, src = fetch_api_football(lg, season, api_key, cfg, vstore, today), 'API-Football'
            time.sleep(1)
        if recs is None and lg.get('of'):
            recs, src = fetch_openfootball(lg, slabel, cfg, overrides), 'openfootball'
        if recs is None and prev_by_league.get(lg['name']):
            recs, src = prev_by_league[lg['name']], 'kept from previous run'
        if recs is None:
            print('  no data')
            continue
        by_league[lg['name']], sources[lg['name']] = recs, src
        print(f'  {len(recs)} matches from {src}')

    leagues, teams, tix, rows = [], [], {}, []

    def tid(name):
        if name not in tix:
            tix[name] = len(teams)
            teams.append(name)
        return tix[name]

    for lname, recs in by_league.items():
        li = len(leagues)
        leagues.append(lname)
        for date, t, h, a, venue, flag, score in recs:
            rows.append([date, t, tid(h), tid(a), li, venue, flag, score])
    rows.sort(key=lambda r: (r[0], r[1] or '99', r[4]))

    if not rows:
        print('No fixtures at all; leaving files unchanged.')
        sys.exit(1)
    save('fixtures.json', {
        'updated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'season': slabel,
        'sources': sources, 'leagues': leagues, 'teams': teams, 'fix': rows,
    }, compact=True)
    save('venues.json', vstore)
    print(f'Wrote {len(rows)} fixtures, {len(vstore["venues"])} venues, {geocodes_used} new geocodes.')


if __name__ == '__main__':
    main()
