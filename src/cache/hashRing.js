const crypto = require('crypto');

// Ring position = md5(key) ke pehle 4 bytes ko uint32 banaya. Stable + well-distributed,
// aur crypto built-in hai isliye koi extra dependency nahi.
function hash(key) {
  const digest = crypto.createHash('md5').update(key).digest();
  return digest.readUInt32BE(0);
}

class ConsistentHashRing {
  constructor(vnodeCount) {
    this.vnodeCount = vnodeCount;
    this.ring = []; // sorted array of { pos, nodeId }
  }

  addNode(nodeId) {
    // sirf 3 physical nodes ring pe daalne se load uneven hota hai; har node ke ~150 virtual
    // replicas daalne se distribution smooth ho jata hai (Ketama approach).
    for (let i = 0; i < this.vnodeCount; i++) {
      this.ring.push({ pos: hash(`${nodeId}#${i}`), nodeId });
    }
    this.ring.sort((a, b) => a.pos - b.pos);
  }

  removeNode(nodeId) {
    // Us node ke saare vnodes hata do (remapping demo ke liye).
    this.ring = this.ring.filter((v) => v.nodeId !== nodeId);
  }

  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = hash(key);

    // Clockwise lookup: pehla ring point jiska pos >= h. Binary search se O(log n).
    let lo = 0;
    let hi = this.ring.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].pos >= h) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    // Agar koi point >= h nahi mila to ring ke end se aage nikal gaye -> wrap to index 0.
    if (ans === -1) ans = 0;
    return this.ring[ans].nodeId;
  }
}

module.exports = { ConsistentHashRing, hash };
