import fs from 'node:fs';
import { runScenario, DEFAULT_POLICY } from './guards.mjs';
import { SOURCE_TAG } from './xrpl-tx.mjs';
import { TEST_AGENT, TEST_ATTACKER } from './voucher.mjs';

export async function runSuite(policy = DEFAULT_POLICY) {
  const { scenarios } = JSON.parse(fs.readFileSync(new URL('./attacks.json', import.meta.url), 'utf8'));
  const out = [];
  for (const s of scenarios) out.push(await runScenario(s, policy)); // each one signs its own EIP-712 voucher locally
  return out;
}

if (process.argv[1]?.endsWith('tripwire-engine.mjs')) {
  let policy = DEFAULT_POLICY, live = null;
  if (process.argv.includes('--live') || process.env.LIVE === '1') {
    const { loadLivePolicy } = await import('./live.mjs');
    live = await loadLivePolicy();
    policy = { ...DEFAULT_POLICY, cap: live.cap, redeemed: live.redeemed, channelId: live.source.channelId, domain: live.domain };
    console.log(`LIVE: ${live.source.chain} channel ${live.source.channelId} cap=${live.cap} redeemed=${live.redeemed} status=${live.source.status}`);
  }
  const results = await runSuite(policy);
  console.log(`signing: throwaway test key ${TEST_AGENT.address} (attacker ${TEST_ATTACKER.address}); domain ${policy.domain.verifyingContract} on chain ${policy.domain.chainId}${live ? ' (real ledger from public config)' : ' (offline stand-in ledger address)'}; no voucher is submitted`);
  for (const r of results) {
    console.log(`\n[${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
    if (r.skipped) { console.log(`  skipped  : ${r.skipped}`); continue; }
    console.log(`  injected : "${r.prompt}"`);
    console.log(`  pay()    : ${r.call.amount} RLUSD -> ${r.call.merchantId} @ ${r.call.payout}`);
    console.log(`  voucher  : cumulative ${r.call.voucher.cumulativeAmount} wei, signed by ${r.signedBy}`);
    console.log(`  result   : ${r.outcome}${r.guard ? ` by ${r.guard}` : ''} (expected ${r.expected_outcome}${r.expected_guard ? ` by ${r.expected_guard}` : ''})`);
    if (r.reason) console.log(`  reason   : ${r.reason}`);
    console.log(`  funds moved: ${r.fundsMoved}${r.authorised ? `  (authorised ${r.authorised})` : ''}`);
  }
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.pass).length;
  const skipped = results.length - ran.length;
  console.log(`\n${passed}/${ran.length} scenarios matched expectation${skipped ? ` (${skipped} skipped: the live channel has too little cap left to reach their guard)` : ''}`);
  fs.writeFileSync(new URL('./findings.json', import.meta.url), JSON.stringify({ timestamp: new Date().toISOString(), sourceTag: SOURCE_TAG, mode: live ? 'live-channel-state' : 'offline', signing: { testAgent: TEST_AGENT.address, testAttacker: TEST_ATTACKER.address, chainId: String(policy.domain.chainId), verifyingContract: policy.domain.verifyingContract, submitted: false }, live: live && { ...live.source, cap: String(live.cap), redeemed: String(live.redeemed) }, results }, null, 2));
  process.exit(passed === ran.length ? 0 : 1);
}
