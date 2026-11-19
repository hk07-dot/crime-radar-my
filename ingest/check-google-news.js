// Checks whether Google News links can be resolved to outlet articles from this machine.
//   npm run check-google-news
process.env.DEBUG_INGEST = '1'; // show why a link fails
const { GOOGLE_NEWS, fetchFeed } = require('./sources');
const { articleLead } = require('./article');

(async () => {
  const items = (await fetchFeed(GOOGLE_NEWS[0].url)).slice(0, 5);
  console.log(`Trying ${items.length} stories from "${GOOGLE_NEWS[0].name}"…\n`);
  let ok = 0;
  for (const it of items) {
    const lead = await articleLead(it.link);
    const resolved = lead.url && !/news\.google\.com/.test(lead.url);
    if (resolved) ok++;
    console.log(`${resolved ? '✓' : '✗'} ${it.title.slice(0, 70)}`);
    console.log(`   ${resolved ? lead.url : 'could not resolve'}`);
    if (lead.text) console.log(`   opening: ${lead.text.slice(0, 90)}…`);
  }
  console.log(`\n${ok} of ${items.length} resolved.` + (ok ? '' : ' Google News stories will be mapped only when the headline names a place.'));
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
