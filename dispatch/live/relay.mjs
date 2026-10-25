/**
 * live/relay.mjs — the pane's only connection to the chain.
 *
 * Holds the QuickNode WebSocket, subscribes once, and re-broadcasts what it
 * hears to every browser over Server-Sent Events. The browser never learns the
 * endpoint: a QuickNode URL carries its token in the path, so it is a
 * credential, and `audit/README.md` already states the rule this file obeys.
 * The pane is told the provider's name and nothing else.
 *
 * Push first, poll as the net. The order is the lesson from the settlement
 * watcher, and it matters:
 *
 *   1. open the socket and subscribe
 *   2. only then backfill the recent window
 *   3. then sit on the push
 *
 * Reversed, a payment can land between the history read and the subscription
 * and never be seen at all. A slow reconcile poll runs underneath purely to
 * catch a dropped socket; when it is the one producing rows, the pane is told
 * so, because a demo that silently degrades to polling while the chip still
 * says "live" is lying to the room.
 *
 *   node live/relay.mjs        → http://127.0.0.1:8787
 */

import { ethers } from 'ethers';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.dirname(HERE);

// ── Configuration ────────────────────────────────────────────────────────────

/** Values already in the environment win, then `.env`, the same order the
 *  ledger emitter uses. Quotes are stripped: this project's .env has them. */
function loadEnv() {
  for (const name of ['.env', path.join('prep', '.env')]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const cut = trimmed.indexOf('=');
      const key = trimmed.slice(0, cut).trim();
      const value = trimmed.slice(cut + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadEnv();

const WSS = (process.env.QUICKNODE_EVM_WSS_URL || process.env.AP4M_WSS_URL || '').trim();
const RPC = (process.env.QUICKNODE_EVM_RPC_URL || process.env.AP4M_RPC_URL
  || 'https://rpc.testnet.xrplevm.org').trim();

/** The provider's name, never its URL. This is the only thing the pane is told
 *  about where the data came from, and the only thing it needs. */
const sourceName = (url) => (/quiknode/i.test(url) ? 'QuickNode'
  : /xrplevm\.org/i.test(url) ? 'public XRPL EVM node' : 'configured node');

const LEDGER = (process.env.PAYMENT_LEDGER || '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91').trim();
const RLUSD = (process.env.RLUSD_TOKEN || '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3').trim();
const VAULT = (process.env.ESCROW_VAULT || '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0').trim();

// Public testnet addresses, the same two dispatch/pane/pane.mjs falls back to.
// Without them a clone with no .env renders two blank wallet cards, which
// reads as a broken pane rather than an unconfigured one. Nothing secret:
// these are on the ledger already.
const BUYER = (process.env.AP4M_AGENT_ADDRESS
  || '0x37f2f4166646ea3cea94bb37babd88a01f52a7a2').trim().toLowerCase();
const SELLER = (process.env.MERCHANT_PAYOUT_ADDRESS
  || '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8').trim().toLowerCase();
const CAP = (process.env.CHANNEL_CAP || '5').trim();
const PORT = Number(process.env.LIVE_PORT || 8787);
// Set once the Stream exists; until then an unsigned delivery is accepted so the
// first test payload can be read and the header name confirmed from it.
const WEBHOOK_TOKEN = (process.env.QUICKNODE_WEBHOOK_TOKEN || '').trim();
const BACKFILL_BLOCKS = Number(process.env.LIVE_BACKFILL_BLOCKS || 2000);

// This RPC rejects wide eth_getLogs ranges — 20,000 blocks returns "could not
// coalesce error", 2,000 answers. Walk the backfill in windows.
const LOG_WINDOW = 2000;
const RECONCILE_MS = 10_000;   // the net under the push, not the primary feed
const STALE_MS = 45_000;       // no head for this long means the socket is gone

if (!WSS) {
  console.error('No QUICKNODE_EVM_WSS_URL in the environment or .env.');
  console.error('The relay can still run on HTTP polling alone, but the point');
  console.error('of this pane is the push. Set the variable and start again.');
}

const VOUCHER = new ethers.Interface([
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
]);
const TRANSFER = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const VOUCHER_TOPIC = VOUCHER.getEvent('VoucherRedeemed').topicHash;
const TRANSFER_TOPIC = TRANSFER.getEvent('Transfer').topicHash;

// ── State ────────────────────────────────────────────────────────────────────

const clients = new Set();
const seen = new Set();              // `${txHash}:${logIndex}`, so a row is sent once
const tape = [];                     // recent rows, replayed to a browser that joins late
const traces = [];                   // what the agent and merchant say about their own HTTP
const blockTimes = new Map();        // blockNumber → unix seconds
const TAPE_LIMIT = 300;

let head = 0;
let lastPushAt = 0;
let lastBalances = null;             // so a browser that joins has dials from the first frame
let lastStreamAt = 0;                // last QuickNode Streams delivery
let transport = 'connecting';        // 'wss' | 'polling' | 'connecting'
let ws = null;
let reconnectDelay = 1000;

const rpc = new ethers.JsonRpcProvider(RPC);
const TAPE_FILE = path.join(HERE, 'tape.jsonl');

// ── Fan-out ──────────────────────────────────────────────────────────────────

function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(frame); } catch { clients.delete(client); }
  }
}

function record(row) {
  tape.push(row);
  if (tape.length > TAPE_LIMIT) tape.shift();
  // The tape is a rehearsal aid: the demo replays from it when the venue wifi
  // dies. It holds decoded events only, never the endpoint.
  try { fs.appendFileSync(TAPE_FILE, JSON.stringify(row) + '\n'); } catch { /* best effort */ }
}

function status(extra = {}) {
  return {
    transport,
    source: sourceName(transport === 'polling' ? RPC : WSS || RPC),
    head,
    lastPushAgoMs: lastPushAt ? Date.now() - lastPushAt : null,
    streams: lastStreamAt ? { lastAgoMs: Date.now() - lastStreamAt } : null,
    ...extra,
  };
}

// ── Decoding ─────────────────────────────────────────────────────────────────

async function blockTime(number) {
  if (blockTimes.has(number)) return blockTimes.get(number);
  const block = await rpc.getBlock(number).catch(() => null);
  const seconds = block?.timestamp ?? Math.floor(Date.now() / 1000);
  blockTimes.set(number, seconds);
  return seconds;
}

async function onVoucherLog(log, via) {
  const key = `${log.transactionHash}:${log.index ?? log.logIndex}`;
  if (seen.has(key)) return;
  seen.add(key);
  const { args } = VOUCHER.parseLog(log);
  const row = {
    kind: 'voucher',
    via,
    block: log.blockNumber,
    at: await blockTime(log.blockNumber),
    txHash: log.transactionHash,
    channelId: args.channelId,
    claimId: args.claimId,
    voucherDigest: args.voucherDigest,
    agent: args.agent.toLowerCase(),
    merchantId: args.merchantId,
    payout: args.payout.toLowerCase(),
    submitter: args.submitter.toLowerCase(),
    previous: args.previousCumulativeAmount.toString(),
    cumulative: args.cumulativeAmount.toString(),
    amount: args.amount.toString(),
    // Ours when our agent signed it or our merchant was paid. Everything else on
    // the ledger is another team's traffic, kept and marked rather than hidden.
    mine: args.agent.toLowerCase() === BUYER || args.payout.toLowerCase() === SELLER,
  };
  record(row);
  broadcast('voucher', row);
}

async function onTransferLog(log, via) {
  const key = `${log.transactionHash}:${log.index ?? log.logIndex}:t`;
  if (seen.has(key)) return;
  seen.add(key);
  const { args } = TRANSFER.parseLog(log);
  const row = {
    kind: 'transfer',
    via,
    block: log.blockNumber,
    at: await blockTime(log.blockNumber),
    txHash: log.transactionHash,
    from: args.from.toLowerCase(),
    to: args.to.toLowerCase(),
    value: args.value.toString(),
    // This is the only row in the pane where RLUSD actually moves. A voucher
    // advances a watermark; settlement is what pays the seller.
    settlement: args.from.toLowerCase() === VAULT.toLowerCase(),
    // A settlement out of the vault is still another team's unless it lands on
    // one of our two wallets. The pane's "Ours" filter reads this and nothing else.
    mine: args.to.toLowerCase() === SELLER || args.to.toLowerCase() === BUYER
      || args.from.toLowerCase() === BUYER,
  };
  record(row);
  broadcast('transfer', row);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Balances go over HTTP, not the socket. When the socket dies the dials keep
 *  working, and the pane keeps telling the truth about which feed it is on. */
async function balances() {
  const read = async (who) => {
    if (!who) return null;
    const data = ERC20.encodeFunctionData('balanceOf', [who]);
    const raw = await rpc.call({ to: RLUSD, data }).catch(() => null);
    return raw && raw !== '0x' ? ERC20.decodeFunctionResult('balanceOf', raw)[0].toString() : null;
  };
  const [buyer, seller, vault] = await Promise.all([read(BUYER), read(SELLER), read(VAULT)]);
  lastBalances = { buyer, seller, vault, at: Date.now() };
  broadcast('balances', lastBalances);
}

async function logsInWindows(filter, fromBlock, toBlock, window = LOG_WINDOW) {
  const found = [];
  for (let start = fromBlock; start <= toBlock; start += window) {
    const end = Math.min(start + window - 1, toBlock);
    try {
      found.push(...await rpc.getLogs({ ...filter, fromBlock: start, toBlock: end }));
    } catch (error) {
      if (window <= 25) throw error;
      found.push(...await logsInWindows(filter, start, end, Math.floor(window / 4)));
    }
  }
  return found;
}

async function backfill(fromBlock, toBlock, via) {
  if (fromBlock > toBlock) return;
  const vouchers = await logsInWindows({ address: LEDGER, topics: [VOUCHER_TOPIC] }, fromBlock, toBlock);
  vouchers.sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? 0) - (b.index ?? 0));
  for (const log of vouchers) await onVoucherLog(log, via);

  const transfers = await logsInWindows({ address: RLUSD, topics: [TRANSFER_TOPIC] }, fromBlock, toBlock);
  for (const log of transfers) {
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
    if (to === SELLER || to === BUYER || from === VAULT.toLowerCase()) await onTransferLog(log, via);
  }
}

// ── The socket ───────────────────────────────────────────────────────────────

async function connect() {
  if (!WSS) { transport = 'polling'; return; }
  try {
    ws = new ethers.WebSocketProvider(WSS);
    await ws.getNetwork();                       // fails fast on a bad endpoint
    const subscribedAt = await ws.getBlockNumber();
    transport = 'wss';
    lastPushAt = Date.now();
    head = subscribedAt;
    reconnectDelay = 1000;

    // 1. subscribe
    ws.on('block', (number) => {
      head = number;
      lastPushAt = Date.now();
      broadcast('head', status());
    });
    ws.on({ address: LEDGER, topics: [VOUCHER_TOPIC] }, (log) => {
      lastPushAt = Date.now();
      onVoucherLog(log, 'push').catch(() => {});
    });
    ws.on({ address: RLUSD, topics: [TRANSFER_TOPIC] }, (log) => {
      const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
      if (to !== SELLER && to !== BUYER && from !== VAULT.toLowerCase()) return;
      lastPushAt = Date.now();
      onTransferLog(log, 'push').catch(() => {});
    });

    broadcast('status', status());
    console.log(`subscribed to ${sourceName(WSS)} at block ${subscribedAt}`);

    // 2. only now read the recent window
    await backfill(Math.max(0, subscribedAt - BACKFILL_BLOCKS), subscribedAt, 'backfill');
    await balances();
    console.log(`backfilled ${BACKFILL_BLOCKS} blocks; ${tape.length} rows on the tape`);
  } catch (error) {
    transport = 'polling';
    broadcast('status', status({ note: 'socket unavailable' }));
    console.error('socket failed, falling back to polling:', error?.shortMessage ?? error?.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  setTimeout(async () => {
    try { await ws?.destroy(); } catch { /* already gone */ }
    ws = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    await connect();
  }, reconnectDelay);
}

/** The net. Catches what a dead or stalled socket missed, and — the part that
 *  matters for an honest chip — notices that the socket has gone quiet. */
async function reconcile() {
  try {
    const latest = await rpc.getBlockNumber();
    const stale = lastPushAt && Date.now() - lastPushAt > STALE_MS;
    if (stale && transport === 'wss') {
      transport = 'polling';
      console.error('no push for 45s; reconnecting');
      scheduleReconnect();
    }
    if (transport !== 'wss') head = latest;
    const from = Math.max(0, Math.min(head, latest) - 50);
    await backfill(from, latest, transport === 'wss' ? 'poll' : 'polling');
    broadcast('status', status());
  } catch (error) {
    broadcast('status', status({ note: 'reconcile failed' }));
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * The agent and merchant are the only witnesses to the HTTP exchange — steps 1,
 * 2, 3 and 5 never touch the chain, so no node can evidence them. They report
 * their own timeline here and the pane marks those steps *reported*, which is
 * the same measured/inferred line `audit/emit_from_ledger.py` draws. Step 4
 * stays measured: it comes from the ledger, not from this endpoint.
 *
 * Anything arriving here is a claim by a process, not evidence, so it is bounded
 * and checked before it is believed enough to render.
 */
function readTrace(request, response) {
  let body = '';
  let over = false;
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096 && !over) { over = true; request.destroy(); }
  });
  request.on('end', () => {
    if (over) return;
    let claim;
    try { claim = JSON.parse(body); } catch { response.writeHead(400).end('bad json'); return; }
    const step = Number(claim.step);
    const mark = String(claim.mark ?? '');
    if (!Number.isInteger(step) || step < 1 || step > 5
      || !['', 'ok', 'warn', 'fail'].includes(mark)) {
      response.writeHead(422).end('step must be 1-5 and mark one of ok, warn, fail');
      return;
    }
    const row = {
      kind: 'trace',
      step,
      mark,
      say: String(claim.say ?? '').slice(0, 120),
      role: String(claim.role ?? 'agent').slice(0, 16),
      operation: String(claim.operation ?? '').slice(0, 64),
      at: Date.now(),
      evidence: 'reported',
    };
    traces.push(row);
    if (traces.length > 40) traces.shift();
    broadcast('trace', row);
    response.writeHead(204).end();
  });
}

/**
 * QuickNode Streams delivers filtered XRPL EVM logs here, batched, with its own
 * backfill and reorg handling behind it. Same events the socket pushes, by a
 * different road: `seen` dedupes across both, so whichever arrives first wins
 * and the other is dropped. The tape records which road it came by.
 *
 * Non-200 makes Streams retry, so this answers 200 even for a payload it did
 * not understand — a retry of something unparseable is just the same failure
 * again, more often. What it could not read is logged instead.
 */
function readWebhook(request, response) {
  const chunks = [];
  let size = 0;
  let over = false;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > 4_000_000 && !over) { over = true; request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', async () => {
    if (over) return;
    const raw = Buffer.concat(chunks).toString('utf8');

    // The validation token is a shared secret, so compare it in constant time
    // and never log it. Header name confirmed against a real delivery below.
    if (WEBHOOK_TOKEN) {
      const offered = String(request.headers['x-qn-signature'] ?? request.headers['x-quicknode-signature']
        ?? request.headers['authorization'] ?? '');
      const expected = crypto.createHmac('sha256', WEBHOOK_TOKEN).update(raw).digest('hex');
      const ok = offered.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
      if (!ok) {
        console.error('[stream] signature did not verify; payload ignored');
        console.error('[stream] headers seen:', Object.keys(request.headers).join(', '));
        response.writeHead(401).end();
        return;
      }
    }

    let payload;
    try { payload = JSON.parse(raw); } catch {
      console.error('[stream] body was not JSON');
      response.writeHead(200).end(); return;
    }
    // Streams wraps the dataset differently per configuration, so take the
    // first array of log-shaped things rather than assuming one envelope.
    const batch = Array.isArray(payload) ? payload.flat(Infinity)
      : Array.isArray(payload?.data) ? payload.data.flat(Infinity)
      : Array.isArray(payload?.logs) ? payload.logs
      : [];
    if (!batch.length) {
      // Print a bounded preview, not the whole body: the first delivery of a new
      // Stream is the only way to learn the shape it actually sends.
      console.error('[stream] no logs found; keys:', Object.keys(payload ?? {}).join(', ') || '(none)',
        '| preview:', raw.slice(0, 400).replace(/\s+/g, ' '));
      response.writeHead(200).end(); return;
    }
    let matched = 0;
    let fresh = 0;
    for (const entry of batch) {
      const log = normalizeStreamLog(entry);
      if (!log || log.address?.toLowerCase() !== LEDGER.toLowerCase()) continue;
      if (log.topics?.[0]?.toLowerCase() !== VOUCHER_TOPIC.toLowerCase()) continue;
      matched += 1;
      const before = seen.size;
      try { await onVoucherLog(log, 'stream'); } catch { /* one bad row is not the batch */ }
      if (seen.size > before) fresh += 1;
    }
    lastStreamAt = Date.now();
    // "matched" is what the batch held; "new" is what this road got here first.
    // A matched event the socket already delivered is a duplicate, not a loss.
    console.log(`[stream] batch of ${batch.length}, ${matched} voucher event(s), ${fresh} new`);
    response.writeHead(200).end();
  });
}

/** Streams speaks hex where the socket speaks numbers. */
function normalizeStreamLog(entry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.topics)) return null;
  const number = (value) => (typeof value === 'string' && value.startsWith('0x')
    ? Number.parseInt(value, 16) : Number(value));
  return {
    address: entry.address,
    topics: entry.topics,
    data: entry.data,
    blockNumber: number(entry.blockNumber ?? entry.block_number),
    transactionHash: entry.transactionHash ?? entry.transaction_hash,
    index: number(entry.logIndex ?? entry.log_index ?? entry.index ?? 0),
  };
}

/**
 * The relay binds loopback, so the only way in from outside is the tunnel that
 * carries QuickNode's Stream deliveries — and a tunnel has no notion of who is
 * at the other end of it. `cf-connecting-ip` (or any forwarding header) is the
 * proxy saying "this hop is not local", which is all this needs: the webhook is
 * the one route meant to be reachable that way, and every other route — the
 * pane, the SSE feed, and `/trace`, which writes to the screen — stays
 * loopback-only. LIVE_PUBLIC=1 serves the pane through the tunnel too, as a
 * decision rather than an oversight.
 */
const PUBLIC_PANE = process.env.LIVE_PUBLIC === '1';
const throughProxy = (request) => Boolean(
  request.headers['cf-connecting-ip']
  || request.headers['x-forwarded-for']
  || request.headers['x-real-ip'],
);

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (!PUBLIC_PANE && url.pathname !== '/webhook' && throughProxy(request)) {
    response.writeHead(403, { 'Content-Type': 'text/plain' });
    response.end('loopback only; the tunnel carries /webhook and nothing else');
    return;
  }

  if (url.pathname === '/trace' && request.method === 'POST') { readTrace(request, response); return; }
  if (url.pathname === '/webhook' && request.method === 'POST') { readWebhook(request, response); return; }

  if (url.pathname === '/stream') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    clients.add(response);
    response.write(`event: hello\ndata: ${JSON.stringify({
      ...status(),
      buyer: BUYER, seller: SELLER, cap: CAP,
      contracts: { ledger: LEDGER, rlusd: RLUSD, vault: VAULT },
      explorer: 'https://explorer.testnet.xrplevm.org/tx/',
      balances: lastBalances,
      traces: traces.slice(-10),
      tape,
    })}\n\n`);
    request.on('close', () => clients.delete(response));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/pane.html') {
    const file = path.join(HERE, 'pane.html');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fs.readFileSync(file));
    return;
  }

  response.writeHead(404).end('not here');
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`live pane on http://127.0.0.1:${PORT}`);
  await connect();
  setInterval(reconcile, RECONCILE_MS);
  setInterval(balances, 15_000);
  setInterval(() => {
    for (const client of clients) { try { client.write(': keepalive\n\n'); } catch { /* dropped */ } }
  }, 15_000);
});
