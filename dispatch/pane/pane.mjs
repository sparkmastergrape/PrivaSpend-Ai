// Dispatch desk: serves the pane and two read-only endpoints.
//   node pane/pane.mjs            then open http://localhost:8810
//
// /api/runs    every evidence-*.json the demo has written, newest first
// /api/verify  re-reads a run's purchases from the chain, independently of the saved file
//
// This process holds no keys and sends no transactions.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PANE_PORT ?? 8810);
const API = process.env.AP4M_API_URL ?? 'https://hackathon.ap4m.build';
const REDEEMED_TOPIC = ethers.id('VoucherRedeemed(bytes32,bytes32,bytes32,bytes32,address,bytes32,address,address,uint256,uint256,uint256)');
const RUN_ID = /^r[a-z0-9]{4,20}$/;

// ── live wallets: the two balances a judge watches, read from the chain by this server ───────────────
// The RPC URL (a QuickNode URL carries its token in the path) is read here and never sent to the browser.
const sdk = createRequire(import.meta.url)('../ap4m-hackathon-sdk.cjs');
const CHAIN_ID = 1449000;
const WATCH = {
  agent: (process.env.WATCH_AGENT ?? '0x37f2f4166646ea3cea94bb37babd88a01f52a7a2').toLowerCase(),
  merchant: (process.env.WATCH_MERCHANT ?? '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8').toLowerCase(),
};
const RPC_KEYS = ['QUICKNODE_EVM_RPC_URL', 'XRPL_EVM_RPC_URL'];
const clean = (e) => String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 140);
// Error text can carry the endpoint's host, so anything about the RPC shows a short code, never the message.
const why = (e) => (e?.code && /^[A-Z_]{3,24}$/.test(String(e.code)) ? e.code : /timed out/.test(String(e?.message)) ? 'TIMEOUT' : 'ERROR');
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);

// Only the two RPC variables are read from an env file; no other line is kept.
function configured(KEYS) {
  for (const k of KEYS) if (process.env[k]) return process.env[k];
  const files = [process.env.ENV_FILE, path.resolve(ROOT, '../../ap4m-hackathon/.env'), path.resolve(ROOT, '../../ap4m-hackathon/prep/.env')].filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i < 1 || line.trim().startsWith('#')) continue;
      if (!KEYS.includes(line.slice(0, i).trim())) continue;
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  return null;
}
const configuredRpcUrl = () => configured(RPC_KEYS);
const providerLabel = (url) => { try { return new URL(url).hostname.endsWith('quiknode.pro') ? 'QuickNode' : 'custom RPC'; } catch { return 'custom RPC'; } };

let cfgCache = null, rpcCache = null, walletsCache = null;
async function getCfg() {
  if (cfgCache && Date.now() - cfgCache.at < 300_000) return cfgCache.value;
  const value = await (await fetch(`${API}/public/config`, { signal: AbortSignal.timeout(15_000) })).json();
  cfgCache = { at: Date.now(), value };
  return value;
}
// Use the configured endpoint only if it answers and is on the right chain; otherwise say so and use the public node.
async function getRpc(cfg) {
  if (rpcCache && Date.now() - rpcCache.at < 60_000) return rpcCache;
  const url = configuredRpcUrl();
  let note = url ? null : 'no QuickNode endpoint configured (set QUICKNODE_EVM_RPC_URL)';
  if (url) {
    // QuickNode accepts the token in the URL path or in an x-token header. With QUICKNODE_EVM_TOKEN set, the URL
    // is used without a token in it and the token travels in the header.
    const req = new ethers.FetchRequest(url);
    const token = configured(['QUICKNODE_EVM_TOKEN']);
    if (token) req.setHeader('x-token', token);
    const p = new ethers.JsonRpcProvider(req, CHAIN_ID, { staticNetwork: true });
    try {
      const id = BigInt(await within(p.send('eth_chainId', []), 8000));
      if (id === BigInt(CHAIN_ID)) { rpcCache?.provider.destroy(); return (rpcCache = { at: Date.now(), provider: p, label: providerLabel(url), note: null }); }
      note = `configured endpoint is on chain ${id}, expected ${CHAIN_ID}; using the public node`;
    } catch (e) { note = `configured endpoint did not answer (${why(e)}); using the public node`; }
    p.destroy();
  }
  rpcCache?.provider.destroy();
  return (rpcCache = { at: Date.now(), provider: new ethers.JsonRpcProvider(cfg.network.rpcUrl, CHAIN_ID, { staticNetwork: true }), label: 'public node', note });
}

async function pollWallets() {
  if (walletsCache && Date.now() - walletsCache.at < 1000) return walletsCache.value;
  const cfg = await getCfg();
  const rpc = await getRpc(cfg);
  const token = new ethers.Contract(cfg.contracts.rlusdToken, ['function balanceOf(address) view returns (uint256)'], rpc.provider);
  const channelId = loadRuns()[0]?.channelId;
  const fmt = (v) => ethers.formatUnits(v, 18);
  const t0 = Date.now();
  try {
    const [block, aTok, mTok, aNat, mNat, st] = await within(Promise.all([
      rpc.provider.getBlockNumber(),
      token.balanceOf(WATCH.agent), token.balanceOf(WATCH.merchant),
      rpc.provider.getBalance(WATCH.agent), rpc.provider.getBalance(WATCH.merchant),
      channelId ? sdk.getChannelState(rpc.provider, cfg.contracts.paymentLedger, channelId).catch(() => null) : null,
    ]), 15_000);
    const value = {
      ok: true, polledAt: new Date().toISOString(), latencyMs: Date.now() - t0,
      provider: { label: rpc.label, note: rpc.note }, chain: { id: CHAIN_ID, block },
      agent: { address: WATCH.agent, rlusd: fmt(aTok), native: fmt(aNat) },
      merchant: { address: WATCH.merchant, rlusd: fmt(mTok), native: fmt(mNat) },
      channel: st ? { id: channelId, cap: fmt(st.cap), redeemed: fmt(st.redeemed), remaining: fmt(st.cap - st.redeemed) } : null,
    };
    walletsCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    rpcCache = null; // re-check the endpoint on the next poll
    return { ok: false, polledAt: new Date().toISOString(), provider: { label: rpc.label, note: rpc.note }, error: why(e) };
  }
}

function loadRuns() {
  return fs.readdirSync(ROOT)
    .filter((f) => /^evidence-r[a-z0-9]+\.json$/.test(f))
    .map((f) => {
      try {
        const ev = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
        ev.startedAt = new Date(parseInt(String(ev.runId).slice(1), 36)).toISOString();
        return ev;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

// ── agents: live-<runId>.json files written by running agents (live.mjs). Running = fresh heartbeat AND live process. ──
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function listAgents() {
  const now = Date.now();
  return fs.readdirSync(ROOT).filter((f) => /^live-r[a-z0-9]+\.json$/.test(f)).map((f) => {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      const age = now - Date.parse(a.updatedAt);
      const status = a.state !== 'running' ? a.state : (age < 15_000 && pidAlive(a.pid)) ? 'running' : 'stopped';
      return { runId: a.runId, scenario: a.scenario, title: a.title, seed: a.seed, status, startedAt: a.startedAt, updatedAt: a.updatedAt,
        elapsedSec: Math.round(((status === 'running' ? now : Date.parse(a.updatedAt)) - Date.parse(a.startedAt)) / 1000), lines: a.lines.slice(-14), result: a.result };
    } catch { return null; }
  }).filter((a) => a && (a.status === 'running' || now - Date.parse(a.updatedAt) < 6 * 3600_000))
    .sort((x, y) => (x.status === 'running') === (y.status === 'running') ? (x.startedAt < y.startedAt ? 1 : -1) : x.status === 'running' ? -1 : 1).slice(0, 6);
}

// ── redemptions on the watched channel: every VoucherRedeemed, flagged when no saved run accounts for it ──
const LOOKBACK = Number(process.env.REDEEM_LOOKBACK_BLOCKS ?? 9000);
let redeem = { channel: null, scanned: 0, rows: [], at: 0, value: null };
let redeemInFlight = null;
// One scan at a time: two overlapping scans would both append the same logs.
function pollRedemptions() {
  if (redeem.value && Date.now() - redeem.at < 5000) return Promise.resolve(redeem.value);
  return (redeemInFlight ??= scanRedemptions().finally(() => { redeemInFlight = null; }));
}
async function scanRedemptions() {
  const cfg = await getCfg();
  const rpc = await getRpc(cfg);
  const runs = loadRuns();
  const channelId = runs[0]?.channelId;
  if (!channelId) return { ok: true, channel: null, rows: [] };
  const ch = channelId.slice(2).toLowerCase();
  // redeem tx -> which saved run and seller it belongs to
  const mine = new Map(runs.flatMap((r) => (r.purchases ?? []).map((p) => [p.tx.toLowerCase(), { run: r.runId, scenario: r.scenario ?? null, seller: p.seller }])));
  try {
    const head = await within(rpc.provider.getBlockNumber(), 10_000);
    if (redeem.channel !== channelId) redeem = { channel: channelId, scanned: head - LOOKBACK, rows: [], at: 0, value: null };
    for (let b = redeem.scanned + 1; b <= head; b += 1000) {
      const logs = await within(rpc.provider.getLogs({ address: cfg.contracts.paymentLedger, topics: [REDEEMED_TOPIC], fromBlock: b, toBlock: Math.min(b + 999, head) }), 20_000);
      for (const l of logs) {
        if (!(l.topics.join('') + l.data).toLowerCase().includes(ch)) continue;
        if (redeem.rows.some((x) => x.tx === l.transactionHash && x.index === l.index)) continue;
        const words = l.data.slice(2).match(/.{64}/g) ?? [];
        const blk = await rpc.provider.getBlock(l.blockNumber);
        redeem.rows.push({ tx: l.transactionHash, claim: l.topics[2] ?? null, index: l.index, block: l.blockNumber, at: blk ? blk.timestamp * 1000 : null,
          amount: ethers.formatUnits(BigInt('0x' + words[words.length - 1]), 18), cumulative: ethers.formatUnits(BigInt('0x' + words[words.length - 2]), 18) });
      }
      redeem.scanned = Math.min(b + 999, head);
    }
    const now = Date.now();
    const value = { ok: true, channel: channelId, head, lookbackBlocks: LOOKBACK, provider: rpc.label,
      rows: [...redeem.rows].reverse().map((r) => ({ ...r, ...(mine.get(r.tx.toLowerCase()) ?? {}), recorded: mine.has(r.tx.toLowerCase()), ageSec: r.at ? Math.round((now - r.at) / 1000) : null })) };
    redeem.value = value; redeem.at = now;
    return value;
  } catch (e) { rpcCache = null; return { ok: false, error: why(e) }; }
}

async function verify(runId) {
  const ev = loadRuns().find((r) => r.runId === runId);
  if (!ev) return { status: 404, body: { error: 'unknown run' } };
  const cfg = await (await fetch(`${API}/public/config`, { signal: AbortSignal.timeout(20_000) })).json();
  const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, Number(cfg.network.chainId), { staticNetwork: true });
  const ledger = cfg.contracts.paymentLedger.toLowerCase();
  const purchases = [];
  for (const p of ev.purchases ?? []) {
    const r = await provider.getTransactionReceipt(p.tx);
    const hit = r?.logs.find((l) => l.address.toLowerCase() === ledger && l.topics[0] === REDEEMED_TOPIC);
    purchases.push({
      seller: p.seller, tx: p.tx, found: Boolean(r), status: r?.status ?? null, block: r?.blockNumber ?? null,
      eventFound: Boolean(hit), claimMatches: hit?.topics[2]?.toLowerCase() === String(p.claimId).toLowerCase(),
    });
  }
  const token = new ethers.Contract(cfg.contracts.rlusdToken, ['function balanceOf(address) view returns (uint256)'], provider);
  const payoutNow = await token.balanceOf(ev.payout);
  return { status: 200, body: { runId, checkedAt: new Date().toISOString(), purchases, payoutBalanceNowRlusd: ethers.formatUnits(payoutNow, 18) } };
}

// ── push layer: optional WebSocket subscription (QUICKNODE_EVM_WSS_URL). Polling keeps working without it. ──
const watchers = new Set();
const live = { mode: 'polling', note: configured(['QUICKNODE_EVM_WSS_URL']) ? 'connecting' : 'no WSS endpoint configured (set QUICKNODE_EVM_WSS_URL)', lastBlock: null };
const emit = (type, data = {}) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const r of watchers) r.write(msg); };
async function startLive(retryMs = 5000) {
  const url = configured(['QUICKNODE_EVM_WSS_URL']);
  if (!url) return;
  let ws;
  const retry = (note) => { live.mode = 'polling'; live.note = note; emit('mode', live); setTimeout(() => startLive(Math.min(retryMs * 2, 60_000)), retryMs).unref(); };
  try {
    const token = configured(['QUICKNODE_EVM_TOKEN']);
    const sock = new WebSocket(url, token ? { headers: { 'x-token': token } } : undefined);
    ws = new ethers.WebSocketProvider(sock, CHAIN_ID, { staticNetwork: true });
    const id = BigInt(await within(ws.send('eth_chainId', []), 8000));
    if (id !== BigInt(CHAIN_ID)) { ws.destroy(); return retry(`WSS endpoint is on chain ${id}, expected ${CHAIN_ID}`); }
    const cfg = await getCfg();
    live.mode = 'websocket'; live.note = null; emit('mode', live);
    ws.on('block', (n) => { live.lastBlock = n; walletsCache = null; emit('block', { block: n }); });
    ws.on({ address: cfg.contracts.paymentLedger, topics: [REDEEMED_TOPIC] }, (log) => {
      walletsCache = null;
      emit('redeemed', { tx: log.transactionHash, block: log.blockNumber });
    });
    sock.addEventListener('close', () => retry('WSS closed; polling until it reconnects'));
    sock.addEventListener('error', () => {});
  } catch (e) { try { ws?.destroy(); } catch {} retry(`WSS did not connect (${why(e)}); polling`); }
}
startLive();

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'read only' });
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html'), 'utf8'), 'text/html');
    if (url.pathname === '/wallets') return send(res, 200, fs.readFileSync(path.join(HERE, 'wallets.html'), 'utf8'), 'text/html');
    if (url.pathname === '/api/wallets') return send(res, 200, await pollWallets());
    if (url.pathname === '/api/live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: mode\ndata: ${JSON.stringify(live)}\n\n`);
      watchers.add(res); req.on('close', () => watchers.delete(res));
      return;
    }
    if (url.pathname === '/api/agents') return send(res, 200, { agents: listAgents() });
    if (url.pathname === '/api/redemptions') return send(res, 200, await pollRedemptions());
    if (url.pathname === '/api/runs') return send(res, 200, { runs: loadRuns() });
    if (url.pathname === '/api/verify') {
      const id = url.searchParams.get('run') ?? '';
      if (!RUN_ID.test(id)) return send(res, 400, { error: 'bad run id' });
      const out = await verify(id);
      return send(res, out.status, out.body);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e.message ?? e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Dispatch desk on http://localhost:${PORT}  (reads ${ROOT}/evidence-*.json)`));
