// Official PDRM crime statistics, published by DOSM on data.gov.my (CC BY 4.0).
// Granularity: annual totals per police district (no street-level incidents exist publicly).
const fs = require('fs');
const path = require('path');
const { geocode } = require('./geo');

const CSV_URL = process.env.CRIME_CSV_URL || 'https://storage.data.gov.my/publicsafety/crime_district.csv';
const CACHE = path.join(__dirname, '..', 'data', 'crime_district.csv');
const SEEDS = require('../data/police-districts.json');
const MAX_AGE_MS = 24 * 3600 * 1000;

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

// When the CSV was last downloaded is kept in a small file, not the file's own date: a fresh checkout
// (as on GitHub Actions) gives every file today's date.
const CACHE_META = CACHE.replace(/\.csv$/, '.meta.json');
async function loadCsv() {
  let fresh = false;
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(CACHE_META, 'utf8')).downloadedAt);
    fresh = fs.existsSync(CACHE) && Date.now() - at < MAX_AGE_MS;
  } catch {}
  if (!fresh) {
    try {
      const res = await fetch(CSV_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(CACHE, await res.text());
      fs.writeFileSync(CACHE_META, JSON.stringify({ downloadedAt: new Date().toISOString(), url: CSV_URL }));
      console.log('[official] downloaded crime_district.csv');
    } catch (e) {
      if (!fs.existsSync(CACHE)) throw new Error(`Could not download official data (${e.message})`);
      console.warn('[official] using cached CSV:', e.message);
    }
  }
  return parseCsv(fs.readFileSync(CACHE, 'utf8'));
}

let districtsPromise = null;

// Builds [{district, state, year, lat, lng, total, assault, property, byType}] for the latest year.
async function buildDistricts() {
  const rows = (await loadCsv()).filter(r => r.district && r.district.toLowerCase() !== 'all');
  const latest = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const year = latest.slice(0, 4);
  // The year before, for the dashboard's change figures.
  const prevDate = `${+year - 1}${latest.slice(4)}`;
  const prev = new Map();
  for (const r of rows) {
    if (r.date !== prevDate || r.type === 'all' || r.category === 'all') continue;
    const key = `${r.state}|${r.district}`;
    if (!prev.has(key)) prev.set(key, { year: String(+year - 1), total: 0, assault: 0, property: 0, byType: {} });
    const p = prev.get(key), n = parseInt(r.crimes, 10) || 0;
    p.byType[r.type] = (p.byType[r.type] || 0) + n;
    if (r.category === 'assault') p.assault += n;
    if (r.category === 'property') p.property += n;
    p.total += n;
  }
  const map = new Map();
  for (const r of rows) {
    if (r.date !== latest) continue;
    const key = `${r.state}|${r.district}`;
    if (!map.has(key)) map.set(key, { district: r.district, state: r.state, year, byType: {}, assault: 0, property: 0, total: 0 });
    const d = map.get(key);
    const n = parseInt(r.crimes, 10) || 0;
    // Rows with type "all" are subtotals; use detailed types only to avoid double counting.
    if (r.type === 'all' || r.category === 'all') continue;
    d.byType[r.type] = (d.byType[r.type] || 0) + n;
    if (r.category === 'assault') d.assault += n;
    if (r.category === 'property') d.property += n;
    d.total += n;
  }
  const out = [];
  for (const d of map.values()) {
    // Dataset names can carry prefixes like "W.P. Putrajaya" or "IPD Kajang"; match on the bare name.
    const bare = d.district.replace(/^(W\.?\s?P\.?|IPD|Daerah)\s+/i, '').trim();
    const seed = SEEDS[bare.toLowerCase()] || SEEDS[d.district.toLowerCase()];
    let loc = seed ? { lat: seed[0], lng: seed[1] } : null;
    if (!loc) loc = await geocode(`${bare}, ${d.state.replace(/^W\.?\s?P\.?\s+/i, '')}, Malaysia`, { areaOnly: false });
    if (!loc) { console.warn('[official] no location for district:', d.district, d.state); continue; }
    out.push({ ...d, lat: loc.lat, lng: loc.lng, located: seed ? 'table' : 'geocoded', prev: prev.get(`${d.state}|${d.district}`) || null });
  }
  const missing = map.size - out.length;
  console.log(`[official] ${out.length} districts ready for ${year}` + (missing ? `, ${missing} still without a location (retrying in 15 minutes)` : ''));
  // Rebuild later so districts that failed to geocode get another try.
  if (missing) setTimeout(() => { districtsPromise = null; }, 15 * 60e3).unref();
  return out;
}

// Rebuilt daily, so a newer year published on data.gov.my is picked up without restarting the server.
let builtAt = 0;
function getDistricts() {
  if (districtsPromise && Date.now() - builtAt > MAX_AGE_MS) districtsPromise = null;
  if (!districtsPromise) {
    builtAt = Date.now();
    districtsPromise = buildDistricts().catch(e => { districtsPromise = null; throw e; });
  }
  return districtsPromise;
}

module.exports = { getDistricts, parseCsv };
