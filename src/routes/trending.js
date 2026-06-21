const express = require('express');
const db = require('../db/db');
const config = require('../../config');
const cacheClient = require('../cache/cacheClient');
const { decay, nowSeconds } = require('../utils/recency');

const router = express.Router();

// Global hot pool: sirf woh queries jinpe recent activity hai (trend_ts > 0). idx_trend_ts use hota hai.
const trendingPool = db.prepare(
  `SELECT query, count, trend_score, trend_ts FROM queries
   WHERE trend_ts > 0 ORDER BY trend_ts DESC LIMIT 200`
);

// DB se trending compute: decay -> threshold se neeche drop -> decayed recency desc -> top N.
function computeTrending() {
  const now = nowSeconds();
  cacheClient.incrDbRead(); // direct SQLite read (trending cache miss pe hi compute hota hai)
  const rows = trendingPool.all();
  const ranked = [];
  for (const r of rows) {
    const rec = decay(r.trend_score, r.trend_ts, now);
    if (rec <= 0) continue; // threshold se neeche -> effectively trending nahi raha
    ranked.push({ query: r.query, score: +rec.toFixed(3) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, config.TRENDING_LIMIT);
}

// GET /trending -> prefix-independent hot list [{query, score}].
router.get('/trending', async (req, res) => {
  try {
    // Cache-first (chhota TTL). Graceful: cache error pe DB se compute.
    const cached = await cacheClient.getTrending();
    if (cached !== null) return res.status(200).json({ trending: cached });

    const trending = computeTrending(); // empty/all-zero -> [] gracefully
    await cacheClient.setTrending(trending);
    res.status(200).json({ trending });
  } catch (err) {
    console.error('trending error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
