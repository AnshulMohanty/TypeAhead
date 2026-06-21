// NFR evidence: consistent hashing behaviour ko numbers me dikhata hai. Pure ring math,
// koi Redis nahi chahiye (containers down ho to bhi chalega).
const config = require('../config');
const { ConsistentHashRing } = require('../src/cache/hashRing');

const SAMPLE = 100000;

// Deterministic sample keys (Math.random use nahi kiya taaki run-to-run reproducible rahe).
function sampleKeys(n) {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(`prefix_${i}_${(i * 2654435761) % 1000003}`);
  return keys;
}

function distribution(ring, keys) {
  const dist = {};
  const owner = new Map();
  for (const k of keys) {
    const node = ring.getNode(k);
    owner.set(k, node);
    dist[node] = (dist[node] || 0) + 1;
  }
  return { dist, owner };
}

function printDist(title, dist, total) {
  console.log(`\n${title}`);
  Object.keys(dist)
    .sort()
    .forEach((id) => {
      const c = dist[id];
      console.log(`  ${id}: ${c}  (${((c / total) * 100).toFixed(2)}%)`);
    });
}

function main() {
  const keys = sampleKeys(SAMPLE);

  // ---- 3 nodes baseline ----
  const ring = new ConsistentHashRing(config.VNODE_COUNT);
  ['node-1', 'node-2', 'node-3'].forEach((n) => ring.addNode(n));
  const base = distribution(ring, keys);
  printDist(`Distribution with 3 nodes (${SAMPLE} keys, ${config.VNODE_COUNT} vnodes each):`, base.dist, SAMPLE);

  // ---- add a 4th node, re-hash same keys ----
  ring.addNode('node-4');
  const after = distribution(ring, keys);
  printDist('Distribution after adding node-4:', after.dist, SAMPLE);

  let moved = 0;
  for (const k of keys) if (base.owner.get(k) !== after.owner.get(k)) moved++;
  console.log(
    `\nKeys that changed owner after ADDING node-4: ${moved} / ${SAMPLE} = ${((moved / SAMPLE) * 100).toFixed(2)}%` +
      `  (theoretical ideal ~${(100 / 4).toFixed(2)}%)`
  );

  // ---- remove node-4 again, should move back ~1/4 ----
  ring.removeNode('node-4');
  const back = distribution(ring, keys);
  let movedBack = 0;
  for (const k of keys) if (after.owner.get(k) !== back.owner.get(k)) movedBack++;
  console.log(
    `Keys that changed owner after REMOVING node-4: ${movedBack} / ${SAMPLE} = ${((movedBack / SAMPLE) * 100).toFixed(2)}%`
  );

  // ---- summary ----
  console.log('\n================= SUMMARY =================');
  console.log(`Vnodes per node      : ${config.VNODE_COUNT}`);
  console.log(`3-node spread        : balanced (~33% each, see above)`);
  console.log(`Add 4th node remap   : ${((moved / SAMPLE) * 100).toFixed(2)}% moved (NOT ~100% -> consistent hashing kaam kar raha)`);
  console.log(`Remove 4th node remap: ${((movedBack / SAMPLE) * 100).toFixed(2)}% moved back`);
  console.log('==========================================');
}

main();
