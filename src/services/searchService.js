const { normalizeQuery } = require('../utils/normalize');
const batchWriter = require('./batchWriter');

// Phase 6: ab synchronous DB write nahi — recordSearch sirf buffer me ENQUEUE karta hai.
// Actual count-upsert + recency update + cache invalidation sab FLUSH time pe hote hain
// (batchWriter me). Yahi woh long-marked Phase-6 WRITE SEAM ka realization hai.
function recordSearch(query) {
  // Read aur write dono SAME util se normalize -> likha hua query baad me prefix-match me milega.
  const normalized = normalizeQuery(query);

  // Buffer me daalo (write-behind). DB yahan touch nahi hoti, invalidation bhi flush pe hogi.
  batchWriter.enqueue(normalized);

  // count abhi DB me nahi gaya; DB-count + buffer pending delta = approximate read-your-writes count.
  const count = batchWriter.approxCount(normalized);

  // EVENTUAL CONSISTENCY: yeh search /suggest aur /trending me agle flush ke baad hi dikhega
  // (<= FLUSH_INTERVAL_MS, ya size-trigger pe pehle). Assignment "eventually reflected" allow karta hai.
  return { query: normalized, count };
}

module.exports = { recordSearch };
