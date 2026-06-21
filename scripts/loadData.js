const fs = require('fs');
const path = require('path');
const db = require('../src/db/db');
const config = require('../config');

// Dataset sources — Norvig ke unigram (primary) aur bigram (enhancement).
const UNIGRAM_URL = 'https://norvig.com/ngrams/count_1w.txt';
const BIGRAM_URL = 'https://norvig.com/ngrams/count_2w.txt';
const UNIGRAM_FILE = path.join(config.DATA_DIR, 'count_1w.txt');
const BIGRAM_FILE = path.join(config.DATA_DIR, 'count_2w.txt');

const BIGRAM_LIMIT = 100000; // top 100k bigrams hi ingest karte hain, demo ke liye kaafi.

// Counts ko /1000 scale down karte hain -> baad me jab search pe +1 increment hoga to wo
// visible rahe (warna raw counts billions me hote, ek +1 noise me kho jaata). floor + max(1,..)
// taaki relative ordering bani rahe aur count kabhi 0 na ho.
function scaleCount(raw) {
  return Math.max(1, Math.floor(raw / 1000));
}

// Idempotent insert: query PRIMARY KEY hai, INSERT OR REPLACE se dobara chalane pe duplicate
// nahi banta — purani row overwrite ho jaati hai.
const insertStmt = db.prepare('INSERT OR REPLACE INTO queries (query, count) VALUES (?, ?)');

// Saara ingest ek transaction me -> 100k+ rows tezi se (better-sqlite3 me yeh hugely fast hai).
const insertMany = db.transaction((rows) => {
  for (const [query, count] of rows) insertStmt.run(query, count);
});

async function downloadIfNeeded(url, dest) {
  // Agar file pehle se hai to dobara download nahi (offline re-run + bandwidth bachat).
  if (fs.existsSync(dest)) {
    console.log(`[skip download] already present: ${path.basename(dest)}`);
    return true;
  }
  if (typeof fetch !== 'function') {
    // Node 18+ me global fetch hota hai; isse purana Node ho to clearly bata do.
    throw new Error('global fetch unavailable — Node 18+ chahiye (ya node-fetch add karein)');
  }
  console.log(`[download] ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`[download] saved ${path.basename(dest)} (${buf.length} bytes)`);
  return true;
}

// "word<TAB>count" lines -> normalized [query, scaledCount] rows.
function parseUnigrams(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const query = line.slice(0, tab).trim().toLowerCase(); // normalize: lowercase + trim
    const raw = parseInt(line.slice(tab + 1), 10);
    if (!query || !Number.isFinite(raw)) continue; // empties / garbage skip
    rows.push([query, scaleCount(raw)]);
  }
  return rows;
}

// Bigrams bhi same format ("new york<TAB>count"); sirf top N (file already count-desc sorted hai).
function parseBigrams(text, limit) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (rows.length >= limit) break;
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const query = line.slice(0, tab).trim().toLowerCase();
    const raw = parseInt(line.slice(tab + 1), 10);
    if (!query || !Number.isFinite(raw)) continue;
    rows.push([query, scaleCount(raw)]);
  }
  return rows;
}

// FALLBACK path: agar download bilkul fail ho jaaye, to power-law distributed synthetic
// dataset bana lete hain taaki build offline bhi chale (>=150k entries).
function generateSynthetic(n = 150000) {
  console.log(`[fallback] generating ${n} synthetic power-law entries`);
  const rows = [];
  for (let i = 0; i < n; i++) {
    // Deterministic pseudo-word + Zipf-ish count (rank ke saath girta hua).
    const query = `query${i.toString(36)}`;
    const rawCount = Math.floor(1e9 / (i + 1)); // ~1/rank -> power law
    rows.push([query, scaleCount(rawCount)]);
  }
  return rows;
}

async function main() {
  let pathUsed;
  let allRows = [];

  try {
    // PRIMARY: unigrams. Yeh fail hua to catch me fallback chalega.
    await downloadIfNeeded(UNIGRAM_URL, UNIGRAM_FILE);
    allRows = parseUnigrams(fs.readFileSync(UNIGRAM_FILE, 'utf8'));
    pathUsed = 'norvig-unigrams';
    console.log(`[parse] ${allRows.length} unigrams`);

    // ENHANCEMENT: bigrams — reachable ho to top 100k add karo, warna gracefully skip.
    try {
      await downloadIfNeeded(BIGRAM_URL, BIGRAM_FILE);
      const bigrams = parseBigrams(fs.readFileSync(BIGRAM_FILE, 'utf8'), BIGRAM_LIMIT);
      allRows = allRows.concat(bigrams);
      pathUsed = 'norvig-unigrams+bigrams';
      console.log(`[parse] ${bigrams.length} bigrams (top ${BIGRAM_LIMIT})`);
    } catch (e) {
      console.warn(`[bigrams skipped] ${e.message}`);
    }
  } catch (e) {
    console.warn(`[unigram download failed] ${e.message}`);
    allRows = generateSynthetic();
    pathUsed = 'synthetic-fallback';
  }

  console.log(`[ingest] inserting ${allRows.length} rows...`);
  insertMany(allRows);

  const total = db.prepare('SELECT COUNT(*) AS c FROM queries').get().c;
  console.log('--------------------------------------------------');
  console.log(`Dataset path used : ${pathUsed}`);
  console.log(`Total rows in DB  : ${total}`);
  console.log('--------------------------------------------------');
}

main().catch((err) => {
  console.error('load-data failed:', err);
  process.exit(1);
});
