// Fills the two-month window in one go instead of over several scheduled runs.
//   npm run backfill
// Stop it any time with Ctrl+C; progress is saved and the server carries on from there.
const { runIngest } = require('./run');
(async () => {
  for (let round = 1; ; round++) {
    console.log(`\n--- round ${round} ---`);
    const r = await runIngest();
    if (!r.queued && !r.backfillLeft) { console.log('\nBackfill complete: the last two months are loaded.'); break; }
  }
})().catch(e => { console.error(e); process.exit(1); });
