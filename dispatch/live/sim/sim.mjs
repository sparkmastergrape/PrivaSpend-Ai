/**
 * live/sim/sim.mjs — rehearse the live pane with no network and no credentials.
 *
 * Starts a simulated XRPL EVM node (mock-node.mjs), then starts the real relay
 * (../relay.mjs) pointed at it. The relay and the pane are the real ones. Only
 * the node is invented, so every row, hash and balance on screen is invented.
 * Nothing here is measured, and nothing here says anything about QuickNode.
 *
 *   npm run live:sim              steady storyline
 *   npm run live:sim -- --drop    the socket goes silent mid-demo, then recovers
 *
 * The storyline: our buyer buys from our seller every few seconds, other teams
 * trade in the background, a cap is reached and refused, the channel settles and
 * a new one opens. The node tells the relay about each event by the socket and by
 * a signed Streams-style webhook, and lets the two race, as the real roads do.
 *
 *   SIM_BLOCK_MS=3000   block time           SIM_GAP_MS=9000   gap between purchases
 *   SIM_DROP_AT=45      seconds to the drop  SIM_DROP_FOR=80   seconds the socket is dead
 *   SIM_SEED=1449       same seed, same show LIVE_PORT=8787    where the pane is served
 */

import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { createChain, createNodeServer, VOUCHER_TOPIC } from './mock-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'relay.mjs');

// ── Configuration ────────────────────────────────────────────────────────────

const NODE_PORT = Number(process.env.SIM_NODE_PORT || 8546);
const PANE_PORT = Number(process.env.LIVE_PORT || 8787);
const BLOCK_MS = Number(process.env.SIM_BLOCK_MS || 3000);
const GAP_MS = Number(process.env.SIM_GAP_MS || 9000);
const DROP = process.argv.includes('--drop');
const DROP_AT_S = Number(process.env.SIM_DROP_AT || (DROP ? 45 : 0));
const DROP_FOR_S = Number(process.env.SIM_DROP_FOR || 80);
const CAP = process.env.SIM_CAP || '5';
const CAP_WEI = ethers.parseUnits(CAP, 18);
const STEP_WEI = ethers.parseUnits('0.20', 18);
const HISTORY_BLOCKS = 800;
const START_HEAD = 9_400_000;          // invented; chosen only to look like the real range

// The same public testnet addresses the relay defaults to. Nothing secret.
const LEDGER = '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91';
const RLUSD = '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3';
const VAULT = '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0';
const BUYER = '0x37f2f4166646ea3cea94bb37babd88a01f52a7a2';
const SELLER = '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8';

const WEBHOOK_TOKEN = 'sim-' + crypto.randomBytes(12).toString('hex');
const TAPE_FILE = path.join(os.tmpdir(), `privaspend-sim-tape-${process.pid}.jsonl`);

// ── Small helpers ────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(process.env.SIM_SEED || 1449));
const between = (low, high) => low + rand() * (high - low);
const pick = (list) => list[Math.floor(rand() * list.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (wei) => Number(ethers.formatUnits(wei, 18)).toFixed(2);
const stamp = () => new Date().toLocaleTimeString([], { hour12: false });
const say = (message) => console.log(`[sim ${stamp()}] ${message}`);

// ── The invented world ───────────────────────────────────────────────────────

const chain = createChain({ ledger: LEDGER, rlusd: RLUSD });
let claimCounter = 0;
let channelCounter = 0;

function newChannel(label, agent, payout) {
  channelCounter += 1;
  return {
    id: ethers.id(`sim-channel:${label}:${channelCounter}`),
    allocation: ethers.id(`sim-allocation:${label}:${channelCounter}`),
    agent, payout, cumulative: 0n,
  };
}

/** Advance a channel's watermark by `amount` and describe the redemption. */
function voucher(channel, amount) {
  claimCounter += 1;
  const previous = channel.cumulative;
  channel.cumulative += amount;
  return {
    channelId: channel.id, claimId: ethers.id(`sim-claim:${claimCounter}`),
    digest: ethers.id(`sim-digest:${claimCounter}`), allocationId: channel.allocation,
    agent: channel.agent, merchantId: ethers.id(`sim-merchant:${channel.payout}`),
    payout: channel.payout, submitter: channel.payout,
    previous, cumulative: channel.cumulative, amount,
  };
}

const fakeAddress = (label) => ethers.getAddress('0x' + ethers.id(`sim-address:${label}`).slice(26));
const others = Array.from({ length: 6 }, (_, index) =>
  newChannel(`team-${index}`, fakeAddress(`agent-${index}`), fakeAddress(`merchant-${index}`)));
let ours = newChannel('ours', BUYER, SELLER);

chain.setBalance(VAULT, ethers.parseUnits('1000', 18));
chain.setBalance(BUYER, ethers.parseUnits('250', 18));

// History: the relay backfills this on connect, so the pane starts with a tape.
{
  const nowSeconds = Math.floor(Date.now() / 1000);
  const blockSeconds = BLOCK_MS / 1000;
  const firstBlock = START_HEAD - HISTORY_BLOCKS + 1;
  const spacing = Math.floor(HISTORY_BLOCKS / 8);
  for (let number = firstBlock; number <= START_HEAD; number += 1) {
    const entries = [];
    const k = Math.floor((number - firstBlock) / spacing);
    if ((number - firstBlock) % spacing === spacing - 1 && k < 7) {
      entries.push(chain.voucherEntry(voucher(ours, ethers.parseUnits('0.50', 18))));
    }
    if (rand() < 0.06) entries.push(chain.voucherEntry(voucher(pick(others), BigInt(Math.round(between(1, 25))) * 10n ** 16n)));
    chain.addBlock(number, Math.round(nowSeconds - (START_HEAD - number) * blockSeconds), entries);
  }
}

// ── Delivery: the socket and the Stream, racing ──────────────────────────────

const node = createNodeServer({ chain, port: NODE_PORT });
const waiting = new Map();                 // txHash → resolve, for "wait until mined"
const minedAt = (txHash) => new Promise((resolve) => waiting.set(txHash, resolve));

async function postStream(logs) {
  const body = JSON.stringify({
    data: logs.map((log) => ({
      address: log.address, topics: log.topics, data: log.data, blockNumber: log.blockNumber,
      transactionHash: log.transactionHash, logIndex: log.logIndex,
    })),
  });
  const signature = crypto.createHmac('sha256', WEBHOOK_TOKEN).update(body).digest('hex');
  await fetch(`http://127.0.0.1:${PANE_PORT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qn-signature': signature },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* relay not up yet; the next block is another chance */ });
}

function tick() {
  const block = chain.mine(Math.floor(Date.now() / 1000));
  setTimeout(() => node.pushHead(block), between(30, 90));
  for (const log of block.logs) {
    // About one event in three, the socket is the slower road and the Stream wins.
    const slow = rand() < 0.3;
    setTimeout(() => node.pushLog(log), slow ? between(900, 1400) : between(60, 220));
    waiting.get(log.transactionHash)?.(block);
    waiting.delete(log.transactionHash);
  }
  // A Stream filtered to VoucherRedeemed never carries the RLUSD transfers.
  const vouchers = block.logs.filter((log) => log.topics[0] === VOUCHER_TOPIC);
  if (vouchers.length) setTimeout(() => postStream(vouchers), between(250, 800));
}

// ── Other teams, in the background ───────────────────────────────────────────

let otherEvents = 0;
function otherTraffic() {
  const channel = pick(others);
  otherEvents += 1;
  if (otherEvents % 8 === 0 && channel.cumulative > 0n) {
    chain.queue(chain.transferEntry({ from: VAULT, to: channel.payout, value: channel.cumulative }));
    channel.cumulative = 0n;
  } else {
    chain.queue(chain.voucherEntry(voucher(channel, BigInt(Math.round(between(1, 25))) * 10n ** 16n)));
  }
  setTimeout(otherTraffic, between(2500, 5500));
}

// ── Our two agents ───────────────────────────────────────────────────────────

let trace = () => {};
let operation = 0;

async function roundTrip() {
  operation += 1;
  const about = (role) => ({ role, operation: `sim-${operation}` });
  trace(1, 'ok', 'GET /resource', about('agent'));
  await sleep(350);
  trace(2, 'ok', `402 · ${fmt(STEP_WEI)} RLUSD asked`, about('merchant'));
  await sleep(500);

  const next = ours.cumulative + STEP_WEI;
  if (next > CAP_WEI) {
    // A guard that refuses never reaches the chain, so step 4 stays empty here.
    trace(3, 'fail', `${fmt(next)} would pass the ${CAP} RLUSD cap — not signed`, about('agent'));
    await sleep(3000);
    const value = ours.cumulative;
    const settled = minedAt(chain.queue(chain.transferEntry({ from: VAULT, to: SELLER, value })));
    await settled;
    say(`channel settled for ${fmt(value)} RLUSD; opening a new one`);
    ours = newChannel('ours', BUYER, SELLER);
    return;
  }

  trace(3, 'ok', `voucher signed · ${fmt(next)} cumulative`, about('agent'));
  await minedAt(chain.queue(chain.voucherEntry(voucher(ours, STEP_WEI))));
  await sleep(400);
  trace(5, 'ok', 'resource released', about('merchant'));
}

async function purchases() {
  await sleep(4000);
  for (;;) {
    await roundTrip();
    await sleep(GAP_MS);
  }
}

// ── Start everything ─────────────────────────────────────────────────────────

let relay = null;
function stop(code = 0) {
  try { relay?.kill(); } catch { /* already gone */ }
  try { node.close(); } catch { /* already closed */ }
  fs.rmSync(TAPE_FILE, { force: true });
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  await node.listen();
} catch (error) {
  console.error(`Cannot listen on 127.0.0.1:${NODE_PORT}: ${error.message}. Set SIM_NODE_PORT to another port.`);
  process.exit(1);
}

console.log('');
console.log('  SIMULATED NODE. Every block, hash, address and balance is invented.');
console.log('  This is not QuickNode and it is not the chain. The relay and pane are the real ones.');
console.log('');
console.log(`  simulated node   http://127.0.0.1:${NODE_PORT}  (WebSocket on the same port)`);
console.log(`  pane             http://127.0.0.1:${PANE_PORT}`);
console.log(`  block time       ${BLOCK_MS} ms${DROP_AT_S ? `   socket drops at ${DROP_AT_S} s for ${DROP_FOR_S} s` : ''}`);
console.log('');

relay = spawn(process.execPath, [RELAY], {
  env: {
    ...process.env,
    // Empty, not unset: the relay's .env loader only fills keys that are undefined,
    // so a real .env cannot point this run at a real node.
    QUICKNODE_EVM_WSS_URL: '', QUICKNODE_EVM_RPC_URL: '', LIVE_PUBLIC: '',
    AP4M_WSS_URL: `ws://127.0.0.1:${NODE_PORT}`,
    AP4M_RPC_URL: `http://127.0.0.1:${NODE_PORT}`,
    PAYMENT_LEDGER: LEDGER, RLUSD_TOKEN: RLUSD, ESCROW_VAULT: VAULT,
    AP4M_AGENT_ADDRESS: BUYER, MERCHANT_PAYOUT_ADDRESS: SELLER, CHANNEL_CAP: CAP,
    LIVE_PORT: String(PANE_PORT),
    LIVE_SOURCE_NAME: 'simulated node (not QuickNode)',
    LIVE_TAPE_FILE: TAPE_FILE,
    QUICKNODE_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const relayLines = (stream, out) => stream.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) if (line.trim()) out.write(`[relay] ${line}\n`);
});
relayLines(relay.stdout, process.stdout);
relayLines(relay.stderr, process.stderr);
relay.on('exit', (code) => { console.error(`[relay] exited with ${code}`); stop(code ?? 1); });

// The relay must be listening before the first Stream delivery or trace call.
for (let attempt = 0; attempt < 40; attempt += 1) {
  const up = await fetch(`http://127.0.0.1:${PANE_PORT}/`, { signal: AbortSignal.timeout(500) })
    .then((response) => response.ok).catch(() => false);
  if (up) break;
  await sleep(250);
}

process.env.LIVE_TRACE_URL = `http://127.0.0.1:${PANE_PORT}/trace`;
({ trace } = await import('../trace.mjs'));       // the real narration code, pointed at this relay

setInterval(tick, BLOCK_MS);
setTimeout(otherTraffic, 1500);
purchases();

if (DROP_AT_S) {
  setTimeout(() => { node.setStalled(true); say('the socket goes silent and refuses new connections'); }, DROP_AT_S * 1000);
  setTimeout(() => { node.setStalled(false); say('the socket works again'); }, (DROP_AT_S + DROP_FOR_S) * 1000);
}
say('running. Press Ctrl+C to stop.');
