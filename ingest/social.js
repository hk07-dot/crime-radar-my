// Social media sources. Each returns raw items in the same shape as news items:
//   { title, summary, link, publishedAt, source: 'social', outlet }
//
// What can be read, and how:
//   Bluesky  – open post search. Works without an account when Bluesky allows it; otherwise set
//              BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (Settings → Privacy and security → App passwords).
//   Mastodon – public hashtag timelines, no account needed. Few Malaysian users, so low volume.
//   Reddit   – needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET from an approved Reddit app.
//              Logged-out JSON is blocked and Reddit's RSS feeds end on 13 Nov 2026.
// X, Facebook, Instagram, TikTok and Threads have no free search access, so they aren't included.
//
// Only the post text, time and link are kept. Usernames are never stored, and phone numbers,
// car plates, @handles and links are masked in the stored text (see mask()).
const DEBUG = process.env.DEBUG_INGEST === '1';
const UA = process.env.GEOCODER_UA || 'CrimeRadarMY/0.1';
const { windowStart } = require('../lib/window');
const notices = new Set();
const noticeOnce = (key, msg) => { if (!notices.has(key)) { notices.add(key); console.log(msg); } };

// Masks details that could identify or accuse a private person. Run after place extraction.
function mask(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(^|\s)@[\w.-]+/g, '$1@…')
    .replace(/(\+?6?0)?1\d[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '[phone]')
    .replace(/\b(0\d)[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '[phone]')
    // Malaysian plates: "WXY 1234", "VBA1234A", "JTD 88". Places like "SS 15" or "Seksyen 7" don't match (need 3 letters or a suffix letter).
    .replace(/\b[A-Z]{3}\s?\d{1,4}[A-Z]?\b|\b[A-Z]{1,2}\s?\d{1,4}[A-Z]\b/g, '[plate]')
    .replace(/\s+/g, ' ').trim();
}

// Splits a post into a short title and the rest.
function toItem({ text, link, createdAt, outlet }) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const cut = clean.length <= 140 ? clean.length : (clean.slice(0, 140).lastIndexOf(' ') > 60 ? clean.slice(0, 140).lastIndexOf(' ') : 140);
  return { title: clean.slice(0, cut) + (cut < clean.length ? '…' : ''), summary: clean.slice(cut, 600).trim(), fullText: clean,
    link, publishedAt: createdAt, source: 'social', outlet };
}

// ---------- Bluesky ----------
const BLUESKY_QUERIES = ['ragut', 'diragut', 'kena rompak', 'kena samun', 'pecah rumah', 'kena curi', 'kereta dicuri', 'motor kena curi',
  'snatch theft Malaysia', 'robbed KL', 'break-in Malaysia', 'snatch thief'];
let bskyToken = null, bskyTokenAt = 0;

async function bskySession() {
  const id = process.env.BLUESKY_HANDLE, pw = process.env.BLUESKY_APP_PASSWORD;
  if (!id || !pw) return null;
  if (bskyToken && Date.now() - bskyTokenAt < 60 * 60e3) return bskyToken;
  const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ identifier: id, password: pw }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Bluesky sign-in failed: HTTP ${res.status}`);
  bskyToken = (await res.json()).accessJwt;
  bskyTokenAt = Date.now();
  return bskyToken;
}

async function bskySearch(q, token) {
  const params = new URLSearchParams({ q, limit: '100', sort: 'latest', since: windowStart().toISOString() });
  const host = token ? 'https://bsky.social' : 'https://public.api.bsky.app';
  const res = await fetch(`${host}/xrpc/app.bsky.feed.searchPosts?${params}`, {
    headers: { 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return (await res.json()).posts || [];
}

async function fetchBluesky() {
  if (process.env.BLUESKY === 'off') return [];
  const out = [];
  let token = null;
  try { token = await bskySession(); } catch (e) { console.warn('[social]', e.message); }
  for (const q of BLUESKY_QUERIES) {
    let posts;
    try { posts = await bskySearch(q, token); }
    catch (e) {
      if ((e.status === 401 || e.status === 403) && !token) {
        noticeOnce('bsky', `[social] Bluesky search needs an account right now (HTTP ${e.status}). Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD to enable it.`);
        return out;
      }
      console.warn(`[social] Bluesky "${q}" failed: ${e.message}`);
      continue;
    }
    for (const p of posts) {
      const rkey = (p.uri || '').split('/').pop();
      if (!p.record?.text || !rkey) continue;
      // The link uses the author's DID, not their handle; it's needed so a reader can check the source.
      out.push(toItem({ text: p.record.text, link: `https://bsky.app/profile/${p.author?.did}/post/${rkey}`,
        createdAt: p.record.createdAt || p.indexedAt, outlet: 'Bluesky' }));
    }
    if (DEBUG) console.log(`  [social] Bluesky "${q}": ${posts.length} posts`);
  }
  return out;
}

// ---------- Mastodon ----------
const MASTODON_INSTANCES = (process.env.MASTODON_INSTANCES || 'mastodon.social').split(',').map(s => s.trim()).filter(Boolean);
const MASTODON_TAGS = ['jenayah', 'ragut', 'rompakan', 'kualalumpur', 'malaysia', 'penang', 'johorbahru'];
const stripHtml = s => s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function fetchMastodon() {
  if (process.env.MASTODON === 'off') return [];
  const out = [], since = windowStart().getTime();
  for (const host of MASTODON_INSTANCES) for (const tag of MASTODON_TAGS) {
    try {
      const res = await fetch(`https://${host}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const statuses = await res.json();
      for (const s of statuses) {
        if (Date.parse(s.created_at) < since || s.reblog || !s.content) continue;
        out.push(toItem({ text: stripHtml(s.content), link: s.url || s.uri, createdAt: s.created_at, outlet: `Mastodon #${tag}` }));
      }
      if (DEBUG) console.log(`  [social] ${host} #${tag}: ${statuses.length} posts`);
    } catch (e) { console.warn(`[social] ${host} #${tag} failed: ${e.message}`); }
  }
  return out;
}

// ---------- Reddit (approved apps only) ----------
const REDDIT_SUBS = ['malaysia', 'kualalumpur', 'Penang', 'johorbahru'];
const REDDIT_QUERY = 'robbery OR snatch OR theft OR ragut OR rompak OR curi OR "break in" OR stabbed';
let redditToken = null, redditTokenExp = 0;

async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (redditToken && Date.now() < redditTokenExp) return redditToken;
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { 'User-Agent': UA, Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Reddit token request failed: HTTP ${res.status}`);
  const j = await res.json();
  redditToken = j.access_token;
  redditTokenExp = Date.now() + (j.expires_in - 60) * 1000;
  return redditToken;
}

async function fetchReddit() {
  const out = [];
  let token;
  try { token = await getRedditToken(); } catch (e) { console.warn('[social]', e.message); return out; }
  if (!token) { noticeOnce('reddit', '[social] Reddit skipped: needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET from an approved Reddit app'); return out; }
  for (const sub of REDDIT_SUBS) {
    try {
      const q = new URLSearchParams({ q: REDDIT_QUERY, restrict_sr: '1', sort: 'new', t: 'week', limit: '50', raw_json: '1' });
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/search?${q.toString().replace('t=week', 't=month')}`, { headers: { 'User-Agent': UA, Authorization: `bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const { data: p } of (await res.json()).data.children) {
        out.push({ title: p.title, summary: (p.selftext || '').slice(0, 400), fullText: `${p.title}. ${p.selftext || ''}`,
          link: `https://www.reddit.com${p.permalink}`, publishedAt: new Date(p.created_utc * 1000).toISOString(),
          source: 'social', outlet: `r/${sub}` });
      }
    } catch (e) { console.warn(`[social] r/${sub} failed: ${e.message}`); }
  }
  return out;
}

async function fetchSocial() {
  const [b, m, r] = await Promise.all([fetchBluesky(), fetchMastodon(), fetchReddit()]);
  return [...b, ...m, ...r];
}

module.exports = { fetchSocial, fetchBluesky, fetchMastodon, fetchReddit, mask, toItem };
