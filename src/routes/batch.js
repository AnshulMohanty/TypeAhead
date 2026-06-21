const express = require('express');
const batchWriter = require('../services/batchWriter');

const router = express.Router();

// GET /batch/stats -> write-reduction counters + current buffer state.
router.get('/batch/stats', (req, res) => {
  res.status(200).json(batchWriter.stats());
});

// POST /batch/flush -> manual flush — demo aur deterministic test ke liye.
router.post('/batch/flush', async (req, res) => {
  try {
    const summary = await batchWriter.flush();
    res.status(200).json({ message: 'flushed', ...summary });
  } catch (err) {
    console.error('batch flush error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
