// Phase 6 demo: write-behind batching ka DB-write reduction + crash-loss window dikhata hai.
// Yeh script DB me likhta hai (prior demos jaisa). Timer start NAHI karta — sirf size-trigger +
// manual flush, taaki numbers deterministic rahein.
const config = require('../config');
const { recordSearch } = require('../src/services/searchService');
const batchWriter = require('../src/services/batchWriter');

const TOTAL = 5000;
const NUM_DISTINCT = 30; // heavy repetition, real traffic jaisa (chhota distinct set)

async function main() {
  console.log('='.repeat(64));
  console.log(`BATCH WRITE-REDUCTION DEMO  (BATCH_SIZE=${config.BATCH_SIZE}, FLUSH_INTERVAL_MS=${config.FLUSH_INTERVAL_MS})`);
  console.log(`NOTE: writes to DB. Firing ${TOTAL} searches over ${NUM_DISTINCT} distinct queries.`);
  console.log('='.repeat(64));

  const before = batchWriter.stats();

  // Realistic stream: heavy repetition. % NUM_DISTINCT se har size-window me saare distinct aate hain.
  for (let i = 0; i < TOTAL; i++) {
    recordSearch(`demo query ${i % NUM_DISTINCT}`); // size-trigger flush enqueue ke andar hota hai
  }
  // Bacha hua (last partial batch) flush kar do.
  await batchWriter.flush();

  const after = batchWriter.stats();
  const searches = after.searchesEnqueued - before.searchesEnqueued;
  const upserts = after.dbUpserts - before.dbUpserts;
  const txns = after.txns - before.txns;
  const naive = TOTAL; // bina batching ke: har search = 1 DB write (1 txn)

  console.log('\n--- WRITE REDUCTION ---');
  console.log(`  searches enqueued : ${searches}`);
  console.log(`  DB upserts written: ${upserts}   (distinct-query writes)`);
  console.log(`  flush transactions: ${txns}`);
  console.log(`  naive (per-search): ${naive} writes across ${naive} txns`);
  console.log(
    `  REDUCTION         : ${searches} searches -> ${upserts} upserts across ${txns} txns ` +
      `= ${(searches / upserts).toFixed(1)}x fewer row-writes, ${(naive / txns).toFixed(0)}x fewer transactions`
  );
  console.log('  (reduction = aggregation of repeats  +  batching distinct queries per txn)');

  // ---- CRASH-LOSS WINDOW ----
  console.log('\n--- CRASH-LOSS WINDOW ---');
  const N = 17;
  for (let i = 0; i < N; i++) recordSearch(`crashloss demo ${i % 5}`);
  const buffered = batchWriter.stats().buffered;
  console.log(`  buffered (un-flushed) increments now: ${buffered}`);
  console.log(
    `  >> hard crash abhi hua toh ye ${buffered} buffered increments kho jaate; clean shutdown ya ` +
      `agla flush inhe bacha leta.`
  );
  console.log(
    `  >> Max loss <= BATCH_SIZE (${config.BATCH_SIZE}) increments YA < FLUSH_INTERVAL_MS ` +
      `(${config.FLUSH_INTERVAL_MS}ms) ka traffic.`
  );
  await batchWriter.flush();
  console.log(`  after flush, buffered = ${batchWriter.stats().buffered}  (loss window closed)`);

  console.log('\n' + '='.repeat(64));
  console.log('SUMMARY: batching ne DB writes ko bahut kam kiya bina koi count khoye (eventual');
  console.log('consistency). Loss sirf hard-crash ke un-flushed window me — clean stop pe zero.');
  console.log('='.repeat(64));

  process.exit(0);
}

main().catch((e) => {
  console.error('batch-demo failed:', e);
  process.exit(1);
});
