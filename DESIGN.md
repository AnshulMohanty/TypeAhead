# Design Choices & Trade-offs

This document explains *why* the system is built the way it is. For each major decision it
states the **choice**, the **alternative(s) considered**, **why** we chose it, and the
**trade-off** accepted. It doubles as the viva study sheet.

---

## 1. Read-heavy system → cache-first reads, DB as source of truth

**Choice.** Treat the workload as overwhelmingly read-heavy (every keystroke is a potential
`/suggest`; searches are comparatively rare). Optimize the read path with a cache in front of
SQLite, and let SQLite be the durable source of truth.

**Alternatives.** Serve every `/suggest` straight from the DB (no cache); or precompute and
push all results to clients.

**Why.** A typeahead fires many reads per search. The measured gap is stark — p95 ≈ **3.7 ms**
on a cache hit vs ≈ **42.7 ms** on a DB-backed miss (see PERFORMANCE.md). Caching the hot set
collapses the common case to in-memory speed.

**Trade-off.** **Eventual consistency.** A cached list can briefly be stale until TTL or
invalidation refreshes it. For typeahead this is acceptable: the user neither knows nor cares
that a suggestion's count is off by a few for a couple of seconds. We accept slight staleness
to buy a ~10× latency win on the common path.

---

## 2. `better-sqlite3` as the primary store

**Choice.** SQLite via `better-sqlite3` as the durable store.

**Alternatives.** A write-optimized distributed store (Cassandra / other LSM-tree DBs), or a
client-server SQL DB (Postgres/MySQL).

**Why.** For a single-node HLD demo, SQLite is ideal: zero external service to run, a real
file-backed store with **real transactions** (used by the batch flush), and a **synchronous**
API that pairs perfectly with Node's single thread — no connection pool, no race conditions to
reason about. The `query` column is the PRIMARY KEY, giving a B-tree index that makes
`LIKE 'prefix%'` a fast left-anchored range scan and making ingest idempotent.

**Trade-off.** It is single-node and write-serialized — fine here, but not how you'd scale
writes in production. **At real scale** you would move the source of truth to a
write-optimized, horizontally-partitioned store (e.g. Cassandra with an LSM engine) sharded by
query, keep the same cache-in-front design, and likely maintain the prefix→top-N projection in
a dedicated service. The architecture (cache-first reads, batched writes, consistent hashing)
carries over; only the storage engine changes.

---

## 3. Cache of `prefix → top-10` (key-value) vs an augmented Trie

**Choice.** Cache prefix→top-10 lists as plain key-value entries (`suggest:<mode>:<prefix>` →
JSON array) in Redis.

**Alternatives.** Build a Trie whose nodes are augmented with each prefix's top-K
suggestions (the classic typeahead data structure).

**Why.** The augmented-trie *idea* is "at each prefix, keep the best completions." We get
exactly that behavior without building and persisting a custom trie database: the cache key
*is* the prefix, and the value *is* its top-K. Lookup is an O(1)-ish hash GET, it rides on
Redis (replication, TTL, eviction for free), and the source-of-truth query that fills it is a
simple indexed SQL scan. No bespoke trie storage, serialization, or rebalancing to maintain.

**Trade-off.** We don't share structure between overlapping prefixes the way a trie's shared
nodes do, so cache entries are independent and a search invalidates each affected prefix
separately. In exchange we avoid an entire custom data-structure/storage subsystem. Given the
cache is a rebuildable optimization (not the source of truth), the simplicity wins.

---

## 4. Three independent Redis nodes + app-layer consistent hashing (Ketama)

**Choice.** Run 3 separate Redis instances (ports 6379/6380/6381) and shard keys across them
with an **app-layer consistent-hash ring** using **150 virtual nodes** per physical node
(Ketama-style), hashing `md5(key)`'s first 4 bytes to a ring position.

**Alternatives.** (a) **Redis Cluster**; (b) **naive modulo** sharding (`hash(key) % N`).

**Why.**
- *Not Redis Cluster:* Cluster uses a fixed 16384-slot space hashed with CRC16 — that is slot
  sharding, **not** consistent hashing. The assignment explicitly asks us to *implement
  consistent hashing*, so an app-layer ring over independent nodes is the on-point choice and
  is fully transparent for the viva.
- *Not naive modulo:* with `% N`, changing the node count remaps almost every key. Consistent
  hashing remaps only ~`1/N`.
- *Virtual nodes:* with only 3 points on the ring, load is lumpy; ~150 replicas per node smooth
  the distribution.

**Measured evidence** (`npm run ring-demo`): 3 nodes get ~32% / 36% / 33% of keys; adding a 4th
node remaps only **22.11%** of keys (≈ the ideal 1/4), **not ~100%**. That is the core property,
quantified.

**Trade-off.** Sharding logic lives in the app instead of being handled by the datastore, and
there is no cross-node replication of cache entries (a downed node loses its slice of the
cache). Both are acceptable because the cache is an optimization and the app-layer ring is the
explicit learning goal.

---

## 5. TTL **and** explicit invalidation together (belt-and-suspenders)

**Choice.** Every cached suggestion list has a TTL (default 300 s), **and** a `POST /search`
explicitly invalidates the affected prefixes at flush time.

**Alternatives.** TTL only (simpler, but stale until expiry); or invalidation only (precise,
but a missed invalidation leaks forever).

**Why.** Explicit invalidation gives **precise freshness** — the moment a count changes, the
affected prefixes are cleared. TTL is the **safety net** — even if an invalidation is missed
(bug, downed node, race), no entry can be stale beyond its TTL. Using both means a single
failure mode never produces permanently-wrong data.

**Trade-off.** Slightly more moving parts (two freshness mechanisms). Worth it for robustness.

---

## 6. Graceful degradation: the cache is an optimization, not a dependency

**Choice.** Any Redis error (node down, timeout) is swallowed and treated as a cache miss;
`/suggest` and `/trending` fall through to SQLite and still return correct results with HTTP
200. Cache writes/deletes that fail are logged and ignored — never a 500.

**Alternatives.** Propagate cache errors (fail the request if Redis is down).

**Why.** Availability of search matters more than the latency optimization. Verified in testing:
with one node stopped, `/suggest` for keys owned by that node still returns 200 from the DB.

**Trade-off.** When a node is down, its slice of requests runs at DB latency until the node
returns (and the ring/auto-reconnect re-warms it). Correctness is preserved; only speed dips.

---

## 7. Trending: lazy exponential decay + normalize-then-blend + candidate pool

**Choice.** A separate recency signal per query, decayed lazily; blended with all-time count
after normalizing both to [0,1]; computed over a candidate pool that unions popular and
recently-active queries.

- **Lazy exponential decay (no cron).** Store `trend_score` and `trend_ts`. On read/write,
  `decayed(now) = trend_score * 0.5 ^ ((now − trend_ts) / HALF_LIFE)`. On each search,
  `trend_score = decayed(now) + 1; trend_ts = now`. No background job — decay is applied
  on-touch. A short spike cools on its own and cannot stay permanently over-ranked.
- **Normalize-then-blend.** `score = ALPHA * (count/maxCount) + (1−ALPHA) * (recency/maxRecency)`
  within the candidate pool, `ALPHA` default 0.5.
- **Candidate pool = top-100-by-count ∪ top-100-by-recent** (per prefix), deduped.

**Alternatives.** A single magic additive weight (`count + w*recency`); a background recompute
job; ranking only the top-by-count rows.

**Why.**
- *Normalization is necessary:* all-time counts are in the **millions**, recency is **single
  digits**. An additive weight would let recency vanish into rounding. Normalizing both to a
  common [0,1] scale makes `ALPHA` the single, interpretable knob.
- *Lazy decay* avoids a scheduler entirely and is always correct at read time. When all recency
  is 0 (fresh load), `normRecency = 0` and trending order == basic count order — so the feature
  is regression-safe by construction.
- *Candidate pool union* is what lets a brand-new surging query (tiny all-time count) reach the
  trending list at all — it enters via the "recently active" arm, not the "popular" arm.

**Trade-off.** Normalization is *relative to the current pool*, so a single recent query stays
top until its decayed score crosses the threshold (`1e-6`), at which point it reverts to count
order. And we accept a tiny approximation in batched recency (see §8). Both are negligible for
the intended UX.

---

## 8. Batch writes (write-behind) vs sampling

**Choice.** `POST /search` enqueues into an in-memory `Map<query, deltaCount>`; a flush writes
the whole batch to SQLite in **one transaction**, triggered by **size** (`BATCH_SIZE`, default
500) **or timer** (`FLUSH_INTERVAL_MS`, default 2000 ms), whichever comes first.

**Alternatives.** Write-through (one DB transaction per search); or **sampling** (only count a
fraction of searches to reduce writes).

**Why.** Write-through is the measured 5000-transactions case; batching turns the same workload
into **11 transactions / 550 upserts** — ~9× fewer row-writes and ~455× fewer transactions
(PERFORMANCE.md). We chose **batching over sampling** deliberately: sampling reduces writes by
*throwing away data* (some searches are never counted); batching **never loses a count — it
only delays it** to the next flush. Since eventual consistency is acceptable here, batching is
the better fit.

Key correctness details:
- **Snapshot-then-write:** the buffer Map is atomically swapped for a fresh empty one *before*
  writing, so searches arriving during a flush land in the next batch (no lost increments, no
  lock — Node is single-threaded and `better-sqlite3` is synchronous, so enqueue and the
  flush's DB step never interleave).
- **One transaction per flush:** this is where the write reduction actually comes from.
- **Invalidation at flush, not at enqueue:** if we invalidated on enqueue, a cache miss before
  the flush would re-populate from the *not-yet-updated* DB and re-cache stale data. So we clear
  the deduped union of affected prefixes (both modes) **after** the transaction commits, and
  also drop `trending:global`.
- **Batched recency approximation:** for a query with aggregated delta `K`, recency is updated
  once as `decayed(flushTime) + K` rather than `K` separate `+1`s. Because the batch window
  (seconds) ≪ the half-life (3600 s), the intra-window decay we ignore is negligible.
- **Approximate read-your-writes count:** since the real count isn't written until flush,
  `POST /search` returns `DB count + pending buffer delta` so the UI keeps incrementing
  responsively.

**Trade-off — the failure story.** A **clean shutdown** (SIGINT/SIGTERM handler) flushes the
buffer first, so it loses nothing. A **hard crash** (`kill -9`, power loss) loses the
un-flushed window — bounded by at most `BATCH_SIZE` increments, or `< FLUSH_INTERVAL_MS` worth
of traffic. For popularity counters this bounded, rare loss is an acceptable price for the large
write reduction.

---

## 9. Eventual consistency overall

**Choice.** The system is eventually consistent, by design, in two visible places:
- **Suggestion ordering / counts:** a cached list can lag a just-happened search until TTL or
  invalidation; and because writes are batched, a search is reflected in `/suggest` only after
  the next flush (≤ `FLUSH_INTERVAL_MS`, or sooner on a size-triggered flush).
- **Trending:** the global list is cached with a short TTL (15 s) and recomputed after flushes.

**Why it's acceptable.** The assignment explicitly allows results to be "eventually reflected."
For a popularity-ranked typeahead, no user depends on a count being exact to the millisecond;
they depend on suggestions being *fast* and *roughly right*. We trade strict consistency for
latency and write-throughput, which is the correct trade for this problem.

---

## What we deliberately did NOT build (scoped out per the assignment)

- **Personalization / per-user ranking** — no user model or auth; suggestions are global.
- **Spell-correction / fuzzy matching** — strict left-anchored prefix matching only.
- **Real search / result pages** — `POST /search` is a popularity-recording stub
  (`"message": "Searched"`), not a query engine.
- **Authentication / authorization / rate-limiting** — not part of the data-structure/system
  focus of this assignment.
- **Geo-distributed edge serving** — latency is measured on localhost; real-world
  server-distance latency is acknowledged but out of scope.

These were left out intentionally to keep the focus on the graded core: prefix suggestions,
caching with consistent hashing, recency-aware trending, and batched writes.
