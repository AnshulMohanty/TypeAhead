// Phase 7 performance benchmark — REAL numbers over HTTP against a running server.
// localhost pe measure kar rahe hain, network round-trip ~0; real user latency unki
// server-distance pe depend karti hai (geo-located servers ka kaam), jo is project ke scope me nahi.
const { performance } = require('perf_hooks');

const BASE = process.env.BENCH_BASE || 'http://localhost:3000';

const WARM_PREFIXES = [
  'the', 'new', 'wor', 'app', 'ind', 'con', 'com', 'pro', 'sta', 'tra',
  'pre', 'int', 'ove', 'und', 'tim', 'yea', 'dat', 'man', 'car', 'day',
];
const HIT_REQUESTS = 2000;
const MISS_REQUESTS = 2000;
const SKEW_REQUESTS = 5000;
const WRITE_REQUESTS = 5000;
const WRITE_DISTINCT = 50;

async function timedGet(path) {
  const t = performance.now();
  const res = await fetch(BASE + path);
  await res.text(); // body bhi padho taaki end-to-end honest rahe
  return performance.now() - t;
}
async function getJSON(path) {
  const res = await fetch(BASE + path);
  return res.json();
}
async function postSearch(query) {
  await fetch(BASE + '/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: +s[0].toFixed(3),
    p50: +percentile(s, 50).toFixed(3),
    p95: +percentile(s, 95).toFixed(3),
    p99: +percentile(s, 99).toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    mean: +(sum / s.length).toFixed(3),
  };
}
function randPrefix() {
  const len = 3 + Math.floor(Math.random() * 4); // 3..6
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
}
// Zipf-like skew: rank r ko prob ∝ 1/r — real search traffic power-law jaisa.
function buildZipf(prefixes) {
  const weights = prefixes.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const cum = [];
  let acc = 0;
  for (const w of weights) { acc += w / total; cum.push(acc); }
  return () => {
    const r = Math.random();
    for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return prefixes[i];
    return prefixes[prefixes.length - 1];
  };
}

async function main() {
  // Pre-flight: server up hai? warna clear message.
  try {
    const h = await getJSON('/health');
    if (!h || h.status !== 'ok') throw new Error('bad health');
  } catch (e) {
    console.error('\n[perf] Cannot reach server at ' + BASE + '/health');
    console.error('[perf] Start the server + Redis first:  docker compose up -d  &&  npm start\n');
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  console.log('='.repeat(66));
  console.log(`PERF BENCH  (measured locally on ${date}, will vary by machine)`);
  console.log(`target=${BASE}  | localhost: network ~0ms, real geo-latency out of scope`);
  console.log('='.repeat(66));

  // ---- 1) LATENCY: cache HIT vs MISS ----
  // p95 isliye, average jhooth bolta hai — tail latency hi real UX hai.
  // HIT set: warm karo phir baar-baar maaro (cache hits).
  for (const p of WARM_PREFIXES) await timedGet(`/suggest?q=${p}`);
  const hitLat = [];
  for (let i = 0; i < HIT_REQUESTS; i++) {
    const p = WARM_PREFIXES[i % WARM_PREFIXES.length];
    hitLat.push(await timedGet(`/suggest?q=${p}`));
  }
  // MISS set: distinct random prefixes (warmed nahi) -> har ek fresh miss -> DB-backed.
  const seen = new Set();
  const missPrefixes = [];
  while (missPrefixes.length < MISS_REQUESTS) {
    const p = randPrefix();
    if (!seen.has(p)) { seen.add(p); missPrefixes.push(p); }
  }
  const missLat = [];
  for (const p of missPrefixes) missLat.push(await timedGet(`/suggest?q=${p}`));

  const hit = summarize(hitLat);
  const miss = summarize(missLat);

  // ---- 2) CACHE HIT RATE under skewed load ----
  const before = await getJSON('/cache/stats');
  const pick = buildZipf(WARM_PREFIXES.concat(Array.from({ length: 30 }, () => randPrefix())));
  for (let i = 0; i < SKEW_REQUESTS; i++) await timedGet(`/suggest?q=${pick()}`);
  const after = await getJSON('/cache/stats');
  const dHits = after.hits - before.hits;
  const dMisses = after.misses - before.misses;
  const skewHitRate = dHits + dMisses > 0 ? dHits / (dHits + dMisses) : 0;
  const dDbReads = after.dbReads - before.dbReads;
  const perNodeDelta = {};
  for (const id of Object.keys(after.perNode)) {
    perNodeDelta[id] = {
      hits: after.perNode[id].hits - before.perNode[id].hits,
      misses: after.perNode[id].misses - before.perNode[id].misses,
    };
  }

  // ---- 3) WRITE REDUCTION ----
  const bStatsBefore = await getJSON('/batch/stats');
  for (let i = 0; i < WRITE_REQUESTS; i++) await postSearch(`perf bench query ${i % WRITE_DISTINCT}`);
  await fetch(BASE + '/batch/flush', { method: 'POST' });
  const bStatsAfter = await getJSON('/batch/stats');
  const wSearches = bStatsAfter.searchesEnqueued - bStatsBefore.searchesEnqueued;
  const wUpserts = bStatsAfter.dbUpserts - bStatsBefore.dbUpserts;
  const wTxns = bStatsAfter.txns - bStatsBefore.txns;

  // ---- SUMMARY (copy-pasteable) ----
  console.log('\n--- 1) /suggest LATENCY (ms) ---');
  console.log('  set     n      min     p50     p95     p99     max     mean');
  const row = (label, s) =>
    `  ${label.padEnd(6)}  ${String(s.n).padEnd(5)} ${String(s.min).padStart(6)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(7)} ${String(s.p99).padStart(7)} ${String(s.max).padStart(7)} ${String(s.mean).padStart(8)}`;
  console.log(row('HIT', hit));
  console.log(row('MISS', miss));
  console.log(`  -> p95 hit=${hit.p95}ms vs miss=${miss.p95}ms (Redis in-memory vs SQLite query)`);

  console.log('\n--- 2) CACHE HIT RATE under Zipf-skewed load ---');
  console.log(`  requests=${SKEW_REQUESTS}  hits=${dHits}  misses=${dMisses}  hitRate=${(skewHitRate * 100).toFixed(2)}%  dbReads(delta)=${dDbReads}`);
  console.log('  per-node (delta):');
  for (const id of Object.keys(perNodeDelta)) {
    console.log(`    ${id}: hits=${perNodeDelta[id].hits}  misses=${perNodeDelta[id].misses}`);
  }

  console.log('\n--- 3) WRITE REDUCTION (write-behind batching) ---');
  console.log(`  searches=${wSearches}  upserts=${wUpserts}  transactions=${wTxns}`);
  if (wUpserts > 0 && wTxns > 0) {
    console.log(`  -> ${wSearches} searches : ${wUpserts} upserts = ${(wSearches / wUpserts).toFixed(1)}x fewer row-writes`);
    console.log(`  -> ${wSearches} searches : ${wTxns} transactions = ${(wSearches / wTxns).toFixed(0)}x fewer DB transactions`);
  }

  console.log('\n--- DB read/write counts (cumulative since server start) ---');
  console.log(`  /cache/stats.dbReads = ${after.dbReads}  (suggest-path dbReads ≈ cache misses)`);
  console.log(`  /batch/stats.dbUpserts = ${bStatsAfter.dbUpserts}  txns = ${bStatsAfter.txns}`);

  console.log('\n' + '='.repeat(66));
  console.log('NOTE: writes test data to the DB. Numbers are machine-dependent.');
  console.log('='.repeat(66));
  process.exit(0);
}

main().catch((e) => {
  console.error('perf bench failed:', e);
  process.exit(1);
});
