// News sources: direct outlet feeds plus Google News searches, and the RSS/Atom parser they share.
const fs = require('fs');
const path = require('path');

const UA = process.env.FEED_UA || 'Mozilla/5.0 (compatible; CrimeRadarMY/0.1)';
const FEEDS_FILE = path.join(__dirname, '..', 'data', 'feeds.json');

// Used until `npm run check-feeds` has written data/feeds.json from what works on your machine.
const DEFAULT_FEEDS = [
  { name: 'Malay Mail', url: 'https://www.malaymail.com/feed/rss/malaysia' },
  { name: 'Free Malaysia Today', url: 'https://www.freemalaysiatoday.com/category/nation/feed/' },
  { name: 'Bernama', url: 'https://www.bernama.com/en/rssfeed.php' },
  { name: 'Harian Metro', url: 'https://www.hmetro.com.my/utama.xml' },
  { name: 'Malaysiakini', url: 'https://www.malaysiakini.com/rss/en/news.rss' },
];

// Google News searches scoped to Malaysia. Each returns up to 100 stories from every outlet Google
// indexes, including local and regional ones that have no usable feed of their own (Harian Metro's
// state pages, Kosmo, Sinar Harian, Utusan Borneo, Daily Express, Borneo Post, Buletin TV3…).
// Searches are limited by date with after:/before:, using this computer's date.
const { windowStart, ymd } = require('../lib/window');
const gn = (q, lang) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
  (lang === 'ms' ? '&hl=ms&gl=MY&ceid=MY:ms' : '&hl=en-MY&gl=MY&ceid=MY:en');
const BASE_SEARCHES = [
  { name: 'BM, kekerasan', q: 'ragut OR samun OR rompak OR dirompak OR ditikam OR ditembak OR dibunuh OR diculik', lang: 'ms' },
  { name: 'BM, harta benda', q: '"pecah rumah" OR "pecah masuk" OR dicuri OR "curi motosikal" OR "curi kereta" OR khianat', lang: 'ms' },
  { name: 'EN, violent', q: 'robbery OR "snatch theft" OR stabbed OR "shot dead" OR murdered OR kidnapped Malaysia', lang: 'en' },
  { name: 'EN, property', q: '"break-in" OR burglary OR "house break-in" OR "stolen car" OR "stolen motorcycle" OR "vehicle theft" Malaysia', lang: 'en' },
];
// One search per state, in Malay, to reach local outlets and state sections that the national
// searches crowd out.
const STATES = ['Selangor', 'Kuala Lumpur', 'Johor', 'Pulau Pinang', 'Perak', 'Kedah', 'Kelantan', 'Terengganu', 'Pahang',
  'Negeri Sembilan', 'Melaka', 'Perlis', 'Sabah', 'Sarawak', 'Labuan'];
const STATE_SEARCHES = STATES.map(st => ({ name: `BM, ${st}`,
  q: `(ragut OR samun OR rompak OR "pecah rumah" OR curi OR dibunuh OR ditikam) "${st}"`, lang: 'ms' }));
const SEARCHES = [...BASE_SEARCHES, ...STATE_SEARCHES];

const between = (s, from, to) => ({ name: `Google News (${s.name})`,
  url: gn(`${s.q} after:${ymd(from)} before:${ymd(to)}`, s.lang) });
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Regular pulls: the last three days (before: is exclusive, so it's set to tomorrow).
function recentSearches(now = new Date()) {
  return SEARCHES.map(s => between(s, addDays(now, -3), addDays(now, 1)));
}
// Backfill: the two-month window in weekly slices, since each search returns at most 100 stories.
// Returns [{ key, searches }] for each week; a week is marked done in data/backfill.json once fetched.
function backfillWeeks(now = new Date()) {
  const weeks = [];
  for (let from = windowStart(now); from < addDays(now, -3); from = addDays(from, 7)) {
    const to = addDays(from, 7) < addDays(now, -2) ? addDays(from, 7) : addDays(now, -2);
    weeks.push({ key: ymd(from), searches: SEARCHES.map(s => between(s, from, to)) });
  }
  return weeks;
}
// Kept for the check scripts: one recent search of each base type.
const GOOGLE_NEWS = recentSearches().slice(0, BASE_SEARCHES.length);

// Candidates for the feed checker. Paths are best guesses; the checker also reads each
// outlet's pages for the RSS links they advertise, and keeps only feeds that return items.
const CANDIDATES = [
  ...DEFAULT_FEEDS,
  { name: 'Bernama BM', url: 'https://www.bernama.com/bm/rssfeed.php' },
  { name: 'Malaysiakini BM', url: 'https://www.malaysiakini.com/rss/my/news.rss' },
  { name: 'Utusan Malaysia', url: 'https://www.utusan.com.my/feed/' },
  { name: 'Kosmo', url: 'https://www.kosmo.com.my/feed/' },
  { name: 'NST Crime & Courts', url: 'https://www.nst.com.my/news/crime-courts.xml' },
  { name: 'Berita Harian Kes', url: 'https://www.bharian.com.my/berita/kes.xml' },
  { name: 'Harian Metro Mutakhir', url: 'https://www.hmetro.com.my/mutakhir.xml' },
  { name: 'The Vibes', url: 'https://www.thevibes.com/feed' },
  // Local and regional outlets. Most run WordPress, where /feed/ is the standard path.
  { name: 'Borneo Post', url: 'https://www.theborneopost.com/feed/' },
  { name: 'Utusan Borneo', url: 'https://www.utusanborneo.com.my/feed' },
  { name: 'New Sarawak Tribune', url: 'https://www.newsarawaktribune.com.my/feed/' },
  { name: 'Dayak Daily', url: 'https://dayakdaily.com/feed/' },
  { name: 'Utusan Sarawak', url: 'https://utusansarawak.com.my/feed/' },
  { name: 'Daily Express Sabah', url: 'https://www.dailyexpress.com.my/rss/' },
  { name: 'Buletin Mutiara (Penang)', url: 'https://www.buletinmutiara.com/feed/' },
  { name: 'Selangor Journal', url: 'https://selangorjournal.my/feed/' },
  { name: 'Selangorkini', url: 'https://selangorkini.my/feed/' },
  { name: 'Johor Buzz', url: 'https://johorbuzz.com.my/feed/' },
  { name: 'Sinar Harian Semasa', url: 'https://www.sinarharian.com.my/rssFeed/211' },
  { name: 'Harian Metro Setempat', url: 'https://www.hmetro.com.my/setempat.xml' },
];
const DISCOVER_PAGES = [
  { name: 'The Star', url: 'https://www.thestar.com.my/news/nation' },
  { name: 'NST', url: 'https://www.nst.com.my/news/crime-courts' },
  { name: 'Berita Harian', url: 'https://www.bharian.com.my/berita/kes' },
  { name: 'Harian Metro', url: 'https://www.hmetro.com.my/mutakhir' },
  { name: 'Sinar Harian', url: 'https://www.sinarharian.com.my/' },
  { name: 'Kosmo', url: 'https://www.kosmo.com.my/' },
  { name: 'Utusan Malaysia', url: 'https://www.utusan.com.my/' },
  { name: 'Astro Awani', url: 'https://www.astroawani.com/' },
  { name: 'The Sun', url: 'https://thesun.my/' },
  { name: 'Buletin TV3', url: 'https://www.buletintv3.my/' },
  { name: 'Borneo Post', url: 'https://www.theborneopost.com/' },
  { name: 'Daily Express Sabah', url: 'https://www.dailyexpress.com.my/' },
  { name: 'Utusan Borneo', url: 'https://www.utusanborneo.com.my/' },
  { name: 'New Sarawak Tribune', url: 'https://www.newsarawaktribune.com.my/' },
  { name: 'Utusan Sarawak', url: 'https://utusansarawak.com.my/' },
  { name: 'Buletin Mutiara', url: 'https://www.buletinmutiara.com/' },
  { name: 'Selangor Journal', url: 'https://selangorjournal.my/' },
];

const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Parses RSS 2.0 <item> and Atom <entry> elements.
function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map(m => m[0]);
  return blocks.map(b => {
    const tag = t => { const m = b.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`)); return m ? decode(m[1]) : ''; };
    const atomLink = (b.match(/<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/) || b.match(/<link\b[^>]*href="([^"]+)"/) || [])[1];
    let title = tag('title');
    let outlet = tag('source') || null; // Google News names the original outlet here
    if (outlet && title.endsWith(` - ${outlet}`)) title = title.slice(0, -(outlet.length + 3));
    title = title.replace(/\s+\|\s+[^|]{2,30}$/, ''); // "Headline | Sinar Harian"
    let summary = (tag('description') || tag('summary') || tag('content'));
    // Google News descriptions are "<headline>  <outlet>"; drop the outlet so it isn't read as a place.
    if (outlet && summary.endsWith(outlet)) summary = summary.slice(0, -outlet.length).trim();
    title = title.replace(/^[A-Za-z &]+ : /, ''); // Bernama prefixes "Category : "
    return {
      title, outlet,
      link: tag('link') || (atomLink || '').replace(/&amp;/g, '&'),
      summary: summary.slice(0, 400),
      publishedAt: tag('pubDate') || tag('published') || tag('updated') || tag('dc:date'),
    };
  }).filter(i => i.title && i.link);
}

async function fetchFeed(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 2000))) throw new Error('not a feed');
  return parseFeed(text);
}

// Verified outlet feeds from the checker, or the defaults, plus the recent Google News searches.
function activeFeeds(now = new Date()) {
  let feeds = DEFAULT_FEEDS;
  try { feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8')).feeds; } catch {}
  feeds = feeds.map(f => ({ ...f, name: f.name.replace(/\s*(&raquo;|&#187;|»)\s*/g, ' ').trim() }));
  return process.env.GOOGLE_NEWS === 'off' ? feeds : [...feeds, ...recentSearches(now)];
}

module.exports = { DEFAULT_FEEDS, GOOGLE_NEWS, CANDIDATES, DISCOVER_PAGES, FEEDS_FILE, UA, parseFeed, fetchFeed, activeFeeds,
  recentSearches, backfillWeeks, SEARCHES };
