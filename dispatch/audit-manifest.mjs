// Builds AUDIT-MANIFEST.md from the evidence-*.json files that real runs wrote.
//
//   node audit-manifest.mjs            summarise the evidence and hash it
//   node audit-manifest.mjs --verify   also re-read every purchase from the chain
//
// Nothing here is invented: with no evidence files it stops, and every figure comes from a file or from the chain.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { ethers } from 'ethers';

const API = process.env.AP4M_API_URL ?? 'https://hackathon.ap4m.build';
const REDEEMED_TOPIC = ethers.id('VoucherRedeemed(bytes32,bytes32,bytes32,bytes32,address,bytes32,address,address,uint256,uint256,uint256)');
const EXPLORER = 'https://explorer.testnet.xrplevm.org/tx/';
const doVerify = process.argv.includes('--verify');
const fmt = (wei) => ethers.formatUnits(wei, 18);

const files = fs.readdirSync('.').filter((f) => /^evidence-r[a-z0-9]+\.json$/.test(f)).sort();
if (!files.length) {
  console.error('No evidence-*.json files here, so there is nothing to put in a manifest. Run `node demo.mjs` first.');
  process.exit(1);
}

const runs = [];
for (const file of files) {
  const bytes = fs.readFileSync(file);
  let ev;
  try { ev = JSON.parse(bytes.toString('utf8')); } catch (e) { console.error(`skipping ${file}: not valid JSON (${e.message})`); continue; }
  runs.push({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ev });
}

// The combined hash is over `sha256sum`-style lines, so anyone can recompute it from the files with standard tools.
const listing = runs.map((r) => `${r.sha256}  ${r.file}\n`).join('');
const manifestHash = crypto.createHash('sha256').update(listing).digest('hex');

let verification = null;
if (doVerify) {
  const cfg = await (await fetch(`${API}/public/config`, { signal: AbortSignal.timeout(20_000) })).json();
  const provider = new ethers.JsonRpcProvider((process.env.QUICKNODE_EVM_RPC_URL || cfg.network.rpcUrl), Number(cfg.network.chainId), { staticNetwork: true });
  const ledger = cfg.contracts.paymentLedger.toLowerCase();
  verification = { at: new Date().toISOString(), byTx: new Map() };
  for (const { ev } of runs) {
    for (const p of ev.purchases ?? []) {
      try {
        const r = await provider.getTransactionReceipt(p.tx);
        const hit = r?.logs.find((l) => l.address.toLowerCase() === ledger && l.topics[0] === REDEEMED_TOPIC);
        verification.byTx.set(p.tx, {
          ok: Boolean(r) && r.status === 1 && Boolean(hit) && hit.topics[2].toLowerCase() === String(p.claimId).toLowerCase(),
          block: r?.blockNumber ?? null, status: r?.status ?? null, eventFound: Boolean(hit),
        });
      } catch (e) { verification.byTx.set(p.tx, { ok: false, error: String(e.message ?? e).slice(0, 80) }); }
    }
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const spentOf = (ev) => (ev.spent ? BigInt(ev.spent) : 0n);
const policyRefusals = (ev) => [...new Map((ev.refusals ?? []).filter((r) => r.guard !== 'Unavailable').map((r) => [r.seller + r.guard, r])).values()];
const allPurchases = runs.flatMap((r) => r.ev.purchases ?? []);
const allRefusals = runs.flatMap((r) => policyRefusals(r.ev));
const byGuard = {};
for (const r of allRefusals) byGuard[r.guard] = (byGuard[r.guard] ?? 0) + 1;
const exact = runs.filter((r) => r.ev.payoutDeltaMatchesSpend === true).length;
const withPayoutCheck = runs.filter((r) => r.ev.payoutDeltaMatchesSpend !== undefined).length;

const L = [];
L.push('# Dispatch audit manifest', '');
L.push(`Generated ${new Date().toISOString()} from ${runs.length} evidence file${runs.length === 1 ? '' : 's'} in this folder.`, '');
L.push('## What this is, and is not', '');
L.push('- A summary of what real runs recorded, plus a SHA-256 over those files. Every figure below comes from an evidence file or, where marked, from a fresh read of the chain.');
L.push('- The hash lets you detect that a file changed **if you keep the hash somewhere other than this folder**. It is not a signature and it is not anchored on any chain.');
L.push('- It does not prove a run happened. The transactions do: each purchase below has a hash you can look up on the XRPL EVM Testnet explorer.');
L.push('- Refusals and peeks are the agent\'s own record. They leave nothing on a ledger, so nothing here can independently confirm them.');
const isLive = (ev) => ev.dataSource === 'live' || (ev.dataSource === undefined && ev.scenario === 'live-weather');
const liveRuns = runs.filter((r) => isLive(r.ev)).length;
L.push(`- Data bought: ${liveRuns} of ${runs.length} runs bought real data fetched from a public source when the seller started (Open-Meteo, FRED, the National Weather Service, or a site's own robots.txt). The other ${runs.length - liveRuns} were recorded before that change and bought sample fixture data, not a live measurement. The agent's decisions are plain code over integers, not an LLM.`, '');
L.push('## Totals', '');
L.push(`- Runs: ${runs.length}`);
L.push(`- Purchases: ${allPurchases.length}, totalling ${fmt(sum(runs.map((r) => spentOf(r.ev))))} RLUSD`);
L.push(`- Policy refusals by the agent (agent-reported): ${allRefusals.length}${Object.keys(byGuard).length ? ` (${Object.entries(byGuard).map(([g, n]) => `${g} x${n}`).join(', ')})` : ''}`);
L.push(`- Runs where the merchant payout balance rose by exactly the amount spent: ${exact} of ${withPayoutCheck} that recorded the check`);
if (verification) {
  const v = [...verification.byTx.values()];
  L.push(`- Purchases re-read from the chain at ${verification.at}: ${v.filter((x) => x.ok).length} of ${v.length} confirmed (receipt status 1, VoucherRedeemed found, claim id matches)`);
} else {
  L.push('- Purchases re-read from the chain: not done in this manifest. Run with `--verify`.');
}
L.push('', '## Hash', '');
L.push(`Combined SHA-256: \`${manifestHash}\``, '');
L.push('It is the SHA-256 of the following lines, which `sha256sum --text` prints for these files (plain `sha256sum` on Windows Git Bash adds a `*` binary marker, which changes the combined hash but not the per-file hashes):', '', '```', listing.trimEnd(), '```', '', 'To reproduce: `ls evidence-r*.json | LC_ALL=C sort | while read f; do sha256sum --text "$f"; done | sha256sum --text`', '');
L.push('## Runs', '');
for (const { file, sha256, ev } of runs) {
  const label = ev.scenario ? `${ev.scenario} (seed ${ev.seed})` : 'visibility-audit, first version (before scenarios)';
  L.push(`### ${label}`, '');
  L.push(`- Evidence file: \`${file}\`  sha256 \`${sha256.slice(0, 16)}…\``);
  L.push(`- Data: ${isLive(ev) ? 'real, fetched from a public source when the seller started' : 'sample fixture data (recorded before sellers fetched real data)'}`);
  if (ev.scenario) L.push(`- Replay: \`node demo.mjs --scenario ${ev.scenario} --seed ${ev.seed}\``);
  if (ev.mandate) L.push(`- Mandate: ceiling ${ev.mandate.perCallCeiling}, mission budget ${ev.mandate.missionBudget}, price within listing +${ev.mandate.priceTolerancePct}%`);
  L.push(`- Spent: ${fmt(spentOf(ev))} RLUSD across ${(ev.purchases ?? []).length} purchase(s); elapsed ${ev.elapsedSeconds ?? '?'}s${ev.settlementMode ? `; settlement ${ev.settlementMode}` : ''}`);
  if (ev.payoutDeltaMatchesSpend !== undefined) {
    L.push(`- Merchant payout balance: ${fmt(ev.payoutBefore)} -> ${fmt(ev.payoutAfter)} RLUSD (${ev.payoutDeltaMatchesSpend ? 'rose by exactly the spend' : 'did NOT match the spend'})`);
  }
  for (const p of ev.purchases ?? []) {
    const v = verification?.byTx.get(p.tx);
    const proof = v ? (v.ok ? `re-verified from chain, block ${v.block}` : `NOT confirmed on re-read${v.error ? ` (${v.error})` : ''}`) : `recorded at run time: status ${p.status ?? '?'}, event ${p.eventMatchesClaim ? 'matched' : 'unchecked'}`;
    L.push(`- Paid ${p.priceRlusd} RLUSD to ${p.seller}: [${p.tx.slice(0, 10)}…](${EXPLORER}${p.tx}), claim \`${String(p.claimId).slice(0, 10)}…\`; ${proof}`);
  }
  for (const r of policyRefusals(ev)) L.push(`- Refused ${r.seller} [${r.guard}] (agent-reported): ${r.reason}`);
  const gone = (ev.refusals ?? []).filter((r) => r.guard === 'Unavailable');
  for (const r of gone) L.push(`- Could not reach ${r.seller} (agent-reported): ${r.reason}`);
  if (!(ev.purchases ?? []).length) L.push('- No purchases: nothing met the policy.');
  L.push('');
}
fs.writeFileSync('AUDIT-MANIFEST.md', L.join('\n'));
console.log(`wrote AUDIT-MANIFEST.md  (${runs.length} runs, ${allPurchases.length} purchases, hash ${manifestHash.slice(0, 16)}…${doVerify ? ', chain re-read done' : ''})`);
