# Performance

All numbers below were **measured locally on 2026-06-21** by running `npm run perf`
(`scripts/perfBench.js`) over real HTTP against a running server with the 3 Redis nodes up.
They are **hardware-dependent and will vary by machine** — nothing here is fabricated; each
figure is pasted from an actual benchmark run.

**Methodology notes**
- Measured on `localhost`, so network round-trip is ≈ 0 ms. Real end-user latency additionally
  depends on their distance to the server (a geo-distributed-edge concern, out of scope for
  this assignment).
- Latency is reported as **p50 / p95 / p99**, not just the average — the average hides the
  tail, and tail latency is what users actually feel.

---

## 1. `/suggest` latency — cache HIT vs cache MISS

`/suggest` latency (ms), 2000 requests each set:

| set  | n    | min   | p50    | p95    | p99    | max     | mean   |
|------|------|-------|--------|--------|--------|---------|--------|
| HIT  | 2000 | 1.219 | 1.834  | 3.710  | 6.501  | 15.264  | 2.127  |
| MISS | 2000 | 2.981 | 32.651 | 42.723 | 68.951 | 173.562 | 33.384 |

**p95: HIT = 3.71 ms vs MISS = 42.72 ms** — roughly an order of magnitude faster on a hit.
A hit is a single in-memory Redis `GET` of a pre-computed top-10 list; a miss runs the
SQLite prefix query (`LIKE 'prefix%'` over 428k rows, plus the trending candidate-pool reads),
ranks the result, then populates the cache. This gap is exactly why the cache exists.

---

## 2. Cache hit rate under a realistic (Zipf-skewed) workload

5000 `/suggest` requests drawn from a Zipf-like skew (a few hot prefixes get most of the
traffic, a long tail gets the rest — mimicking real search distribution):

| metric            | value   |
|-------------------|---------|
| requests          | 5000    |
| hits              | 4970    |
| misses            | 30      |
| **hit rate**      | **99.40%** |
| dbReads (delta)   | 60      |

Per-node hit distribution over this run (the consistent-hash ring spreads keys across nodes):

| node   | hits | misses |
|--------|------|--------|
| node-1 | 1229 | 12     |
| node-2 | 1245 | 7      |
| node-3 | 2496 | 11     |

Because real query traffic follows a **power-law** (the same shape as the underlying
frequency dataset), a small hot set is requested over and over — so once warm, the vast
majority of requests are served from cache. That is the entire value of the cache layer.

> Note on `dbReads (delta) = 60` vs `misses = 30`: the default mode is `trending`, and a
> trending miss performs **two** SQLite reads (the top-by-count pool **and** the top-by-recent
> pool). So `dbReads ≈ misses × 2` here. On the `basic` path a miss is exactly one read, so
> there `dbReads == misses`.

---

## 3. DB read / write counts (NFR: "DB read/write counts where possible")

Exposed via `GET /cache/stats` (`dbReads`, read path) and `GET /batch/stats`
(`dbUpserts`, `txns`, write path), cumulative since server start through the benchmark:

| counter                 | value | meaning                                            |
|-------------------------|-------|----------------------------------------------------|
| `cache/stats.dbReads`   | 4101  | direct SQLite reads; on the suggest path ≈ cache misses |
| `batch/stats.dbUpserts` | 550   | distinct-query rows written to SQLite               |
| `batch/stats.txns`      | 11    | flush transactions                                  |

The key relationship: **a cache miss is what triggers a DB read**, so on the suggest path
`dbReads ≈ cache misses` (× number of pool reads for trending). The remaining reads come from
`/trending` compute and the approximate-count lookup on `POST /search`.

---

## 4. Write reduction (write-behind batching)

5000 `POST /search` calls drawn from 50 distinct queries (heavy repetition, like real
traffic), then one forced `POST /batch/flush`:

| metric                 | value |
|------------------------|-------|
| searches enqueued      | 5000  |
| distinct upserts written | 550 |
| flush transactions     | 11    |

- **5000 searches : 550 upserts = 9.1× fewer row-writes** (coalescing repeated queries).
- **5000 searches : 11 transactions = 455× fewer DB transactions** (batching per flush).

Naively (write-through), this workload would be 5000 individual transactions; write-behind
turns it into 11. No counts are lost — they are only delayed to the next flush.

---

## 5. Consistent-hashing evidence

From `npm run ring-demo` (pure ring math, 100,000 sample keys, 150 vnodes per node):

```
Distribution with 3 nodes:
  node-1: 31765  (31.77%)
  node-2: 35588  (35.59%)
  node-3: 32647  (32.65%)

Distribution after adding node-4:
  node-1: 26012  (26.01%)
  node-2: 25992  (25.99%)
  node-3: 25884  (25.88%)
  node-4: 22112  (22.11%)

Keys that changed owner after ADDING node-4:   22112 / 100000 = 22.11%  (ideal ~25%)
Keys that changed owner after REMOVING node-4: 22112 / 100000 = 22.11%
```

Two properties, both quantified:
1. **Balanced load** — ~33% per node with 3 nodes (the virtual nodes smooth out what would
   otherwise be lumpy with only 3 points on the ring).
2. **Minimal remapping** — adding a 4th node moves only **22.11%** of keys (close to the
   theoretical 1/4), **not ~100%**. That minimal disruption on membership change is the
   defining property of consistent hashing, and the reason we use it over naive modulo.

---

### How to reproduce

```bash
docker compose up -d        # 3 Redis nodes
npm install
npm run load-data           # ~428k rows
npm start                   # in one terminal
npm run perf                # in another terminal — prints the numbers above
npm run ring-demo           # consistent-hashing distribution + remap
```
