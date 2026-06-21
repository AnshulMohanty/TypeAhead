const Redis = require('ioredis');
const config = require('../../config');
const { ConsistentHashRing } = require('./hashRing');

// Key format "suggest:<mode>:<prefix>" -> basic aur trending alag values, collision nahi.
// RING sirf <prefix> par keyed hai (dono modes same node pe -> invalidation local rehti hai).
const suggestKey = (mode, prefix) => `suggest:${mode}:${prefix}`;
const TRENDING_KEY = 'trending:global';

// Ek client per Redis node + ring banakar nodeId -> client map.
const ring = new ConsistentHashRing(config.VNODE_COUNT);
const clients = new Map(); // nodeId -> ioredis client

for (const node of config.REDIS_NODES) {
  const client = new Redis({
    host: node.host,
    port: node.port,
    // Graceful degradation ke liye: ek command pe zyada retry mat karo, fail fast karke DB pe gir jao.
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    // ioredis default reconnect strategy se node wapas aane par auto-reconnect ho jata hai.
    lazyConnect: false,
  });
  // Error event handle karna zaroori warna ioredis unhandled 'error' throw kar deta hai (crash).
  client.on('error', () => { /* cache error ko swallow; suggest DB se chalega */ });
  clients.set(node.id, client);
  ring.addNode(node.id);
}

// Counters — Phase 7 metrics ka base.
// cache MISS hi DB read trigger karta hai, isliye suggest-path pe dbReads ≈ cache misses;
// baaki reads trending/approx-count se aate hain.
const counters = {
  hits: 0,
  misses: 0,
  dbReads: 0,
  perNode: {},
};
for (const node of config.REDIS_NODES) {
  counters.perNode[node.id] = { hits: 0, misses: 0 };
}

function clientFor(ringKey) {
  // Ring hamesha plain string par keyed (prefix, ya 'trending:global').
  const nodeId = ring.getNode(ringKey);
  return { nodeId, client: clients.get(nodeId) };
}

function ownerOf(prefix) {
  // /cache/debug ke liye — kaunsa node is prefix ka owner hai (ring decide karta hai).
  return ring.getNode(prefix);
}

async function getSuggestions(prefix, mode) {
  const { nodeId, client } = clientFor(prefix);
  try {
    const raw = await client.get(suggestKey(mode, prefix));
    if (raw == null) {
      // Miss: count karo, null return -> caller DB se padhega.
      counters.misses++;
      counters.perNode[nodeId].misses++;
      return null;
    }
    counters.hits++;
    counters.perNode[nodeId].hits++;
    return JSON.parse(raw);
  } catch (err) {
    // cache gir jaye toh bhi suggest DB se chale — cache optimization hai, dependency nahi.
    // Error ko miss ki tarah treat karo, kabhi throw mat karo.
    counters.misses++;
    counters.perNode[nodeId].misses++;
    return null;
  }
}

async function setSuggestions(prefix, mode, arr) {
  const { client } = clientFor(prefix);
  try {
    // EX = TTL safety-net; precise freshness ke liye explicit invalidation alag se hai.
    await client.set(suggestKey(mode, prefix), JSON.stringify(arr), 'EX', config.CACHE_TTL_SECONDS);
  } catch (err) {
    // set fail -> bas log/swallow, kabhi 500 nahi.
  }
}

async function invalidatePrefixes(prefixList) {
  // ek search dono modes ka cached result badal sakta hai, isliye dono keys clear karo.
  await Promise.all(
    prefixList.map(async (prefix) => {
      const { client } = clientFor(prefix);
      try {
        await client.del(suggestKey('basic', prefix), suggestKey('trending', prefix));
      } catch (err) {
        /* swallow */
      }
    })
  );
}

// READ-ONLY existence check (cache state modify nahi karta) — /cache/debug ke liye.
async function exists(prefix, mode) {
  const { client } = clientFor(prefix);
  try {
    return (await client.exists(suggestKey(mode, prefix))) === 1;
  } catch (err) {
    return false;
  }
}

// Phase 5: global trending list cache (chhota TTL). Ring 'trending:global' par owner decide karta hai.
async function getTrending() {
  const { client } = clientFor(TRENDING_KEY);
  try {
    const raw = await client.get(TRENDING_KEY);
    return raw == null ? null : JSON.parse(raw);
  } catch (err) {
    return null; // miss treat -> caller DB se compute karega
  }
}

async function setTrending(arr) {
  const { client } = clientFor(TRENDING_KEY);
  try {
    await client.set(TRENDING_KEY, JSON.stringify(arr), 'EX', config.TRENDING_TTL_SECONDS);
  } catch (err) {
    /* swallow */
  }
}

// Phase 6: flush ke baad global trending bhi stale ho jaata hai, isliye DEL. Swallow errors.
async function invalidateTrending() {
  const { client } = clientFor(TRENDING_KEY);
  try {
    await client.del(TRENDING_KEY);
  } catch (err) {
    /* swallow */
  }
}

// DB-only reads (suggest query, trending pool, approx-count lookup) yahin se count hote hain
// taaki /cache/stats par read-path ke saare counters ek jagah dikhein.
function incrDbRead(n = 1) {
  counters.dbReads += n;
}

function stats() {
  const total = counters.hits + counters.misses;
  return {
    hits: counters.hits,
    misses: counters.misses,
    hitRate: total === 0 ? 0 : +(counters.hits / total).toFixed(4),
    dbReads: counters.dbReads,
    perNode: counters.perNode,
  };
}

// PING all nodes — startup log + tests me connectivity dikhane ke liye.
async function pingAll() {
  const result = {};
  await Promise.all(
    config.REDIS_NODES.map(async (node) => {
      try {
        result[node.id] = (await clients.get(node.id).ping()) === 'PONG' ? 'PONG' : 'FAIL';
      } catch (err) {
        result[node.id] = 'DOWN';
      }
    })
  );
  return result;
}

// Startup pe ~10000 random prefixes ka ring distribution — vnodes se even distribution visible ho (NFR).
function logRingDistribution(sampleSize = 10000) {
  const dist = {};
  for (const node of config.REDIS_NODES) dist[node.id] = 0;
  for (let i = 0; i < sampleSize; i++) {
    // Deterministic-ish varied keys (Math.random allowed here — yeh runtime log hai, workflow nahi).
    const key = `p${i}_${(i * 2654435761) % 100000}`;
    dist[ring.getNode(key)]++;
  }
  const summary = Object.entries(dist)
    .map(([id, c]) => `${id}: ${c} (${((c / sampleSize) * 100).toFixed(1)}%)`)
    .join('  |  ');
  console.log(`[cache] ring distribution over ${sampleSize} sample prefixes -> ${summary}`);
}

module.exports = {
  getSuggestions,
  setSuggestions,
  invalidatePrefixes,
  exists,
  getTrending,
  setTrending,
  invalidateTrending,
  incrDbRead,
  ownerOf,
  stats,
  pingAll,
  logRingDistribution,
};
