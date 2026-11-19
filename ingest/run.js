// Pulls crime-related items from Malaysian news feeds, Google News and social media (ingest/social.js), extracts a
// crime type and an area-level location, and stores them. Run on a schedule:
//   node ingest/run.js            (once)
// The server also runs it every INGEST_INTERVAL_MIN minutes.
const { isPolitical, stripIdioms, classify, placeCandidates, datelineTown, isAbroad, FOLLOW_UP, AGGREGATE, SUB_AREA, POLICY, knownTown, SOCIAL_NOISE, FIRST_HAND } = require('./extract');
const { fetchSocial, mask } = require('./social');
const { articleLead } = require('./article');
const MAX_FROM_TOWN_KM = 40;
const TOWN_KINDS = new Set(['city', 'town', 'village', 'municipality', 'suburb', 'hamlet']);
// Reports of one crime often disagree on the type (robbery vs break-in); merge within a family.
const FAMILY = { robbery: 'property', break_in: 'property', snatch_theft: 'property', theft: 'property', vehicle_theft: 'property',
  murder: 'violent', assault: 'violent', shooting: 'violent' };
const family = t => FAMILY[t] || t;
const COURT = /\b(court|jailed|sentenced|get \d+ years|pleaded|charged with|acquitted|mahkamah|didakwa|dihukum|penjara|mengaku (tidak )?bersalah|dijatuhi)\b/i;
const { geocode, haversineKm } = require('../lib/geo');
const store = require('../lib/store');
const { activeFeeds, fetchFeed, parseFeed, backfillWeeks } = require('./sources');
const { windowStart, ymd } = require('../lib/window');
const fs = require('fs');
const path = require('path');
// New items handled per run. A two-month backfill is spread over several runs so it doesn't
// hit the geocoder or news sites too hard; the rest wait in data/queue.json.
const MAX_PER_RUN = +process.env.MAX_PER_RUN || 250;
const BACKFILL_FILE = path.join(__dirname, '..', 'data', 'backfill.json');
const loadBackfill = () => { try { return JSON.parse(fs.readFileSync(BACKFILL_FILE, 'utf8')); } catch { return {}; } };

const DEBUG = process.env.DEBUG_INGEST === '1';

const UA = process.env.GEOCODER_UA || 'CrimeRadarMY/0.1';
// One story is often carried by several outlets; match them on a normalised headline.
const titleKey = t => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
const safeDate = d => { const t = Date.parse(d); return new Date(Number.isFinite(t) ? t : Date.now()).toISOString(); };

async function pull(feeds, out) {
  let failed = 0;
  for (const feed of feeds) {
    try {
      const items = await fetchFeed(feed.url);
      for (const it of items) out.push({ ...it, source: 'news', outlet: it.outlet || feed.name });
      if (DEBUG) console.log(`  [feed] ${feed.name}: ${items.length} items`);
    } catch (e) { failed++; console.warn(`[ingest] ${feed.name} failed: ${e.message}`); }
  }
  return failed;
}

async function fetchNews(stats) {
  const out = [];
  await pull(activeFeeds(), out);
  // Backfill: Google News searches for each week of the two-month window not fetched yet.
  if (process.env.GOOGLE_NEWS !== 'off' && process.env.BACKFILL !== 'off') {
    const done = loadBackfill();
    const pending = backfillWeeks().filter(w => !done[w.key]);
    // Two weeks per run, so a run stays short.
    for (const w of pending.slice(0, 2)) {
      const before = out.length;
      const failed = await pull(w.searches, out);
      if (failed <= 2) done[w.key] = new Date().toISOString();
      stats.backfillWeeks = (stats.backfillWeeks || 0) + 1;
      console.log(`[ingest] backfill: week of ${w.key}, ${out.length - before} stories`);
    }
    stats.backfillLeft = Math.max(0, pending.length - 2);
    fs.writeFileSync(BACKFILL_FILE, JSON.stringify(done, null, 1));
  }
  return out;
}

const LEADS = process.env.ARTICLE_LEADS !== 'off';
const bump = (stats, k) => { stats[k] = (stats[k] || 0) + 1; };

// Social posts: no datelines and no article to read, often lowercase and casual. A post must
// report something that happened (not a question or joke) and name a Malaysian place.
async function socialIncident(raw, stats) {
  const text = raw.fullText || `${raw.title}. ${raw.summary}`;
  const type = classify(text);
  if (!type) return null;
  bump(stats, 'crime');
  if (isPolitical(text, '', raw.link)) { bump(stats, 'political'); if (DEBUG) console.log(`  [political] ${raw.title}`); return null; }
  if (SOCIAL_NOISE.test(text) || !FIRST_HAND.test(text) && !/\b(polis|police|ditahan|arrested)\b/i.test(text)) {
    bump(stats, 'socialNoise');
    if (DEBUG) console.log(`  [social, not a report] ${raw.title}`);
    return null;
  }
  const { places, named } = placeCandidates(text);
  if (isAbroad(text, named, raw.title)) { bump(stats, 'abroad'); if (DEBUG) console.log(`  [abroad] ${raw.title}`); return null; }
  const town = knownTown(text);
  // A taman named in the post is tried with the town it mentions first ("Taman Desa, Cheras").
  const tries = [...places.flatMap(p => (town && !p.includes(',') && SUB_AREA.test(p) ? [`${p}, ${town}`, p] : [p])), ...(town ? [town] : [])];
  if (!tries.length) { if (DEBUG) console.log(`  [social, no place] ${raw.title}`); return null; }
  bump(stats, 'withPlace');
  const townLoc = town ? await geocode(town, { areaOnly: true }) : null;
  for (const place of [...new Set(tries)]) {
    let loc = await geocode(place, { areaOnly: true });
    if (loc && townLoc && place !== town && haversineKm(loc, townLoc) > MAX_FROM_TOWN_KM) loc = null;
    if (loc && !place.includes(' ') && place !== town && loc.kind && !TOWN_KINDS.has(loc.kind)) loc = null;
    if (DEBUG) console.log(`  [social ${loc ? 'located' : 'not found'}] "${place}" ← ${raw.title}`);
    if (loc) {
      return {
        type, title: mask(raw.title), link: raw.link, outlet: raw.outlet, source: 'social', verified: false,
        publishedAt: safeDate(raw.publishedAt), place, area: loc.label, lat: loc.lat, lng: loc.lng,
        precision: place === town ? 'town' : 'area',
      };
    }
  }
  return null;
}

async function toIncident(raw, stats = {}) {
  if (raw.source === 'social') return socialIncident(raw, stats);
  let text = `${raw.title}. ${raw.summary}`;
  const type = classify(text);
  if (!type) return null;
  bump(stats, 'crime');
  if (isPolitical(raw.title, raw.summary, raw.link)) { bump(stats, 'political'); if (DEBUG) console.log(`  [political] ${raw.title}`); return null; }
  if (AGGREGATE.test(raw.title)) {
    bump(stats, 'followUp');
    if (DEBUG) console.log(`  [statistics story] ${raw.title}`);
    return null;
  }
  if (FOLLOW_UP.test(raw.title)) {
    bump(stats, 'followUp');
    if (DEBUG) console.log(`  [follow-up story] ${raw.title}`);
    return null;
  }
  let { places, named } = placeCandidates(text);
  let articleUrl = null;
  // The headline names no place: read the article's opening line, which usually starts with a dateline.
  if (!named && LEADS) {
    const lead = await articleLead(raw.link);
    if (lead.url && !/news\.google\.com/.test(lead.url)) articleUrl = lead.url;
    // A Google News link only shows its section (/berita/politik/) once resolved.
    if (articleUrl && isPolitical('', '', articleUrl)) { bump(stats, 'political'); if (DEBUG) console.log(`  [political] ${raw.title}`); return null; }
    if (lead.text) {
      bump(stats, 'leads');
      text = `${raw.title}. ${lead.text}`;
      ({ places, named } = placeCandidates(text));
    }
  }
  if (isAbroad(text, named, raw.title)) {
    bump(stats, 'abroad');
    if (DEBUG) console.log(`  [abroad] ${raw.title}`);
    return null;
  }
  if (!places.length) {
    if (DEBUG) console.log(`  [no place] ${raw.title}${text.length > raw.title.length + 3 ? `\n      text: ${text.slice(raw.title.length + 2, raw.title.length + 120)}…` : ''}`);
    return null;
  }
  bump(stats, 'withPlace');
  // A place paired with the dateline town ("Seksyen 7, Shah Alam") must land near that town,
  // otherwise the geocoder matched something unrelated, like a street named after a country.
  const town = datelineTown(text);
  const townLoc = town ? await geocode(town, { areaOnly: true }) : null;
  for (const place of places) {
    // Online scams have no physical scene; a dateline alone would pin them to a random city centre.
    // A dateline names where the story was filed. For online scams and court cases that is not
    // where the crime happened, so those need a place named in the text itself.
    const namedInText = town && new RegExp(`\\b(in|at|near|di|dekat)\\s+${town}\\b`).test(text);
    if (place === town && !namedInText && (type === 'scam' || COURT.test(text) || POLICY.test(raw.title))) {
      const why = type === 'scam' ? 'scam' : COURT.test(text) ? 'court case' : 'statement or policy story';
      if (DEBUG) console.log(`  [skipped, ${why} with dateline only] ← ${raw.title}`);
      continue;
    }
    let loc = await geocode(place, { areaOnly: true });
    let note = loc ? 'located' : 'not found';
    // A taman or kampung must be near the story's town ("Taman Pandan Damai" exists in several towns).
    // Paired candidates ("X, Kuantan") must be too.
    const mustBeNearTown = place.endsWith(`, ${town}`) || SUB_AREA.test(place);
    if (loc && townLoc && mustBeNearTown && haversineKm(loc, townLoc) > MAX_FROM_TOWN_KM) {
      note = `rejected, ${haversineKm(loc, townLoc).toFixed(0)} km from ${town}`;
      loc = null;
    }
    // A single word ("Nexus") is only trusted when it resolves to a town, not a building or estate.
    if (loc && !place.includes(' ') && !place.includes(',') && place !== town && loc.kind && !TOWN_KINDS.has(loc.kind)) {
      note = `rejected, "${place}" is a ${loc.kind}, not a town`;
      loc = null;
    }
    if (DEBUG) console.log(`  [${note}] "${place}" ← ${raw.title}`);
    if (loc) {
      return {
        type, title: raw.title, link: articleUrl || raw.link, outlet: raw.outlet,
        source: raw.source, verified: raw.source === 'news',
        publishedAt: safeDate(raw.publishedAt),
        place, area: loc.label, lat: loc.lat, lng: loc.lng,
        // "town" when only the dateline placed it, so the map can show it as approximate.
        precision: place === town ? 'town' : 'area',
      };
    }
  }
  return null;
}

// The same crime reported by several outlets, or in Malay and English, becomes one pin:
// same crime type, within 2 km, published within 3 days. Extra reports are kept as links.
function mergeDuplicates(stored, incoming, stats) {
  const pool = [...stored];
  const fresh = [];
  let storedChanged = false;
  for (const inc of incoming) {
    const twin = pool.find(o => family(o.type) === family(inc.type) && haversineKm(o, inc) <= 2 &&
      Math.abs(Date.parse(o.publishedAt) - Date.parse(inc.publishedAt)) <= 3 * 864e5);
    if (twin) {
      twin.alsoReported = [...(twin.alsoReported || []), { outlet: inc.outlet, link: inc.link, title: inc.title }].slice(0, 5);
      if (twin.precision === 'town' && inc.precision === 'area') Object.assign(twin, { lat: inc.lat, lng: inc.lng, area: inc.area, place: inc.place, precision: 'area' });
      if (stored.includes(twin)) storedChanged = true;
      bump(stats, 'merged');
      if (DEBUG) console.log(`  [same incident] "${inc.title}" merged into "${twin.title}"`);
    } else {
      pool.push(inc);
      fresh.push(inc);
    }
  }
  if (storedChanged) store.replace(stored);
  return fresh;
}

async function runIngest() {
  const started = Date.now();
  const stats = {};
  const news = await fetchNews(stats);
  const social = await fetchSocial();
  const queued = store.loadQueue();
  // Newest first, so the map fills from today backwards.
  const raw = [...news, ...social, ...queued].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  const cutoff = windowStart().getTime();
  // Re-check stored pins against the current rules, so a fix to the filters also cleans old data.
  const before = store.load();
  // Removes political pins, and pins whose headline's only crime word was an idiom ("curi perhatian").
  // Pins whose crime was found in the article text, not the headline, are kept.
  const idiomOnly = t => stripIdioms(t) !== t && !classify(t);
  const stored = before.filter(i => !isPolitical(i.title, '', i.link) && !idiomOnly(i.title));
  if (stored.length < before.length) {
    store.replace(stored);
    console.log(`[ingest] removed ${before.length - stored.length} stored pins that no longer pass the filters`);
  }
  const seen = store.loadSeen();
  const known = new Set([...stored.map(i => i.link), ...Object.keys(seen)]);
  const seenTitles = new Set(stored.map(i => titleKey(i.title)));
  const incidents = [], later = [];
  let fresh = 0;
  for (const r of raw) {
    const key = titleKey(r.title);
    if (!r.link || known.has(r.link) || seenTitles.has(key)) continue;
    // Only the two-month window, counted from this computer's date. Undated items count as today.
    const t = Date.parse(r.publishedAt);
    if (t < cutoff || t > Date.now() + 864e5) continue;
    known.add(r.link);
    if (fresh >= MAX_PER_RUN) { later.push(r); continue; }
    seenTitles.add(key);
    seen[r.link] = Date.now();
    fresh++;
    const inc = await toIncident(r, stats);
    if (inc) incidents.push(inc);
  }
  const added = store.upsert(mergeDuplicates(stored, incidents, stats));
  store.saveSeen(seen);
  store.saveQueue(later);
  console.log(`[ingest] ${news.length} news + ${social.length} social items (${fresh} new) → ${stats.crime || 0} about crime` +
    ` (${stats.abroad || 0} abroad, ${stats.followUp || 0} follow-ups or tallies, ${stats.political || 0} political, ${stats.socialNoise || 0} social posts that aren't reports, ${stats.leads || 0} articles read for a place) → ${stats.withPlace || 0} name a place → ${added} added${stats.merged ? `, ${stats.merged} merged into existing pins` : ''},` +
    ` in ${((Date.now() - started) / 1000).toFixed(0)}s` +
    (later.length || stats.backfillLeft ? `. Still to do: ${later.length} queued items${stats.backfillLeft ? `, ${stats.backfillLeft} backfill weeks` : ''} (next run, or npm run backfill)` : ''));
  return { added, queued: later.length, backfillLeft: stats.backfillLeft || 0 };
}

if (require.main === module) runIngest().catch(e => { console.error(e); process.exit(1); });

module.exports = { runIngest, parseRss: parseFeed, toIncident };
