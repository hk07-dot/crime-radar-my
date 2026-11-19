// Crime Radar MY: serves the map and two JSON endpoints. No dependencies, Node 18+.
//   GET /api/official?lat=..&lng=..&radius=10   official PDRM district stats near a point
//   GET /api/incidents?lat=..&lng=..&radius=10&from=ISO&to=ISO   news + social incidents near a point.
//       from/to come from the viewer's device date; without them, the last two months by this computer's date.
//   GET /api/dashboard?from=ISO&to=ISO                   districts, DOSM figures and all reports, for the dashboard
//   GET /api/heat?lat=..&lng=..                        crime density grid for the red overlay
//   GET /api/search?q=..                                 place search for the map's search box
//   GET /api/route?from=lat,lng&to=lat,lng&mode=car|foot|bike&since=ISO&until=ISO   route with crime along it
const http = require('http');
const fs = require('fs');
const path = require('path');
const { haversineKm, searchPlaces } = require('./lib/geo');
const { getDistricts } = require('./lib/official');
const heat = require('./lib/heat');
const { checkRoute } = require('./lib/route');
const { windowStart } = require('./lib/window');
const store = require('./lib/store');
const { runIngest } = require('./ingest/run');

const PORT = +process.env.PORT || 3000;
const INGEST_MIN = +process.env.INGEST_INTERVAL_MIN || 30;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function point(q) {
  const lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng'));
  const radius = Math.min(Math.max(parseFloat(q.get('radius')) || 10, 1), 50);
  // Rough Malaysia bounding box, so the API isn't used as a general geocoder.
  if (!(lat > 0.5 && lat < 7.6 && lng > 99.5 && lng < 119.5)) return null;
  return { lat, lng, radius };
}

async function official(q, res) {
  const p = point(q);
  if (!p) return json(res, 400, { error: 'lat/lng must be a location in Malaysia' });
  const all = (await getDistricts()).map(d => ({ ...d, distanceKm: +haversineKm(p, d).toFixed(1) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  // District HQs inside the radius, plus the nearest one so there is always a reference figure.
  const near = all.filter((d, i) => d.distanceKm <= p.radius || i === 0);
  json(res, 200, { year: all[0]?.year, source: 'Royal Malaysia Police via data.gov.my (CC BY 4.0)', districts: near });
}

// Everything the dashboard needs: every district (national and state rankings), the DOSM release's
// figures, and all news and social reports in the viewer's date range (from/to, from the device).
const DOSM_FILE = path.join(__dirname, 'data', 'dosm-2026.json');
const DASH_KEEP = ['type', 'title', 'link', 'outlet', 'source', 'publishedAt', 'area', 'lat', 'lng', 'precision'];
async function dashboard(q, res) {
  const districts = await getDistricts();
  let dosm = null;
  try { dosm = JSON.parse(fs.readFileSync(DOSM_FILE, 'utf8')); } catch {}
  const from = Date.parse(q.get('from')), to = Date.parse(q.get('to'));
  const since = Number.isFinite(from) ? from : windowStart().getTime(), until = Number.isFinite(to) ? to : Date.now() + 864e5;
  const incidents = store.load()
    .filter(i => { const t = Date.parse(i.publishedAt); return t >= since && t <= until; })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map(i => Object.fromEntries(DASH_KEEP.filter(k => i[k] !== undefined).map(k => [k, i[k]])));
  json(res, 200, { year: districts[0]?.year, source: 'Royal Malaysia Police via data.gov.my (CC BY 4.0)', districts, dosm, incidents });
}

async function heatGrid(q, res) {
  const p = point(q);
  if (!p) return json(res, 400, { error: 'lat/lng must be a location in Malaysia' });
  const districts = await getDistricts();
  json(res, 200, { year: districts[0]?.year, ...heat.grid(districts, p) });
}

// Police district towns from the built-in table match instantly and offline; everything else
// (tamans, roads, landmarks) goes to the geocoder. "3.14, 101.69" jumps to those coordinates.
const DISTRICT_TOWNS = Object.entries(require('./data/police-districts.json')).filter(([k]) => !k.startsWith('_'))
  .map(([k, [lat, lng]]) => ({ label: k.replace(/\b\w/g, c => c.toUpperCase()), sub: 'Police district', lat, lng, kind: 'district' }));
const inMalaysia = (lat, lng) => lat > 0.5 && lat < 7.6 && lng > 99.5 && lng < 119.5;

async function search(q, res) {
  const query = (q.get('q') || '').trim().slice(0, 100);
  if (query.length < 2) return json(res, 200, { results: [] });
  const c = query.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{2,3}(?:\.\d+)?)$/);
  if (c) {
    const lat = +c[1], lng = +c[2];
    return json(res, 200, { results: inMalaysia(lat, lng) ? [{ label: `${lat}, ${lng}`, sub: 'Coordinates', lat, lng, kind: 'coordinates' }] : [],
      ...(inMalaysia(lat, lng) ? {} : { error: 'Those coordinates are outside Malaysia.' }) });
  }
  const ql = query.toLowerCase();
  const local = DISTRICT_TOWNS.filter(t => t.label.toLowerCase().startsWith(ql) || t.label.toLowerCase().includes(' ' + ql)).slice(0, 3);
  if (q.get('local') === '1') return json(res, 200, { results: local });
  let remote = [], error = null;
  try { remote = await searchPlaces(query); } catch (e) { error = e.message; }
  // Drop geocoder hits that duplicate a district town already listed.
  const merged = [...local, ...remote.filter(r => !local.some(l => haversineKm(l, r) < 3 && r.label.toLowerCase() === l.label.toLowerCase()))].slice(0, 6);
  json(res, 200, { results: merged, ...(error && !merged.length ? { error } : {}) });
}

const latLng = s => { const m = String(s || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/); return m && inMalaysia(+m[1], +m[2]) ? { lat: +m[1], lng: +m[2] } : null; };

async function route(q, res) {
  const from = latLng(q.get('from')), to = latLng(q.get('to'));
  if (!from || !to) return json(res, 400, { error: 'Choose a start and a destination in Malaysia.' });
  // Same date range as the map, from the viewer's device.
  const since = Date.parse(q.get('since')), until = Date.parse(q.get('until'));
  const lo = Number.isFinite(since) ? since : windowStart().getTime(), hi = Number.isFinite(until) ? until : Date.now() + 864e5;
  const items = store.load().filter(i => { const t = Date.parse(i.publishedAt); return t >= lo && t <= hi; });
  try {
    json(res, 200, await checkRoute({ from, to, mode: q.get('mode'), districts: await getDistricts(), incidents: items }));
  } catch (e) {
    json(res, e.status || 502, { error: e.message });
  }
}

function incidents(q, res) {
  const p = point(q);
  if (!p) return json(res, 400, { error: 'lat/lng must be a location in Malaysia' });
  // The range is the viewer's: the page sends it from the device's own date.
  const from = Date.parse(q.get('from')), to = Date.parse(q.get('to'));
  const since = Number.isFinite(from) ? from : windowStart().getTime();
  const until = Number.isFinite(to) ? to : Date.now() + 864e5;
  const items = store.load()
    .filter(i => { const t = Date.parse(i.publishedAt); return t >= since && t <= until; })
    .map(i => ({ ...i, distanceKm: +haversineKm(p, i).toFixed(1) }))
    .filter(i => i.distanceKm <= p.radius)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  json(res, 200, { count: items.length, incidents: items });
}

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/official') return await official(url.searchParams, res);
    if (url.pathname === '/api/incidents') return incidents(url.searchParams, res);
    if (url.pathname === '/api/dashboard') return await dashboard(url.searchParams, res);
    if (url.pathname === '/api/heat') return await heatGrid(url.searchParams, res);
    if (url.pathname === '/api/search') return await search(url.searchParams, res);
    if (url.pathname === '/api/route') return await route(url.searchParams, res);
    serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    json(res, 502, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Crime Radar MY on http://localhost:${PORT}`));
  getDistricts().catch(e => console.warn('[official]', e.message));
  if (process.env.INGEST !== 'off') {
    // One run at a time: a backfill run can take longer than the interval.
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await runIngest(); } catch (e) { console.warn('[ingest]', e.message); } finally { running = false; }
    };
    tick();
    setInterval(tick, INGEST_MIN * 60e3);
  }
}

module.exports = server;
