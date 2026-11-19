// Shows which social sources work from this machine and what they would add.
//   npm run check-social
const { fetchBluesky, fetchMastodon, fetchReddit } = require('./social');
const { classify } = require('./extract');

(async () => {
  for (const [name, fn] of [['Bluesky', fetchBluesky], ['Mastodon', fetchMastodon], ['Reddit', fetchReddit]]) {
    const t0 = Date.now();
    const items = await fn();
    const crime = items.filter(i => classify(i.fullText || i.title));
    console.log(`\n${name}: ${items.length} posts from the last two months, ${crime.length} mention a crime (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    for (const i of crime.slice(0, 5)) console.log(`  · ${classify(i.fullText || i.title).padEnd(13)} ${i.title.slice(0, 90)}`);
  }
  console.log('\nOnly posts that describe something that happened and name a Malaysian place become pins. Run `npm start` to ingest.');
})().catch(e => { console.error(e); process.exit(1); });
