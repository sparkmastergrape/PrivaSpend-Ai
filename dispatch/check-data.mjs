// Keyless check of the real data. No wallet, no merchant, no payment: for every scenario it runs each seller's live()
// source, confirms the answer is real (not a placeholder) and canonical-JSON safe, then runs the scenario's own
// reasoning on that real content through the real policy. Needs internet; fails closed if a source is down.
//   node check-data.mjs [seed]
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { canonicalJson } from '@ap4m/sdk';
import { decide } from './policy.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { makeRng } from './rng.mjs';

const PAYOUT = '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8', ASSET = '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3';
const trusted = { payout: PAYOUT, asset: ASSET };
const w = (v) => ethers.parseUnits(v, 18);
const seed = Number(process.argv[2] ?? 7);
let failures = 0;

for (const sc of SCENARIOS) {
  const built = sc.build(makeRng(seed ^ 0x9e3779b9));
  console.log(`\n${sc.id}  (seed ${seed})`);
  for (const s of built.sellers) {
    if (s.down) { console.log(`  ${s.id.padEnd(20)} down by design, not fetched`); continue; }
    try {
      s.content = await s.live();
      if (s.metaFrom) s.meta = s.metaFrom(s.content);
      assert.ok(!s.content.placeholder, 'served a placeholder');
      canonicalJson({ ...s.content, measuredAt: new Date().toISOString() });
      console.log(`  ${s.id.padEnd(20)} LIVE ok   ${s.content.source ?? s.content.domain}`);
    } catch (e) { failures++; s.down = true; console.log(`  ${s.id.padEnd(20)} FAILED   ${e.message}`); }
  }
  let spent = 0n;
  const quote = (s) => (s.down ? null : { price: w(s.price), decision: decide({ required: { accepts: [{ amount: w(s.price).toString(), payTo: PAYOUT, asset: ASSET }] }, listing: s, trusted, policy: sc.policy, spent, channelRemaining: w('10') }) });
  const find = (id) => built.sellers.find((s) => s.id === id);
  const lines = [];
  const ctx = {
    log: (m) => lines.push(m), sellers: built.sellers,
    async peek(id) { return quote(find(id)); },
    async buy(id) { const q = quote(find(id)); if (!q || !q.decision.buy) return null; spent += q.price; return find(id).content; },
  };
  await built.run(ctx);
  console.log(lines.filter((l) => l.trim()).map((l) => `    ${l.trim()}`).join('\n'));
  console.log(`    (nothing was paid; simulated spend ${ethers.formatUnits(spent, 18)} RLUSD of ${sc.policy.missionBudget})`);
}
console.log(failures ? `\n${failures} source(s) failed` : '\nall live sources answered with real data');
process.exit(failures ? 1 : 0);
