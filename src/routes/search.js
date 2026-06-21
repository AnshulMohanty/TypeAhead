const express = require('express');
const { recordSearch } = require('../services/searchService');
const { normalizeQuery } = require('../utils/normalize');

const router = express.Router();

const MAX_QUERY_LEN = 256;

// POST /search  body: { "query": "..." }
router.post('/search', async (req, res) => {
  try {
    const raw = req.body && req.body.query;
    const normalized = normalizeQuery(raw);

    // Missing/empty/whitespace -> graceful 400, koi crash nahi.
    if (!normalized) {
      return res.status(400).json({ error: 'query is required' });
    }
    // bahut lambi query likhne se rok do.
    if (normalized.length > MAX_QUERY_LEN) {
      return res.status(400).json({ error: 'query too long' });
    }

    const { query, count } = await recordSearch(normalized);

    // "message":"Searched" assignment ka required dummy field; query/count demo ke liye useful.
    res.status(200).json({ message: 'Searched', query, count });
  } catch (err) {
    // 500 sirf real server error pe.
    console.error('search error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
