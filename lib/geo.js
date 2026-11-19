// Distance maths + rate-limited, cached geocoding via OpenStreetMap Nominatim.
// Nominatim usage policy: max 1 request/second, a real User-Agent, and cache results.
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'geocode-cache.json');
const UA = process.env.GEOCODER_UA || 'CrimeRadarMY/0.1 (set GEOCODER_UA to your contact email)';

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

function haversineKm(a, b) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let lastCall = 0, pausedUntil = 0, pauseNoticeAt = 0;
async function throttle() {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

// Area-level OSM results we accept for news/social text: towns, suburbs, tamans, mukims.
// Roads, buildings and shops are rejected so nothing pins a specific address.
const AREA_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood',
  'residential', 'municipality', 'county', 'state_district', 'district', 'subdistrict', 'locality', 'isolated_dwelling']);
const isArea = h => h.category === 'place' || h.category === 'boundary' ||
  AREA_TYPES.has(h.addresstype) || AREA_TYPES.has(h.type);

const AMBIGUOUS_KM = 30;

// Returns {lat, lng, label} or null. `areaOnly` keeps results at town/neighbourhood level.
async function geocode(query, { areaOnly = true } = {}) {
  const key = (areaOnly ? 'area4:' : 'any:') + query.toLowerCase().trim();
  if (key in cache) return cache[key];
  // After a rate-limit answer, stop asking for a while instead of piling on more requests.
  if (Date.now() < pausedUntil) return null;
  await throttle();
  const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'my', limit: '5' });
  let result = null;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'User-Agent': UA } });
    if (res.status === 429 || res.status === 403) {
      pausedUntil = Date.now() + 10 * 60e3;
      if (Date.now() - pauseNoticeAt > 60e3) {
        console.warn(`[geocode] the geocoder is rate-limiting this computer (HTTP ${res.status}); pausing lookups for 10 minutes. Set GEOCODER_UA with a contact email to reduce this.`);
        pauseNoticeAt = Date.now();
      }
      return null;
    }
    if (!res.ok) { console.warn(`[geocode] HTTP ${res.status} for "${query}"`); return null; }
    const hits = await res.json();
    const hit = areaOnly ? hits.find(isArea) : hits[0];
    // A bare name with no town ("Taman Orkid") can match neighbourhoods in many towns. If the
    // settlement-level matches are far apart, the name is ambiguous, so don't guess.
    if (hit && areaOnly && !query.includes(',')) {
      const settlements = hits.filter(h => h.category === 'place' || h.type === 'residential')
        .map(h => ({ lat: +h.lat, lng: +h.lon }));
      const spread = Math.max(0, ...settlements.map(a => Math.max(...settlements.map(b => haversineKm(a, b)))));
      if (spread > AMBIGUOUS_KM) {
        if (process.env.DEBUG_INGEST === '1') console.log(`    [geocode] "${query}" is ambiguous: matches ${spread.toFixed(0)} km apart`);
        cache[key] = null; saveCache();
        return null;
      }
    }
    if (hit) result = { lat: +(+hit.lat).toFixed(4), lng: +(+hit.lon).toFixed(4), label: hit.display_name.split(',').slice(0, 2).join(','), kind: hit.addresstype || hit.type };
  } catch (e) {
    console.warn('[geocode] failed:', query, e.message);
    return null; // don't cache network failures
  }
  cache[key] = result;
  saveCache();
  return result;
}

// Place search for the map's search box: up to 5 matches in Malaysia, any kind of place
// (town, taman, road, building). Shares the 1-request-per-second limit and the rate-limit pause
// with the ingest, and keeps results in memory for an hour.
const searchCache = new Map();
async function searchPlaces(query) {
  const key = query.toLowerCase().trim();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.results;
  if (Date.now() < pausedUntil) { const e = new Error('Place search is paused for a few minutes because the map service is rate-limiting this computer.'); e.status = 503; throw e; }
  await throttle();
  const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'my', limit: '5', addressdetails: '0' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (res.status === 429 || res.status === 403) {
    pausedUntil = Date.now() + 10 * 60e3;
    const e = new Error('Place search is paused for a few minutes because the map service is rate-limiting this computer.'); e.status = 503; throw e;
  }
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}).`);
  const results = (await res.json()).map(h => {
    const parts = h.display_name.split(',').map(s => s.trim()).filter(p => p !== 'Malaysia' && !/^\d{5}$/.test(p));
    return { label: parts[0], sub: parts.slice(1, 4).join(', '), lat: +(+h.lat).toFixed(5), lng: +(+h.lon).toFixed(5), kind: h.addresstype || h.type };
  });
  searchCache.set(key, { at: Date.now(), results });
  return results;
}

module.exports = { haversineKm, geocode, isArea, searchPlaces };
