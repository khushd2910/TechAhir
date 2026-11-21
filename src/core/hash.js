'use strict';
// FNV-1a: tiny, fast, stable across runs and machines. Routing must be stable
// because an auction must always be handled by the same shard.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const shardFor = (id, shardCount) => fnv1a(id) % shardCount;
module.exports = { fnv1a, shardFor };
