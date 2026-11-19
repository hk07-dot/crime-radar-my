# Crime Radar MY

A map of crime reports within 10 km of the user, for Malaysia. It combines three sources:

| Source | What it gives | Precision | Freshness |
|---|---|---|---|
| **Official** – PDRM statistics via data.gov.my (`crime_district`, CC BY 4.0) | Crime counts by police district and crime type | Police district (IPD) | Annual; latest year is 2023 |
| **News** – outlet RSS feeds (verified on your machine by `npm run check-feeds`) plus four Google News searches in Malay and English, scoped to Malaysia | Individual incidents in headlines, de-duplicated across outlets | Town / taman level | Every 30 min |
| **Social** – Bluesky post search, Mastodon hashtags, and Reddit if you have an approved app (see below) | Individual posts, marked *unverified* | Town / taman level | Every 30 min |

Malaysia has no public, street-level crime feed. The official dataset is the only one from PDRM, and it is annual and per district. It also counts crimes where a conviction was secured, not every police report. Recent, point-level items come only from news and social media, so treat them as indicators, not records.

## Run it

Needs Node 18 or newer. There are no dependencies to install.

```bash
GEOCODER_UA="CrimeRadarMY/0.1 (you@example.com)" npm start
# open http://localhost:3000
```

On first start the server downloads the official CSV (cached for 24 h in `data/`), then runs the news and social ingest and repeats it every 30 minutes. The first ingest takes a few minutes because geocoding is limited to one request per second.

### Choose news feeds

```bash
npm run check-feeds
```

This reads outlet pages (The Star, NST, Berita Harian, Harian Metro, Sinar Harian, Kosmo, Utusan, Astro Awani, The Sun, Buletin TV3) for the RSS links they advertise, tests those plus a list of known feed paths, and saves the ones that returned items from the last 7 days to `data/feeds.json`. It prints a table with item counts and how many items look crime-related. Restart the server afterwards. Run it again whenever a feed starts failing in the log. Without `data/feeds.json` the server uses five default feeds.

Google News searches run on every pull regardless, and usually give the most local crime stories. Google offers these feeds for personal, non-commercial use, so for a public or commercial site, replace them with a licensed news API or direct outlet agreements. Set `GOOGLE_NEWS=off` to turn them off.

Browser location only works on `localhost` or over HTTPS. If the user declines, the map falls back to Kuala Lumpur, and they can tap the map to check any area.

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GEOCODER_UA` | – | **Set this.** Nominatim requires a User-Agent with contact details |
| `INGEST_INTERVAL_MIN` | `30` | Minutes between news and social pulls |
| `INGEST` | on | Set to `off` to serve without pulling |
| `CRIME_CSV_URL` | data.gov.my URL | Override the official data source |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | – | Turns on the Reddit source (script-type app, OAuth client credentials) |
| `ARTICLE_LEADS` | on | Set to `off` to stop reading article openings for places |
| `GOOGLE_NEWS` | on | Set to `off` to skip the Google News searches |
| `DEBUG_INGEST` | – | Set to `1` to log each crime headline and whether its place was found |

### Reading the ingest log

```
[ingest] 273 items (269 new) → 72 about crime (20 abroad, 40 articles read for a place) → 30 name a place → 22 added
```

Each arrow is a filter: new items, then ones about a crime (minus stories set abroad), then ones with a place name (from the headline or the article's opening line), then ones the geocoder placed. Zero at a step tells you where to look. Run with `DEBUG_INGEST=1` to see which headlines dropped out.

## Route check

Open **Check a route** in the side panel, pick a start (or **My location**) and a destination from the suggestions, choose drive, walk or cycle, and press **Check route**. `GET /api/route?from=lat,lng&to=lat,lng&mode=car|foot|bike&since=ISO&until=ISO` does the work (`lib/route.js`):

- **Routing** comes from the OSRM servers FOSSGIS runs for OpenStreetMap (`routing.openstreetmap.de`), free for light use. Set `ROUTER_URL` to your own OSRM server for heavier use. Routes are cached for an hour.
- **Density along the route:** the line is sampled every 200 m against the red density surface and drawn in stretches of the same colour. The panel says how much of the trip runs through high or very high density and on which roads.
- **Crime on the roads used:** news and social reports in the selected date range, within 400 m of the route when driving (300 m cycling, 250 m walking), are listed under the road they're nearest to and ringed on the map. Town-level pins mark a town centre rather than a scene, so they're counted but not listed by road.
- Trips over 400 km are refused, to stay within the free router's fair use.

## Hosting on GitHub (no server)

The same code runs as a static site on GitHub Pages:

- **GitHub Actions** (`.github/workflows/update.yml`) runs every 30 minutes: it collects news and social reports with the same code as the server (`scripts/update.js`), saves the state back to `data/`, rebuilds the site into `docs/` (`scripts/build-static.js`) and publishes it.
- **The page** is `public/index.html` plus `docs/js/static-api.js`, which answers the page's `/api/…` calls in the browser from `docs/data/*.json`. The density shading and route analysis run the server's own `lib/heat.js` and `lib/route.js`, bundled into `docs/js/core.js` at build time. Place search and routing call the free OpenStreetMap services (Nominatim, FOSSGIS OSRM) straight from the browser.

Setup, once:
1. Create a **public** repository and upload the whole project folder, including `.github` and `data`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions tab → "Update and publish" → Run workflow.** The site appears at `https://<your-username>.github.io/<repository>/`.
4. Optional, under **Settings → Secrets and variables → Actions**: a variable `GEOCODER_UA` with your contact email, and secrets `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` for Bluesky posts.

Notes:
- The repository and the collected data are public.
- Scheduled runs can start late when GitHub is busy, and GitHub may pause schedules in public repositories after 60 days without activity; the workflow's own data commits normally keep it active. Re-enable it on the Actions tab if it stops.
- GitHub's shared IP addresses may be rate-limited by the geocoder or news sites more often than a home connection. The saved place lookups in `data/geocode-cache.json` reduce this.
- The free OpenStreetMap map, search and routing services are for light use, which suits a personal or small public site.
- To check the static build locally: `npm run build`, then serve the `docs` folder with any static file server.

## Date range

News and social reports cover the **last two months**, counted from the device's own date and time zone. On 11 Nov that's 11 Sep to 11 Nov; if the day doesn't exist two months back (30 Apr → 30 Feb), it uses the last day of that month.

- **On the map:** the page works out the range from the viewing device's clock and sends it to the server, so a phone or laptop opening the page uses its own date. The range is shown under the time selector (7 days, 30 days or 2 months).
- **When collecting:** the server uses its computer's date to decide what to fetch and keep. Items older than two months are dropped from `data/incidents.json`.
- **Backfill:** on first start, the server fills the two months by searching Google News one week at a time, two weeks per run. Each run handles at most `MAX_PER_RUN` new items (default 250); the rest wait in `data/queue.json` for the next run. To load everything in one go, stop the server and run `npm run backfill`, then `npm start`. Progress is kept in `data/backfill.json`; delete it to backfill again. `BACKFILL=off` skips it.

## Local news outlets

Besides the national outlets, `npm run check-feeds` now tests local and regional ones: Borneo Post, Utusan Borneo, New Sarawak Tribune, Dayak Daily, Utusan Sarawak, Daily Express (Sabah), Buletin Mutiara (Penang), Selangor Journal, Selangorkini, Johor Buzz, plus Sinar Harian and Harian Metro local sections. It keeps the ones that work from your machine.

Google News also runs one Malay search per state (Selangor, Johor, Sabah, Sarawak… 15 in all), which reaches local outlets and state pages without a feed of their own. Posts that outlets make only on Facebook, Instagram or TikTok can't be read; see Social media below.

## Social media

`ingest/social.js` searches social media for posts about crimes in Malaysia, in Malay and English. Run `npm run check-social` to see what each source returns from your machine.

| Source | Setup | Notes |
|---|---|---|
| Bluesky | Works without an account when Bluesky allows it. If the log says it needs an account, create an app password (Settings → Privacy and security → App passwords) and set `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`. | The most useful free source. |
| Mastodon | None. Reads public hashtag timelines (#jenayah, #ragut, #kualalumpur…) on `mastodon.social`. Set `MASTODON_INSTANCES` to add instances. | Low volume in Malaysia. |
| Reddit | Needs `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` from an approved Reddit app. | Logged-out access is blocked, and Reddit is ending RSS feeds (13 Nov 2026) and closing its public API. |

X, Facebook, Instagram, TikTok and Threads have no free search access and don't allow scraping, so they aren't included. Malaysian community Facebook groups, where many local reports are posted, are out of reach without a partnership.

How posts become pins:
- The post must mention a crime and read as a report of something that happened ("kena ragut kat cheras tadi"). Questions, advice and jokes are skipped.
- It must name a Malaysian place. Casual forms like "kat", "area" and lowercase town names are recognised. Stories set abroad are skipped.
- Posts are stored with their text, time and link only. Usernames aren't stored, and phone numbers, car plates and @handles are masked, since posts often accuse people who can't respond.
- Social pins are marked unverified on the map and merge with news pins about the same incident.
- `BLUESKY=off` or `MASTODON=off` turns a source off.

## Crime density shading

The red overlay is drawn from the official district totals (`lib/heat.js`, served at `GET /api/heat?lat=..&lng=..`):

- Each police district's annual case count is spread around its HQ with a Gaussian. Its width is 0.6× the distance to the nearest neighbouring HQ, between 1.5 and 12 km, so dense city districts stay tight and rural ones spread wide. The result is cases per km² per year on a 0.5 km grid.
- Levels are national. Sorting all of populated Malaysia (2 km cells within 15 km of an HQ) from densest down, **very high** is the densest ground that together holds 10% of all cases, **high** 25%, **elevated** 50% and **moderate** 75%. The rest is unshaded. Ranking by share of cases rather than share of land keeps whole cities from turning uniformly dark red.
- It shows case counts, not crime per person, so busy commercial centres score high partly because more people pass through them. It can't separate streets or tamans within a district. News and social pins aren't part of the shading, since a handful of reports would distort annual figures.

To make it a true per-capita rate, divide by population. DOSM publishes population by administrative district on data.gov.my, but police districts don't line up with administrative ones, so this needs a mapping table first.

## API

```
GET /api/official?lat=3.1478&lng=101.6953&radius=10
GET /api/incidents?lat=3.1478&lng=101.6953&radius=10&from=2026-09-11T00:00:00%2B08:00&to=2026-11-11T23:59:59%2B08:00
GET /api/heat?lat=3.1478&lng=101.6953
GET /api/search?q=taman%20melawati
GET /api/route?from=3.1478,101.6953&to=3.0738,101.5183&mode=car
```

The search box at the top right of the map takes a town, taman, road, landmark or coordinates (`3.15, 101.70`). Police district towns match instantly from the built-in table; everything else goes through the geocoder at one lookup per second, cached for an hour.

They reject points outside Malaysia, and `radius` is capped at 50 km. Without `from` and `to`, incidents default to the last two months by the server's date.

## How it works

- `lib/official.js` – downloads and parses the CSV, sums the latest year per district (skipping `all` subtotal rows), and places each district at its IPD location from `data/police-districts.json`. Districts not in that table are geocoded once and cached. **Check any geocoded districts and add them to the table if they land in the wrong place.**
- `ingest/extract.js` – classifies text into a crime type using English and Malay keywords (rompak, ragut, curi, pecah rumah…) and picks place names that follow "in / at / di / dekat".
- `lib/geo.js` – geocodes place names with OpenStreetMap Nominatim, limited to settlements. Street names and addresses are not resolved, so no pin is more precise than a town or taman.
- `ingest/sources.js` – default feeds, Google News searches, feed-checker candidates, and the RSS/Atom parser.
- `ingest/article.js` – when a crime headline names no place, reads the article's description tag or first paragraph, which usually opens with a dateline ("KULAI: …"), and uses it to find the place. Google News links are resolved to the outlet's own article, which is also what the map links to. That resolution uses the same unofficial exchange Google's own site makes, so it can stop working without notice. Run `npm run check-google-news` to see whether it works from your machine. When it fails, Google News stories are mapped only if the headline names a place. The text is used only for this and never stored or shown. Set `ARTICLE_LEADS=off` to skip it.
- Stories set abroad (a foreign place named, no Malaysian one) and Malay idioms that reuse crime words ("ragut 68 nyawa", "padang ragut", "ragut emas", "cetak rompak") are filtered out.
- Follow-up stories (funerals, condolences) are skipped, since the places they name aren't the scene. Courts, hospitals and police stations are never used as the location.
- A bare neighbourhood name that matches places far apart ("Taman Orkid" exists in many towns) is skipped unless the article gives its town ("Taman Orkid, Kluang").
- Pins placed only by the dateline are marked `precision: "town"` and drawn hollow on the map as town-level.
- The same crime reported by several outlets (same type, within 2 km and 3 days) becomes one pin, with the other reports listed under "Also reported by".
- `data/seen.json` – links already processed, so items that didn't become incidents aren't re-read on every pull.
- `lib/store.js` – a JSON file holding the last 30 days of incidents, de-duplicated by link and by headline, so one story carried by several outlets becomes one pin.

## Before going to production

- **Data store:** move incidents to Postgres + PostGIS and query with `ST_DWithin`.
- **Geocoding:** self-host Nominatim or use a paid geocoder. The public one is for light use only.
- **Map tiles:** the public OSM tile server is for light use. Switch to a tile provider (MapTiler, Stadia, Mapbox) for real traffic.
- **Better place extraction:** add a gazetteer of Malaysian tamans and mukims, or an LLM extraction step, to cut misses and wrong matches.
- **News:** store headline, link and a short excerpt only, and link back to the outlet. Check each outlet's terms before republishing anything more.
- **Social:** Reddit returns 403 to all logged-out requests, so the Reddit source needs keys from an approved Reddit app, and Reddit is restricting new API access. X's API is paid, and Facebook, Instagram and TikTok don't allow scraping, so Malaysian Facebook community groups aren't usable without a partnership.
- **Privacy:** keep the area-level rule, don't store usernames or photos, and add a way for people to report a wrong or harmful pin.
- **Legal:** take advice on PDPA 2010 and defamation before publishing user-generated crime claims.
