// One scheduled update on GitHub Actions: collect news and social reports, then rebuild the site data.
//   node scripts/update.js
const { runIngest } = require('../ingest/run');
const { build } = require('./build-static');
(async () => {
  try { await runIngest(); }
  catch (e) { console.error('[update] collecting failed, publishing the data we already have:', e.message); }
  await build();
})().catch(e => { console.error(e); process.exit(1); });
