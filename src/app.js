const express = require('express');
const path = require('path');
const suggestRoutes = require('./routes/suggest');
const searchRoutes = require('./routes/search');
const cacheDebugRoutes = require('./routes/cacheDebug');
const trendingRoutes = require('./routes/trending');
const batchRoutes = require('./routes/batch');

const app = express();

app.use(express.json());

// Phase 2: frontend ko same-origin serve karte hain -> / pe index.html, no CORS needed.
// Absolute path taaki CWD kuch bhi ho fark na pade.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes yahin mount hote hain.
app.use('/', suggestRoutes);
app.use('/', searchRoutes); // Phase 3: POST /search write path
app.use('/', cacheDebugRoutes); // Phase 4: /cache/debug + /cache/stats
app.use('/', trendingRoutes); // Phase 5: GET /trending
app.use('/', batchRoutes); // Phase 6: /batch/stats + /batch/flush

module.exports = app;
