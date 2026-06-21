const express = require('express');
const cacheClient = require('../cache/cacheClient');
const { normalizeQuery } = require('../utils/normalize');

const router = express.Router();

// GET /cache/debug?prefix=<prefix>&mode=<basic|trending> -> owner node + hit/miss (READ-ONLY).
router.get('/cache/debug', async (req, res) => {
  const prefix = normalizeQuery(req.query.prefix);
  // Missing/empty prefix -> graceful 400.
  if (!prefix) return res.status(400).json({ error: 'prefix is required' });

  // default mode trending; har mode ki apni cache key hai.
  const mode = req.query.mode === 'basic' ? 'basic' : 'trending';
  const node = cacheClient.ownerOf(prefix);
  // Existence check cache state ko modify nahi karta (sirf EXISTS).
  const status = (await cacheClient.exists(prefix, mode)) ? 'hit' : 'miss';
  res.status(200).json({ prefix, mode, node, status });
});

// GET /cache/stats -> hits/misses/hit-rate + per-node counters (Phase 7 ka base).
router.get('/cache/stats', (req, res) => {
  res.status(200).json(cacheClient.stats());
});

module.exports = router;
