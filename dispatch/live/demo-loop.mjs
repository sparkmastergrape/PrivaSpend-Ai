/**
 * live/demo-loop.mjs — give the pane something of ours to show.
 *
 * The pane reads the whole PaymentLedger, so during the event it is never
 * empty: other teams' traffic fills it. This drives our own buyer through a
 * few real purchases from our own merchant, so the rows marked *ours* are ours.
 *
 * Two terminals:
 *
 *   node x402-merchant.mjs            # the seller, must be running first
 *   node live/demo-loop.mjs 3         # the buyer, three purchases
 *
 * Every purchase is real: a signed voucher, an on-chain redemption, RLUSD
 * authorized against the funded cap. Nothing here is simulated, which is the
 * point — a pane fed by a mock proves nothing.
 *
 *   DEMO_GAP_MS=8000   pause between purchases, so a room can follow it
 *   DEMO_CEILING=0.10  the agent's per-purchase mandate, in RLUSD
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ethers } from 'ethers';
import { loadX402Context, buyResource } from '../ap4m-x402.mjs';
import { decodeX402PaymentRequired } from '@ap4m/sdk';
import sdk from '../ap4m-hackathon-sdk.cjs';
import { trace, traceReset } from './trace.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue;
  const cut = line.indexOf('=');
  const key = line.slice(0, cut).trim();
  const value = line.slice(cut + 1).trim().replace(/^["']|["']$/g, '');
  // The shell wins, so one run can be configured without editing a shared .env.
  if (value && process.env[key] === undefined) process.env[key] = value;
}

const API = process.env.AP4M_API_URL;
const RESOURCE = `http://127.0.0.1:${process.env.MERCHANT_PORT ?? 8402}/resource`;
const COUNT = Number(process.argv[2] ?? 3);
const GAP_MS = Number(process.env.DEMO_GAP_MS ?? 8000);
const CEILING = process.env.DEMO_CEILING ?? '0.10';
const CAP = process.env.CHANNEL_CAP ?? '5';
// The agent reads the chain through QuickNode too when it is configured, so the
// demo and the pane are looking at the same node.
const RPC = process.env.QUICKNODE_EVM_RPC_URL || process.env.AP4M_RPC_URL
  || 'https://rpc.testnet.xrplevm.org';

const rlusd = (wei) => ethers.formatUnits(wei, 18);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(message);

// ── The seller has to be up first ────────────────────────────────────────────
const probe = await fetch(RESOURCE, { method: 'GET' }).catch(() => null);
if (!probe) {
  console.error(`No merchant answering at ${RESOURCE}.`);
  console.error('Start the seller first, in its own terminal:\n');
  console.error('    node x402-merchant.mjs\n');
  process.exit(1);
}
// Any answer means it is up. A bare GET with no channel header is a 400 by
// design, so the status is not worth printing — only that someone replied.
log(`seller is up at ${RESOURCE}`);

// ── The buyer ────────────────────────────────────────────────────────────────
const context = await loadX402Context(API);
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const session = await sdk.signIn(API, process.env.TEAM_NAME, wallet);

// Reuse an open channel. Opening one costs gas and the cap is per channel, so a
// demo that opened a fresh channel each run would be burning the budget to no end.
const channels = await sdk.listChannels(API, session.token);
const open = channels.find((channel) => channel.channel_status === 'open');
// Without a funded channel there is nothing to pay with — but the HTTP exchange
// still happens, and a refusal is a result worth showing. The run then stops at
// step 3 and says why, rather than pretending it could not reach the merchant.
if (!open) {
  console.error(`No open channel (${channels.length} on this account, none open).`);
  console.error('x402-agent.mjs requests one when none is open — but a payout binding');
  console.error('allows only 12 channel requests, and a failed request spends one of');
  console.error('them. At 12, requestChannel reverts with PayoutBindingRequestLimitExceeded');
  console.error('and a new allocation has to be funded in the participant portal.');
  console.error('\nRunning the exchange anyway. Expect no 402: the merchant resolves the');
  console.error('channel before pricing, and one it cannot use is answered 503');
  console.error('payment_pending_or_unavailable. That refusal is real,');
  console.error('and the pane will show exactly how far it got.\n');
}
const channel = open ?? channels[0];
if (!channel) { console.error('No channels at all on this account.'); process.exit(1); }
const channelId = channel.channel_id;

log(`buyer  ${wallet.address}`);
log(`seller ${process.env.MERCHANT_PAYOUT_ADDRESS}`);
log(`channel ${channelId.slice(0, 18)}…  cap ${CAP} RLUSD`);
log(`${COUNT} purchase(s), ${GAP_MS / 1000}s apart — watch the pane\n`);

const run = Date.now().toString(36);
const results = [];
for (let index = 1; index <= COUNT; index += 1) {
  // A new operation name every time. Reusing one returns the earlier purchase
  // rather than making a new payment, and the pane would show nothing new.
  const operation = `live-${run}-${index}`;
  const started = Date.now();
  traceReset();

  // ── 1 & 2. Ask without paying, and read the price back ─────────────────────
  trace(1, 'ok', `GET /resource`, { operation });
  const challenge = await fetch(RESOURCE, { headers: { 'X-AP4M-CHANNEL-ID': channelId } })
    .catch(() => null);
  if (!challenge || challenge.status !== 402) {
    trace(2, 'fail', challenge ? `HTTP ${challenge.status}` : 'no answer', { operation });
    log(`${index}/${COUNT}  merchant did not answer with a 402`);
    break;
  }
  const required = decodeX402PaymentRequired(challenge.headers.get('payment-required') ?? '');
  const price = BigInt(required.accepts[0].amount);
  trace(2, 'ok', `${rlusd(price)} RLUSD asked`, { operation });

  // The ceiling is the agent's whole mandate. Over it, it refuses — in red.
  if (price > ethers.parseUnits(CEILING, 18)) {
    trace(3, 'fail', `over the ${CEILING} RLUSD ceiling — refused`, { operation });
    trace(5, 'fail', 'not released', { operation });
    log(`${index}/${COUNT}  refused on price: ${rlusd(price)} > ${CEILING}`);
    break;
  }
  if (!open) {
    trace(3, 'fail', 'no funded channel to sign against', { operation });
    trace(5, 'fail', 'not released', { operation });
    log(`${index}/${COUNT}  priced at ${rlusd(price)} RLUSD, but there is no open channel to pay from`);
    break;
  }

  // ── 3 & 5. Sign, pay, take the resource. Step 4 the pane reads from chain ──
  trace(3, 'ok', `voucher signed for ${rlusd(price)} RLUSD`, { operation });
  try {
    const result = await buyResource({
      context,
      provider,
      wallet,
      stateDirectory: process.env.DEMO_STATE_DIR ?? path.join(ROOT, '.live-demo-state'),
      resourceUrl: RESOURCE,
      channelId,
      maximumAmount: ethers.parseUnits(CEILING, 18).toString(),
      operation,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    results.push(result);
    trace(5, 'ok', `released in ${elapsed}s`, { operation });
    log(`${index}/${COUNT}  ${result.redemption.toLowerCase()} in ${elapsed}s`
      + `  claim ${result.claimId.slice(0, 14)}…  tx ${result.transactionHash.slice(0, 14)}…`);
  } catch (error) {
    // A refusal is a result, not a crash: the cap doing its job looks like this.
    trace(5, 'fail', 'not released', { operation });
    log(`${index}/${COUNT}  refused — ${error?.shortMessage ?? error?.message}`);
    log('  resume this operation with the same arguments before starting another:');
    log(`  operation "${operation}"`);
    break;
  }
  if (index < COUNT) await sleep(GAP_MS);
}

// ── What the chain now says ──────────────────────────────────────────────────
const LEDGER = '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91';
const voucher = new ethers.Interface([
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
]);
const head = await provider.getBlockNumber();
const logs = await provider.getLogs({
  address: LEDGER,
  topics: [voucher.getEvent('VoucherRedeemed').topicHash, channelId],
  fromBlock: head - 500,
  toBlock: head,
}).catch(() => []);

log(`\n${results.length} of ${COUNT} purchases completed.`);
if (logs.length) {
  const latest = voucher.parseLog(logs[logs.length - 1]);
  log(`channel cumulative now ${rlusd(latest.args.cumulativeAmount)} of ${CAP} RLUSD`);
  log(`${logs.length} VoucherRedeemed event(s) on this channel in the last 500 blocks`);
}
log('Each row is on the ledger; the pane read it from the chain, not from this script.');
