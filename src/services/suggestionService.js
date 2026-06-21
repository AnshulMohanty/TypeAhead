const db = require('../db/db');
const config = require('../../config');
const { normalizeQuery } = require('../utils/normalize');
const { decay, nowSeconds } = require('../utils/recency');
const cacheClient = require('../cache/cacheClient');

const POOL_CAP = 100; // har candidate source se max 100 (10 return karne se kaafi zyada).

// Prepared statement ek baar bana ke reuse karte hain -> har request pe parse/compile nahi hota.
// LIKE ? ESCAPE '\\' -> user ke % aur _ ko literal treat karne ke liye (warna wo wildcard ban jaate).
const suggestStmt = db.prepare(
  `SELECT query, count FROM queries
   WHERE query LIKE ? ESCAPE '\\'
   ORDER BY count DESC
   LIMIT ?`
);

// Candidate pool (trending mode): top-by-count + top-by-recent dono ko milao taaki naya surging
// query bhi aa sake, sirf purane popular nahi.
const poolByCount = db.prepare(
  `SELECT query, count, trend_score, trend_ts FROM queries
   WHERE query LIKE ? ESCAPE '\\' ORDER BY count DESC LIMIT ?`
);
const poolByRecent = db.prepare(
  `SELECT query, count, trend_score, trend_ts FROM queries
   WHERE query LIKE ? ESCAPE '\\' AND trend_ts > 0 ORDER BY trend_ts DESC LIMIT ?`
);

// LIKE pattern me %, _ aur escape char khud ko literal banane ke liye escape karna padta hai.
function escapeLike(str) {
  return str.replace(/[\\%_]/g, '\\$&');
}

function getSuggestions(prefix) {
  // Read aur write SAME shared util se normalize -> mixed-case input ("NEW") same result de,
  // aur POST /search se likha hua query bhi yahin prefix-match me mile.
  const normalized = normalizeQuery(prefix);

  // Null/undefined/empty/whitespace -> normalized "" -> gracefully empty array, koi error nahi.
  if (!normalized) return [];

  // prefix% match index use karta hai (left-anchored), isliye fast hai. count DESC sorted, max 10.
  cacheClient.incrDbRead(); // direct SQLite read (cache miss pe hi yahan tak aate hain)
  return suggestStmt.all(escapeLike(normalized) + '%', config.SUGGESTION_LIMIT);
}

// Trending ranking: pool ko decay karo, dono signals ko 0–1 me normalize karke blend karte hain;
// ALPHA hi ekmaatra knob hai (kitna recency vs kitni all-time popularity). count millions me hai,
// recency chhota — bina normalize kiye recency ka koi asar hi nahi hota; isliye normalize-then-blend.
function rankTrending(prefix) {
  const like = escapeLike(prefix) + '%';
  const now = nowSeconds();

  // top-by-count UNION top-by-recent, dedup by query.
  cacheClient.incrDbRead(2); // do direct SQLite reads (count-pool + recent-pool)
  const pool = new Map();
  for (const r of poolByCount.all(like, POOL_CAP)) pool.set(r.query, r);
  for (const r of poolByRecent.all(like, POOL_CAP)) pool.set(r.query, r);
  const rows = [...pool.values()];
  if (rows.length === 0) return [];

  // har row ka decayed recency nikaalo, phir pool ke andar normalize karne ke liye max nikaalo.
  for (const r of rows) r._rec = decay(r.trend_score, r.trend_ts, now);
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const maxRec = Math.max(0, ...rows.map((r) => r._rec));

  const alpha = config.RECENCY_ALPHA;
  for (const r of rows) {
    const normCount = r.count / maxCount;
    const normRec = maxRec > 0 ? r._rec / maxRec : 0; // fresh state (sab rec 0) -> count order
    r._score = alpha * normCount + (1 - alpha) * normRec;
  }
  // score desc; tie pe count desc (deterministic, basic se consistent).
  rows.sort((a, b) => b._score - a._score || b.count - a.count);

  // Response rows me sirf query+count (blend internal ranking hai).
  return rows.slice(0, config.SUGGESTION_LIMIT).map((r) => ({ query: r.query, count: r.count }));
}

// mode "basic" -> DB count-desc (Phase 1 unchanged). mode "trending" -> recency-aware blend.
function getSuggestionsRanked(prefix, mode) {
  const normalized = normalizeQuery(prefix);
  if (!normalized) return [];
  if (mode === 'basic') return getSuggestions(normalized);
  return rankTrending(normalized);
}

// Phase 4+5: cache-first read path (per-mode) — pehle cache, miss pe DB, phir cache bharo.
async function getSuggestionsCached(prefix, mode) {
  const normalized = normalizeQuery(prefix);
  if (!normalized) return []; // empty -> koi cache call hi nahi.

  const cached = await cacheClient.getSuggestions(normalized, mode);
  if (cached !== null) return cached; // hit

  // Miss: DB se rank karo, phir us prefix+mode ka owning node populate karo.
  const result = getSuggestionsRanked(normalized, mode);
  await cacheClient.setSuggestions(normalized, mode, result);
  return result;
}

module.exports = { getSuggestions, getSuggestionsRanked, getSuggestionsCached };
