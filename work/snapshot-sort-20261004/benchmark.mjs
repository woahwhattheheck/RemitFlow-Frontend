import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('Usage: node --expose-gc bench-transfer-snapshot.mjs BASELINE CANDIDATE');
const modules = await Promise.all(paths.map((p) => import(pathToFileURL(resolve(p)).href)));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gitBlob = (p) => {
  const bytes = readFileSync(p);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const options = { now: Date.parse('2026-10-04T12:00:00Z'), snapshotId: 'bench', pageSize: 5 };
const output = { node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model, sourceBlobs: paths.map(gitBlob), warmups: 2, pairedSamples: 5, workloads: [] };

// Exercise the exact pre-existing locale and sparse-array ordering contract.
const edge = [undefined, { id: 'z', createdAt: 'invalid' }, null, ,
  { id: 'a', createdAt: '1960-01-01T00:00:00Z' },
  ...['é', 'e\u0301', 'a', 'A', '😀', 'same', 'same'].map((id) => ({ id, createdAt: '1970-01-01T00:00:00Z' }))];
Object.freeze(edge);
const sorted = modules.map((m) => m.stableSortTransfers(edge));
assert.deepStrictEqual(sorted[0], sorted[1]);
for (let i = 0; i < edge.length; i++) {
  assert.equal(i in sorted[0], i in sorted[1]);
  assert.strictEqual(sorted[0][i], sorted[1][i]);
}
output.orderingCompatibility = 'matched references, stable ties, locale, invalid/epoch/pre-epoch dates, null, undefined and holes';

for (const [name, n, shuffle] of [['5k shuffled', 5000, true], ['100k shuffled', 100000, true], ['100k oldest-first', 100000, false]]) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `tx_${String(i).padStart(6, '0')}`, createdAt: new Date(options.now - (n - i) * 1000).toISOString(), status: 'completed', sendAmount: '10.00' }));
  if (shuffle) {
    let seed = 278;
    for (let i = n - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  }
  for (let i = 0; i < 2; i++) for (const m of modules) m.createTransferSnapshot(rows, options);
  const samplesMs = [[], []];
  for (let i = 0; i < 5; i++) {
    const snapshots = [];
    for (const version of i % 2 ? [1, 0] : [0, 1]) {
      global.gc?.();
      const start = performance.now();
      snapshots[version] = modules[version].createTransferSnapshot(rows, options);
      samplesMs[version].push(performance.now() - start);
    }
    assert.deepStrictEqual(snapshots[0], snapshots[1]);
  }
  const parseCalls = modules.map((m) => {
    let count = 0;
    const original = Date.parse;
    Date.parse = (...args) => { count++; return original(...args); };
    try { m.createTransferSnapshot(rows, options); } finally { Date.parse = original; }
    return count;
  });
  const mediansMs = samplesMs.map(median);
  output.workloads.push({ name, n, samplesMs, mediansMs, speedup: mediansMs[0] / mediansMs[1], parseCalls });
}
console.log(JSON.stringify(output, null, 2));
