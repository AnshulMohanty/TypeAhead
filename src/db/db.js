const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

// data/ folder pehle se na ho to bana do, warna better-sqlite3 file open nahi kar paayega.
fs.mkdirSync(config.DATA_DIR, { recursive: true });

const db = new Database(config.DB_PATH);

// WAL mode -> reads aur writes ek doosre ko block nahi karte; Phase 4 ke +1 search writes
// ke time concurrent reads smooth rahenge.
db.pragma('journal_mode = WAL');

function init() {
  // query ko PRIMARY KEY rakha -> isse ek implicit index banta hai jo LIKE 'prefix%' range
  // scan ko fast karta hai, aur UNIQUE constraint bhi free me mil jaata hai (idempotent load).
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    );
  `);

  // Explicit index bhi rakha taaki prefix scans ka plan guaranteed index-backed rahe.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_query ON queries(query);`);
}

// Phase 5: idempotent migration — purani db (sirf query,count) me recency columns add karo.
function migrate() {
  const cols = db.prepare(`PRAGMA table_info(queries)`).all().map((c) => c.name);
  // load ke time kuch trending nahi hota, isliye seeded rows ka trend_score 0 (DEFAULT 0).
  if (!cols.includes('trend_score')) {
    db.exec(`ALTER TABLE queries ADD COLUMN trend_score REAL DEFAULT 0`);
  }
  if (!cols.includes('trend_ts')) {
    db.exec(`ALTER TABLE queries ADD COLUMN trend_ts INTEGER DEFAULT 0`);
  }
  // trend_ts DESC pool (global trending) ko fast karne ke liye index.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trend_ts ON queries(trend_ts);`);
}

init();
migrate();

module.exports = db;
