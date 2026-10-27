"""Shared helpers for the Weekend Hopper data scripts. Standard library only."""
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
CONTACT = os.environ.get('CONTACT_URL', 'https://github.com/weekend-hopper')
USER_AGENT = f'weekend-hopper/1.0 (+{CONTACT})'


def load(name, default=None):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save(name, obj, compact=False):
    path = os.path.join(DATA, name)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    os.replace(tmp, path)


def get_json(url, params=None, headers=None, timeout=40, retries=2, pause=2.0):
    """GET a JSON document. Returns (status, data or None)."""
    if params:
        url = url + ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
    h = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
    h.update(headers or {})
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            last = e.code
            if e.code == 429:
                time.sleep(30 * (attempt + 1))
                continue
            if e.code in (500, 502, 503, 504):
                time.sleep(pause * (attempt + 1))
                continue
            return e.code, None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as e:
            last = str(e)
            time.sleep(pause * (attempt + 1))
    return last if isinstance(last, int) else 0, None


def km(lat1, lon1, lat2, lon2):
    rad = math.pi / 180
    dlat, dlon = (lat2 - lat1) * rad, (lon2 - lon1) * rad
    s = math.sin(dlat / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(s))


def nearest_hub(cfg, lat, lon):
    """Return the key of the closest hub within its radius, or None."""
    best, best_d = None, None
    for key, h in cfg['hubs'].items():
        d = km(lat, lon, h['lat'], h['lon'])
        if d <= h['radiusKm'] and (best_d is None or d < best_d):
            best, best_d = key, d
    return best


def season_years(today):
    """2026-10-27 -> (2026, '2026-27'). Seasons switch over on 1 July."""
    y = today.year if today.month >= 7 else today.year - 1
    return y, f'{y}-{(y + 1) % 100:02d}'
