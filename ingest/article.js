// Reads the opening line of a news article, used only to find where a crime happened when the
// headline doesn't say. Malaysian outlets open with a dateline ("KULAI: Empat lelaki…"), and the
// page's description tag usually carries that line. Nothing read here is stored or shown.
const { UA } = require('./sources');

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const meta = (html, name) => {
  const re = new RegExp(`<meta\\b[^>]*(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  const content = tag && (tag.match(/content=["']([^"']*)["']/i) || [])[1];
  return content ? decode(content) : '';
};

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { url: res.url || url, html: (await res.text()).slice(0, 400000) };
}

const DEBUG = process.env.DEBUG_INGEST === '1';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ms-MY,ms;q=0.9,en;q=0.8',
};
const isGoogleNews = u => /(^|\.)news\.google\.com$/.test(new URL(u).host);

// Google News RSS links are encoded wrappers (news.google.com/rss/articles/<id>). The article page
// carries a signature and timestamp that Google's own site exchanges for the real URL. This is
// unofficial, the same method open-source decoders use, and may stop working if Google changes it.
let lastGoogle = 0;
async function decodeGoogleNews(url) {
  // Space Google requests about a second apart so a large pull isn't rate-limited.
  const wait = lastGoogle + 1200 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGoogle = Date.now();
  const id = (new URL(url).pathname.match(/\/articles\/([^/?]+)/) || [])[1];
  if (!id) return null;
  // The signature sits on one of two page forms, and Google may serve a bare page to non-browser clients.
  let sg, ts, tried = [];
  for (const pageUrl of [`https://news.google.com/rss/articles/${id}?oc=5`, `https://news.google.com/articles/${id}?hl=ms&gl=MY&ceid=MY:ms`]) {
    let res, html = '';
    try {
      res = await fetch(pageUrl, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow' });
      html = await res.text();
    } catch (e) { tried.push(`${e.message}`); continue; }
    const direct = (html.match(/data-n-au=["']([^"']+)["']/) || [])[1];
    if (direct) return decode(direct);
    sg = (html.match(/data-n-a-sg=["']([^"']+)["']/) || [])[1];
    ts = (html.match(/data-n-a-ts=["']([^"']+)["']/) || [])[1];
    if (sg && ts) break;
    const title = decode((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const host = (() => { try { return new URL(res.url || pageUrl).host; } catch { return '?'; } })();
    tried.push(`HTTP ${res.status} from ${host}, ${html.length} bytes, title "${title.slice(0, 40)}"`);
  }
  if (!sg || !ts) {
    if (DEBUG) console.log(`    [google news] no signature for ${id.slice(0, 12)}…: ${tried.join(' | ')}`);
    return null;
  }
  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`;
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Referer: 'https://news.google.com/' },
  });
  if (!res.ok) { if (DEBUG) console.log(`    [google news] decode HTTP ${res.status}`); return null; }
  const text = await res.text();
  // Response: ")]}'" then a blank line, then a JSON array whose entries hold JSON strings.
  const chunk = text.split('\n\n')[1] || text.replace(/^\)\]\}'\s*/, '');
  try {
    for (const entry of JSON.parse(chunk)) {
      if (entry[0] === 'wrb.fr' && typeof entry[2] === 'string') {
        const target = JSON.parse(entry[2])[1];
        if (typeof target === 'string' && /^https?:\/\//.test(target)) return target;
      }
    }
  } catch {}
  // Fallback: find the first non-Google URL in the response.
  const m = text.match(/https?:\/\/(?![\w.-]*google\.)[^"\\\s]+/);
  return m ? m[0] : null;
}

// Follows redirects; resolves Google News wrappers to the outlet's article.
async function resolve(url) {
  if (isGoogleNews(url)) {
    const target = await decodeGoogleNews(url);
    return target ? get(target) : null;
  }
  return get(url);
}

// Returns { text, url } where url is the outlet's own article link (Google News wrappers resolved).
async function articleLead(link) {
  try {
    const page = await resolve(link);
    if (!page) return { text: '', url: null };
    // The description is sometimes a teaser without the dateline ("PERGELUTAN yang berlaku…"),
    // so add the first two body paragraphs, which carry it.
    const desc = meta(page.html, 'og:description') || meta(page.html, 'description') || meta(page.html, 'twitter:description');
    const paras = [...page.html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => decode(m[1])).filter(t => t.length > 60).slice(0, 2);
    const parts = [desc, ...paras.filter(p => !desc.includes(p.slice(0, 50)))].filter(Boolean);
    return { text: parts.join('. ').slice(0, 700), url: page.url };
  } catch {
    return { text: '', url: null };
  }
}

module.exports = { articleLead };
