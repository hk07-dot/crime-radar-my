// GitHub Pages version of the server's API. The page calls api('/api/…') as usual; this answers in the
// browser from the data files GitHub Actions publishes (data/*.json), using the same heat and route code
// as the server (bundled into js/core.js by scripts/build-static.js).
//
// Place search and routing go straight from the browser to the free OpenStreetMap services:
// Nominatim (at most one request a second, results cached) and the FOSSGIS OSRM routers.
(function () {
  const { heat, route, haversineKm } = window.CR;
  const inMalaysia = (lat, lng) => lat > 0.5 && lat < 7.6 && lng > 99.5 && lng < 119.5;

  // Data files are re-fetched at most every 5 minutes; GitHub Pages also caches for ~10 minutes.
  let dataPromise = null, dataAt = 0;
  function data() {
    if (!dataPromise || Date.now() - dataAt > 5 * 60e3) {
      dataAt = Date.now();
      const v = Math.floor(Date.now() / 300e3);
      const get = f => fetch(`data/${f}?v=${v}`).then(r => { if (!r.ok) throw new Error(`Couldn't load ${f} (HTTP ${r.status}).`); return r.json(); });
      dataPromise = Promise.all([get('districts.json'), get('incidents.json'), get('meta.json')])
        .then(([districts, incidents, meta]) => ({ districts, incidents, meta }))
        .catch(e => { dataPromise = null; throw e; });
    }
    return dataPromise;
  }

  function point(q) {
    const lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng'));
    const radius = Math.min(Math.max(parseFloat(q.get('radius')) || 10, 1), 50);
    return inMalaysia(lat, lng) ? { lat, lng, radius } : null;
  }
  const inRange = (items, q, fromKey, toKey) => {
    const from = Date.parse(q.get(fromKey)), to = Date.parse(q.get(toKey));
    const lo = Number.isFinite(from) ? from : 0, hi = Number.isFinite(to) ? to : Date.now() + 864e5;
    return items.filter(i => { const t = Date.parse(i.publishedAt); return t >= lo && t <= hi; });
  };
  const bad = { error: 'lat/lng must be a location in Malaysia' };

  async function official(q) {
    const p = point(q); if (!p) return bad;
    const { districts } = await data();
    const all = districts.map(d => ({ ...d, distanceKm: +haversineKm(p, d).toFixed(1) })).sort((a, b) => a.distanceKm - b.distanceKm);
    return { year: all[0]?.year, source: 'Royal Malaysia Police via data.gov.my (CC BY 4.0)', districts: all.filter((d, i) => d.distanceKm <= p.radius || i === 0) };
  }

  async function incidents(q) {
    const p = point(q); if (!p) return bad;
    const items = inRange((await data()).incidents, q, 'from', 'to')
      .map(i => ({ ...i, distanceKm: +haversineKm(p, i).toFixed(1) }))
      .filter(i => i.distanceKm <= p.radius)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return { count: items.length, incidents: items };
  }

  async function heatGrid(q) {
    const p = point(q); if (!p) return bad;
    const { districts } = await data();
    return { year: districts[0]?.year, ...heat.grid(districts, p) };
  }

  // ---- Place search ----
  const searchCache = new Map();
  let lastNominatim = 0;
  async function nominatim(query) {
    const key = query.toLowerCase();
    if (searchCache.has(key)) return searchCache.get(key);
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatim = Date.now();
    const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'my', limit: '5' });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (res.status === 429 || res.status === 403) throw new Error('Place search is busy. Try again in a minute.');
    if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}).`);
    const results = (await res.json()).map(h => {
      const parts = h.display_name.split(',').map(s => s.trim()).filter(p => p !== 'Malaysia' && !/^\d{5}$/.test(p));
      return { label: parts[0], sub: parts.slice(1, 4).join(', '), lat: +(+h.lat).toFixed(5), lng: +(+h.lon).toFixed(5), kind: h.addresstype || h.type };
    });
    searchCache.set(key, results);
    return results;
  }

  async function search(q) {
    const query = (q.get('q') || '').trim().slice(0, 100);
    if (query.length < 2) return { results: [] };
    const c = query.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{2,3}(?:\.\d+)?)$/);
    if (c) {
      const lat = +c[1], lng = +c[2];
      return inMalaysia(lat, lng) ? { results: [{ label: `${lat}, ${lng}`, sub: 'Coordinates', lat, lng, kind: 'coordinates' }] }
        : { results: [], error: 'Those coordinates are outside Malaysia.' };
    }
    const { meta } = await data();
    const ql = query.toLowerCase();
    const local = (meta.towns || []).filter(t => t.label.toLowerCase().startsWith(ql) || t.label.toLowerCase().includes(' ' + ql)).slice(0, 3)
      .map(t => ({ ...t, sub: 'Police district', kind: 'district' }));
    if (q.get('local') === '1') return { results: local };
    let remote = [], error = null;
    try { remote = await nominatim(query); } catch (e) { error = e.message; }
    const merged = [...local, ...remote.filter(r => !local.some(l => haversineKm(l, r) < 3 && r.label.toLowerCase() === l.label.toLowerCase()))].slice(0, 6);
    return { results: merged, ...(error && !merged.length ? { error } : {}) };
  }

  // ---- Route check ----
  const PROFILES = { car: 'routed-car', foot: 'routed-foot', bike: 'routed-bike' };
  const routeCache = new Map();
  const latLng = s => { const m = String(s || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/); return m && inMalaysia(+m[1], +m[2]) ? { lat: +m[1], lng: +m[2] } : null; };

  async function routeCheck(q) {
    const from = latLng(q.get('from')), to = latLng(q.get('to'));
    if (!from || !to) return { error: 'Choose a start and a destination in Malaysia.' };
    if (haversineKm(from, to) > 400) return { error: 'That trip is too long to check. Try one under 400 km.' };
    const mode = PROFILES[q.get('mode')] ? q.get('mode') : 'car';
    const key = `${mode}:${from.lat.toFixed(4)},${from.lng.toFixed(4)}>${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
    let r = routeCache.get(key);
    if (!r) {
      const url = `https://routing.openstreetmap.de/${PROFILES[mode]}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true&alternatives=false`;
      let res;
      try { res = await fetch(url); } catch { return { error: 'Couldn\'t reach the routing service. Check your connection and try again.' }; }
      if (res.status === 429) return { error: 'The routing service is busy. Try again in a minute.' };
      if (!res.ok) return { error: `The routing service failed (HTTP ${res.status}).` };
      const j = await res.json();
      if (j.code !== 'Ok' || !j.routes?.length) return { error: 'No route found between those places.' };
      r = j.routes[0];
      routeCache.set(key, r);
    }
    const d = await data();
    return route.analyse(r, { districts: d.districts, incidents: inRange(d.incidents, q, 'since', 'until'), mode });
  }

  const handlers = { official, incidents, heat: heatGrid, search, route: routeCheck, meta: async () => (await data()).meta };
  window.STATIC_API = async path => {
    const url = new URL(path, location.href);
    const h = handlers[url.pathname.replace(/^\/api\//, '')];
    if (!h) throw new Error(`Unknown call ${url.pathname}`);
    return h(url.searchParams);
  };
})();
