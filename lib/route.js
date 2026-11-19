// Route check: a driving or walking route between two points, the crime density along it,
// and the reported crimes close to the roads it uses.
//
// Routing comes from the OSRM servers run by FOSSGIS for OpenStreetMap (routing.openstreetmap.de),
// free for light use. Set ROUTER_URL to use your own OSRM server instead.
const { haversineKm } = require('./geo');
const heat = require('./heat');

const UA = process.env.GEOCODER_UA || 'CrimeRadarMY/0.1';
const PROFILES = { car: 'routed-car', foot: 'routed-foot', bike: 'routed-bike' };
// How close a reported crime has to be to count as "on" the route.
const NEAR_M = { car: 400, foot: 250, bike: 300 };
const routeCache = new Map();

async function fetchRoute(from, to, mode) {
  const key = `${mode}:${from.lat.toFixed(4)},${from.lng.toFixed(4)}>${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.route;
  const base = process.env.ROUTER_URL || `https://routing.openstreetmap.de/${PROFILES[mode]}`;
  const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true&alternatives=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) throw Object.assign(new Error('The routing service is busy. Try again in a minute.'), { status: 503 });
  if (!res.ok) throw Object.assign(new Error(`The routing service failed (HTTP ${res.status}).`), { status: 502 });
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw Object.assign(new Error('No route found between those places.'), { status: 404 });
  const route = j.routes[0];
  routeCache.set(key, { at: Date.now(), route });
  return route;
}

// Metres from point p to segment a–b, on a flat projection around p (fine at route scale).
function distToSegmentM(p, a, b) {
  const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

const roadName = s => [s.name, s.ref].filter(Boolean).join(' / ') || null;

// incidents: already filtered to the viewer's date range.
function analyse(route, { districts, incidents, mode }) {
  const steps = route.legs.flatMap(l => l.steps).filter(s => s.geometry?.coordinates?.length > 1)
    .map(s => ({ road: roadName(s), pts: s.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })), distanceM: s.distance }));
  const line = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

  // Density along the route, sampled every ~200 m and merged into stretches of the same level.
  const stretches = [];
  for (const st of steps) {
    for (let i = 1; i < st.pts.length; i++) {
      const a = st.pts[i - 1], b = st.pts[i];
      const km = haversineKm(a, b), n = Math.max(1, Math.ceil(km / 0.2));
      for (let k = 0; k < n; k++) {
        const p = { lat: a.lat + (b.lat - a.lat) * (k + 0.5) / n, lng: a.lng + (b.lng - a.lng) * (k + 0.5) / n };
        const level = Math.min(4, Math.floor(districts.length ? heat.levelAt(districts, p.lat, p.lng) : 0));
        const last = stretches[stretches.length - 1];
        const pa = { lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n };
        const pb = { lat: a.lat + (b.lat - a.lat) * (k + 1) / n, lng: a.lng + (b.lng - a.lng) * (k + 1) / n };
        if (last && last.level === level) { last.coords.push([pb.lat, pb.lng]); last.km += km / n; if (st.road) last.roads.add(st.road); }
        else stretches.push({ level, coords: [[pa.lat, pa.lng], [pb.lat, pb.lng]], km: km / n, roads: new Set(st.road ? [st.road] : []) });
      }
    }
  }

  // Reported crimes near the route, each matched to the nearest road it lies along.
  const lats = line.map(p => p.lat), lngs = line.map(p => p.lng), pad = 0.01;
  const box = { s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lngs) - pad, e: Math.max(...lngs) + pad };
  const warnings = [];
  let townLevelNear = 0;
  for (const inc of incidents) {
    if (inc.lat < box.s || inc.lat > box.n || inc.lng < box.w || inc.lng > box.e) continue;
    let best = { d: Infinity, road: null };
    for (const st of steps) for (let i = 1; i < st.pts.length; i++) {
      const d = distToSegmentM(inc, st.pts[i - 1], st.pts[i]);
      if (d < best.d) best = { d, road: st.road };
    }
    if (best.d > NEAR_M[mode]) continue;
    // Town-level pins mark a town centre, not a scene, so they're counted but not listed as on the road.
    if (inc.precision === 'town') { townLevelNear++; continue; }
    warnings.push({ ...inc, distanceM: Math.round(best.d), road: best.road });
  }
  warnings.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const byLevel = [0, 0, 0, 0, 0];
  for (const s of stretches) byLevel[s.level] += s.km;
  const highRoads = [...new Set(stretches.filter(s => s.level >= 3).flatMap(s => [...s.roads]))].slice(0, 6);
  return {
    distanceKm: +(route.distance / 1000).toFixed(1), durationMin: Math.round(route.duration / 60),
    nearM: NEAR_M[mode],
    stretches: stretches.map(s => ({ level: s.level, label: heat.LEVEL_LABELS[s.level], km: +s.km.toFixed(2), roads: [...s.roads].slice(0, 4), coords: s.coords })),
    kmByLevel: byLevel.map((km, level) => ({ level, label: heat.LEVEL_LABELS[level], km: +km.toFixed(1) })),
    highRoads, warnings, townLevelNear,
  };
}

async function checkRoute({ from, to, mode = 'car', districts, incidents }) {
  if (!PROFILES[mode]) mode = 'car';
  if (haversineKm(from, to) > 400) throw Object.assign(new Error('That trip is too long to check. Try one under 400 km.'), { status: 400 });
  const route = await fetchRoute(from, to, mode);
  return analyse(route, { districts, incidents, mode });
}

module.exports = { checkRoute, analyse, distToSegmentM };
