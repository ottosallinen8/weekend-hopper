# weekend-hopper

Testing app for tracking football games.

Weekend Hopper plans a football weekend from **Milan, Manchester or Amsterdam**: pick your travel dates and it suggests the best one to three real matches nearby, in an order that works, with public transport times. Pin every game you go to on a globe and collect grounds, teams and countries.

The site is a plain static page (`index.html` + `app.js`) served by GitHub Pages. A GitHub Actions job refreshes the data every night.

## How the data works

| File | What it holds | Updated by |
|---|---|---|
| `data/config.json` | Base cities, hand-checked grounds, club → ground map, leagues to fetch, typical train times used as a fallback | Hand-edited |
| `data/overrides.json` | Manual kickoff fixes for when the free fixture feed lags | Hand-edited |
| `data/fixtures.json` | Every match this season: date, local kickoff, teams, league, ground, score | `scripts/update_fixtures.py` |
| `data/venues.json` | All grounds with coordinates, including new ones found via the fixture API | `scripts/update_fixtures.py` |
| `data/travel.json` | Real journey times from [Transitous](https://transitous.org) | `scripts/update_travel.py` |
| `data/world*.json` | Map shapes for the globe ([world-atlas](https://github.com/topojson/world-atlas)) | Static |

**Fixtures.** Without an API key, the job uses [openfootball](https://github.com/openfootball/football.json) for Serie A, Premier League, Championship and Eredivisie. With an `API_FOOTBALL_KEY` secret it uses [API-Football](https://www.api-football.com) for every league listed in `config.json` (incl. Serie B, League One/Two, National League, Eerste Divisie, cups and European games), about 16 requests per night. New grounds are located once with OpenStreetMap Nominatim and cached.

**Travel times.** For each base city the job asks Transitous for the fastest Saturday-morning journey to each ground, whether there is a train back after a late kickoff, and ground-to-ground times for same-day doubles. Results are cached for three weeks, so a normal night makes only a handful of requests. When no real time exists yet the site shows an estimate and labels it.

## Setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Optional: **Settings → Secrets and variables → Actions → New repository secret** named `API_FOOTBALL_KEY`.
3. **Actions → Update data and deploy site → Run workflow** for the first run (it also runs nightly at 04:17 UTC).

Run locally: `python scripts/update_fixtures.py && python scripts/update_travel.py`, then `python -m http.server` and open http://localhost:8000.

## Each new season

Promoted clubs need a line in `config.json` → `clubs` (openfootball name → short name and ground). The fixture job prints any missing clubs in its log. With API-Football this is not needed, since grounds come from the API.
