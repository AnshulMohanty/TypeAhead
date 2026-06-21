// Phase 5 demo: BASIC vs TRENDING ranking ka antar dikhata hai + decay proof.
// Yeh script DB me likhta hai (Phase 3 jaisa) — surged query ka count + recency badalta hai.
// Decay observable banane ke liye chhota half-life do, e.g.:
//     HALF_LIFE_SECONDS=1 npm run trending-demo
const config = require('../config');
const db = require('../src/db/db');
const { getSuggestionsRanked } = require('../src/services/suggestionService');
const { recordSearch } = require('../src/services/searchService');
const batchWriter = require('../src/services/batchWriter');
const { decay, nowSeconds } = require('../src/utils/recency');

const PREFIX = 'the';
const SURGE_QUERY = 'the zzqtrendingdemo';
const SURGE_TIMES = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printList(title, rows) {
  console.log(`\n${title}`);
  if (rows.length === 0) return console.log('  (empty)');
  rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.query}  (count=${r.count})`));
}

function rankOf(rows, query) {
  const i = rows.findIndex((r) => r.query === query);
  return i === -1 ? null : i + 1;
}

function decayedOf(query) {
  const row = db.prepare('SELECT trend_score, trend_ts FROM queries WHERE query = ?').get(query);
  return row ? decay(row.trend_score, row.trend_ts, nowSeconds()) : 0;
}

async function main() {
  const HL = config.HALF_LIFE_SECONDS;
  console.log('='.repeat(60));
  console.log(`TRENDING DEMO  (prefix="${PREFIX}", HALF_LIFE=${HL}s, ALPHA=${config.RECENCY_ALPHA})`);
  console.log('NOTE: writes to DB — surged query ka count/recency change hoga.');
  console.log('='.repeat(60));

  // 1) BEFORE: basic vs trending — fresh state me same order hona chahiye.
  printList('BASIC   (before surge):', getSuggestionsRanked(PREFIX, 'basic'));
  printList('TRENDING(before surge):', getSuggestionsRanked(PREFIX, 'trending'));

  // 2) Surge: ek low-count query ko prefix ke andar baar-baar search karo.
  console.log(`\n>> Surging "${SURGE_QUERY}" ${SURGE_TIMES}x ...`);
  for (let i = 0; i < SURGE_TIMES; i++) recordSearch(SURGE_QUERY);
  // Phase 6: surge ab buffer me hai — DB me dikhaane ke liye flush zaroori (eventual consistency).
  await batchWriter.flush();

  // 3) AFTER: trending me surged query upar aaya, basic me NAHI.
  const basicAfter = getSuggestionsRanked(PREFIX, 'basic');
  const trendAfter = getSuggestionsRanked(PREFIX, 'trending');
  printList('BASIC   (after surge):', basicAfter);
  printList('TRENDING(after surge):', trendAfter);
  console.log(
    `\n  -> "${SURGE_QUERY}" rank: BASIC=${rankOf(basicAfter, SURGE_QUERY) || 'not in top 10'}` +
      `  TRENDING=${rankOf(trendAfter, SURGE_QUERY) || 'not in top 10'}`
  );

  // 4) DECAY proof: absolute decayed recency har half-life pe aadhi hoti hai, eventually
  //    threshold (1e-6) ke neeche jaake trending se nikal jaati hai (= fall back down).
  console.log('\n--- DECAY over time (absolute decayed recency) ---');
  console.log(`  t+0         : decayed=${decayedOf(SURGE_QUERY).toExponential(3)}`);
  // Threshold cross karne tak ke half-lives (capped) — taaki demo bounded rahe.
  const needHalfLives = Math.min(40, Math.ceil(Math.log2(SURGE_TIMES / 1e-6)) + 1);
  for (let n = 1; n <= needHalfLives; n++) {
    await sleep(HL * 1000);
    const d = decayedOf(SURGE_QUERY);
    // Har half-life ka snapshot zyada na ho isliye kuch hi print karo + last.
    if (n <= 3 || d === 0 || n === needHalfLives) {
      console.log(`  t+${(n * HL).toString().padStart(2)}s (${n} half-lives): decayed=${d.toExponential(3)}`);
    }
    if (d === 0) break;
  }

  const trendDecayed = getSuggestionsRanked(PREFIX, 'trending');
  printList('TRENDING(after decay):', trendDecayed);

  // Summary.
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log(`  - Fresh state: basic == trending (recency sab 0).`);
  console.log(`  - Surge: "${SURGE_QUERY}" TRENDING me #${rankOf(trendAfter, SURGE_QUERY)} pe aaya,` +
    ` BASIC me ${rankOf(basicAfter, SURGE_QUERY) ? '#' + rankOf(basicAfter, SURGE_QUERY) : 'top-10 me bhi nahi'}.`);
  console.log(`  - Decay: recency har ${HL}s me aadhi; threshold cross hote hi trending se gayab` +
    ` (${rankOf(trendDecayed, SURGE_QUERY) ? 'still #' + rankOf(trendDecayed, SURGE_QUERY) : 'fell out -> back to count order'}).`);
  console.log('='.repeat(60));

  process.exit(0); // ioredis connections band karne ke liye explicit exit.
}

main().catch((e) => {
  console.error('trending-demo failed:', e);
  process.exit(1);
});
