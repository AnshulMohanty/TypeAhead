const express = require('express');
const { getSuggestionsCached } = require('../services/suggestionService');

const router = express.Router();

// GET /suggest?q=<prefix>&mode=<basic|trending>
router.get('/suggest', async (req, res) => {
  try {
    // Missing q -> empty string treat karo -> service gracefully [] return karega (200).
    const q = req.query.q || '';
    // mode default "trending"; "basic" accept; unknown -> "trending".
    const mode = req.query.mode === 'basic' ? 'basic' : 'trending';

    // Cache-first read (per-mode). Response shape Phase 1 jaisa + ek "mode" field.
    const suggestions = await getSuggestionsCached(q, mode);

    // Normalized prefix wapas bhejte hain taaki client ko pata ho actually kis pe match hua.
    const prefix = q.trim().toLowerCase();
    res.status(200).json({ prefix, mode, suggestions });
  } catch (err) {
    // 500 sirf real server error pe; valid-but-empty input kabhi 500 nahi hota.
    console.error('suggest error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// GET /health -> simple sanity check.
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

module.exports = router;
