// Tests candidate Malaysian news feeds from this machine and saves the working ones.
//   npm run check-feeds
// 1. Reads each outlet page in DISCOVER_PAGES for the RSS/Atom links it advertises.
// 2. Fetches every candidate and discovered feed.
// 3. Keeps feeds that return items published in the last 7 days, and writes them to data/feeds.json.
const fs = require('fs');
const { CANDIDATES, DISCOVER_PAGES, GOOGLE_NEWS, FEEDS_FILE, UA, fetchFeed } = require('./sources');
const { classify } = require('./extract');

const FRESH_DAYS = 7;

async function discover(page) {
  try {
    const res = await fetch(page.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const html = await res.text();
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0])
      .filter(t => /application\/(rss|atom)\+xml/i.test(t))
      .map(t => { const href = (t.match(/href=["']([^"']+)["']/i) || [])[1]; const title = (t.match(/title=["']([^"']+)["']/i) || [])[1]; return href && { href, title }; })
      .filter(Boolean)
      // Skip comment feeds, which WordPress sites advertise alongside the main one.
      .filter(l => !/comment/i.test(l.href + (l.title || '')));
    const clean = t => t.replace(/&raquo;|&#187;|»/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    return links.map(l => ({ name: l.title ? `${page.name}: ${clean(l.title)}` : page.name, url: new URL(l.href, page.url).href }));
  } catch { return []; }
}

async function check(feed) {
  const t0 = Date.now();
  try {
    const items = await fetchFeed(feed.url);
    const dates = items.map(i => Date.parse(i.publishedAt)).filter(Number.isFinite);
    const newest = dates.length ? Math.max(...dates) : null;
    const ageDays = newest ? (Date.now() - newest) / 864e5 : null;
    const crime = items.filter(i => classify(`${i.title}. ${i.summary}`)).length;
    // Feeds without dates (Bernama) count as fresh if they return items.
    const fresh = items.length > 0 && (ageDays === null || ageDays <= FRESH_DAYS);
    return { ...feed, ok: fresh, items: items.length, crime, ageDays, ms: Date.now() - t0, error: fresh ? null : items.length ? `newest item ${ageDays.toFixed(0)} days old` : 'no items' };
  } catch (e) {
    return { ...feed, ok: false, items: 0, crime: 0, ageDays: null, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}

async function main() {
  console.log('Looking for feeds advertised on outlet pages…');
  const discovered = (await Promise.all(DISCOVER_PAGES.map(discover))).flat();
  console.log(`  found ${discovered.length} advertised feed links`);

  const all = [...CANDIDATES, ...discovered];
  const unique = [...new Map(all.map(f => [f.url.replace(/\/$/, ''), f])).values()];
  console.log(`Testing ${unique.length} feeds plus ${GOOGLE_NEWS.length} Google News searches…\n`);

  const results = [];
  for (let i = 0; i < unique.length; i += 6) results.push(...await Promise.all(unique.slice(i, i + 6).map(check)));
  const gnResults = await Promise.all(GOOGLE_NEWS.map(check));

  // Several discovered links can point at the same content under different URLs; keep the one with most crime items.
  const working = results.filter(r => r.ok).sort((a, b) => b.crime - a.crime || b.items - a.items);
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`${pad('', 2)}${pad('Feed', 44)}${pad('Items', 7)}${pad('Crime', 7)}${pad('Newest', 9)}Status`);
  for (const r of [...results.sort((a, b) => b.ok - a.ok || b.crime - a.crime), ...gnResults]) {
    const age = r.ageDays === null ? (r.ok ? 'no date' : '') : r.ageDays < 1 ? `${Math.round(r.ageDays * 24)}h` : `${r.ageDays.toFixed(0)}d`;
    console.log(`${r.ok ? '✓ ' : '✗ '}${pad(r.name, 44)}${pad(r.items || '', 7)}${pad(r.items ? r.crime : '', 7)}${pad(age, 9)}${r.ok ? 'ok' : r.error}`);
  }

  if (!working.length) {
    console.log('\nNo outlet feeds worked, so data/feeds.json was not changed. Google News is still used if it passed.');
    return;
  }
  fs.writeFileSync(FEEDS_FILE, JSON.stringify({
    checkedAt: new Date().toISOString(),
    feeds: working.map(({ name, url }) => ({ name, url })),
  }, null, 2));
  const gnOk = gnResults.filter(r => r.ok).length;
  console.log(`\nSaved ${working.length} working outlet feeds to data/feeds.json. Google News: ${gnOk} of ${gnResults.length} searches working.`);
  console.log('Restart the server to use them. Run this again whenever a feed starts failing.');
}

main().catch(e => { console.error(e); process.exit(1); });
