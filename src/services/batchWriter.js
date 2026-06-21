const db = require('../db/db');
const config = require('../../config');
const { decay, nowSeconds } = require('../utils/recency');
const cacheClient = require('../cache/cacheClient');

// ---------------------------------------------------------------------------
// WRITE-BEHIND BATCH WRITER (Phase 6 — yahi long-marked WRITE SEAM ka realization hai).
// har search pe DB likhna mehenga; buffer me daalo, baad me ek saath likho (write-behind).
//
// Alternative considered = SAMPLING: sampling writes kam karta hai par data loss karke (kuch
// searches ginte hi nahi); batching counts kabhi nahi khota — sirf flush tak delay karta hai.
// Humein eventual consistency allowed hai, isliye batching better fit hai. (Sampling implement
// NAHI kiya.)
// ---------------------------------------------------------------------------

// BUFFER = Map<normalizedQuery, deltaCount>. Aggregation = delta ko increment karo.
// Node single-threaded hai + better-sqlite3 sync hai, isliye lock ki zarurat nahi —
// enqueue aur flush ka DB-write part kabhi interleave nahi karte (flush atomically chalta hai).
let buffer = new Map();
let bufferedTotal = 0; // is buffer me total searches (sum of deltas) — size-trigger ke liye O(1).

const counters = {
  searchesEnqueued: 0, // ab tak total searches buffer me daale gaye
  flushes: 0,          // kitni baar flush hua
  txns: 0,             // kitni flush transactions (== flushes; alag rakha clarity ke liye)
  dbUpserts: 0,        // total distinct-query upserts DB me likhe gaye
};

let timer = null;

// ---- DB statements (logic Phase-3/5 ke sync write se yahan move hui) ----
const selectRow = db.prepare(`SELECT count, trend_score, trend_ts FROM queries WHERE query = ?`);

// count = count + delta; recency batched (decayed + delta) — excluded.* se insert/update dono apply.
const upsertStmt = db.prepare(`
  INSERT INTO queries (query, count, trend_score, trend_ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(query) DO UPDATE SET
    count = count + excluded.count,
    trend_score = excluded.trend_score,
    trend_ts = excluded.trend_ts
`);

// Query ke saare prefixes (length 1..len) — sirf inhi prefixes ka cached top-10 badal sakta hai.
function prefixesOf(query) {
  const list = [];
  for (let i = 1; i <= query.length; i++) list.push(query.slice(0, i));
  return list;
}

// saari upserts ek hi transaction me — yahi DB write reduction ka core hai.
const flushTxn = db.transaction((entries, now) => {
  for (const [query, delta] of entries) {
    const row = selectRow.get(query);
    // batch window chhota (seconds) hai aur half-life bada (3600s), isliye window-ke-andar ka
    // decay ignore karke +delta lagana negligible error hai.
    const newTrend = decay(row ? row.trend_score : 0, row ? row.trend_ts : 0, now) + delta;
    upsertStmt.run(query, delta, newTrend, now);
  }
});

function dbCount(query) {
  cacheClient.incrDbRead(); // approx-count ke liye direct SQLite read
  const row = selectRow.get(query);
  return row ? row.count : 0;
}

function pending(query) {
  return buffer.get(query) || 0; // O(1) buffer peek
}

// count abhi DB me nahi gaya; DB-count + buffer ka pending delta jodke approximate
// (read-your-writes) count dikha do.
function approxCount(query) {
  return dbCount(query) + pending(query);
}

function enqueue(normalizedQuery) {
  buffer.set(normalizedQuery, (buffer.get(normalizedQuery) || 0) + 1);
  bufferedTotal++;
  counters.searchesEnqueued++;
  // SIZE TRIGGER: total buffered searches BATCH_SIZE tak pahunche -> turant flush (timer ka wait nahi).
  if (bufferedTotal >= config.BATCH_SIZE) {
    void flush().catch(() => {}); // fire-and-forget; DB-write part sync hai, invalidation async.
  }
}

async function flush() {
  // SNAPSHOT-THEN-WRITE: pehle buffer swap karo phir likho, taaki write ke during aane wale naye
  // searches agle batch me jaayein.
  if (buffer.size === 0) return { searches: 0, distinct: 0, flushed: false };
  const snapshot = buffer;
  const snapTotal = bufferedTotal;
  buffer = new Map();
  bufferedTotal = 0;

  const now = nowSeconds();
  const entries = [...snapshot.entries()];

  // ONE transaction = saari upserts atomically.
  flushTxn(entries, now);
  counters.flushes++;
  counters.txns++;
  counters.dbUpserts += snapshot.size;

  // INVALIDATION AT FLUSH (NOT enqueue): warna cache miss DB se purana (bina-update) data wapas
  // bhar deta. Poore batch ke prefixes ka UNION dedup karke ek hi baar both-mode clear karo.
  const prefixSet = new Set();
  for (const query of snapshot.keys()) {
    for (const p of prefixesOf(query)) prefixSet.add(p);
  }
  await cacheClient.invalidatePrefixes([...prefixSet]);
  await cacheClient.invalidateTrending(); // trending:global bhi stale -> DEL

  return { searches: snapTotal, distinct: snapshot.size, flushed: true };
}

function start() {
  if (timer) return;
  // TIME TRIGGER: har FLUSH_INTERVAL_MS pe flush (size-trigger jo pehle aaye).
  timer = setInterval(() => void flush().catch(() => {}), config.FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref(); // process exit ko block na kare (scripts ke liye)
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function stats() {
  const ratio = counters.dbUpserts > 0 ? +(counters.searchesEnqueued / counters.dbUpserts).toFixed(2) : null;
  return {
    ...counters,
    buffered: bufferedTotal,
    bufferedDistinct: buffer.size,
    reductionRatio: ratio, // searchesEnqueued : dbUpserts
  };
}

module.exports = { enqueue, flush, start, stop, stats, approxCount, prefixesOf };
