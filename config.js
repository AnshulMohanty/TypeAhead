// Saara config ek jagah; env se padho, warna sensible default. Later phases (Redis nodes,
// search path) bhi yahin apne env vars add karenge.
const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3000,

  // SQLite file aur raw dataset dono data/ ke andar rehte hain (gitignored).
  DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data', 'typeahead.db'),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),

  // Suggestion query ka max result count — ek hi jagah taaki route/service dono same use karein.
  SUGGESTION_LIMIT: 10,

  // Phase 4: 3 alag Redis instances (cluster nahi). App-layer ring inhi par consistent hashing karega.
  REDIS_NODES: [
    { id: 'node-1', host: '127.0.0.1', port: 6379 },
    { id: 'node-2', host: '127.0.0.1', port: 6380 },
    { id: 'node-3', host: '127.0.0.1', port: 6381 },
  ],

  // Har physical node ke ~150 virtual replicas -> ring pe load smooth (Ketama approach).
  VNODE_COUNT: parseInt(process.env.VNODE_COUNT, 10) || 150,

  // TTL safety-net hai taaki koi entry hamesha ke liye stale na rahe; precise freshness ke liye
  // explicit invalidation bhi hai (dono use karte hain — belt and suspenders).
  CACHE_TTL_SECONDS: parseInt(process.env.CACHE_TTL_SECONDS, 10) || 300,

  // Phase 5: recency / trending knobs.
  // HALF_LIFE: kitne second me decayed recency aadhi ho jaye (tests env se chhota set karte hain).
  HALF_LIFE_SECONDS: parseInt(process.env.HALF_LIFE_SECONDS, 10) || 3600,
  // ALPHA: trending blend ka ekmaatra knob — kitna all-time count vs kitni recency.
  RECENCY_ALPHA: process.env.RECENCY_ALPHA ? parseFloat(process.env.RECENCY_ALPHA) : 0.5,
  // trending list jaldi badalti hai, isliye chhota TTL.
  TRENDING_TTL_SECONDS: parseInt(process.env.TRENDING_TTL_SECONDS, 10) || 15,
  TRENDING_LIMIT: parseInt(process.env.TRENDING_LIMIT, 10) || 10,

  // Phase 6: write-behind batch writer ke knobs.
  // BATCH_SIZE: itne buffered searches pe size-trigger flush. (BATCH_SIZE=1 -> ~synchronous-
  // per-search, yani spectrum ka ek endpoint.)
  BATCH_SIZE: parseInt(process.env.BATCH_SIZE, 10) || 500,
  // FLUSH_INTERVAL_MS: itne ms me time-trigger flush (jo pehle aaye: size ya timer).
  FLUSH_INTERVAL_MS: parseInt(process.env.FLUSH_INTERVAL_MS, 10) || 2000,
};
