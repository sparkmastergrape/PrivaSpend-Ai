/**
 * live/sim/mock-node.mjs — an in-process stand-in for an XRPL EVM node.
 *
 * It answers the few JSON-RPC methods the relay calls, over HTTP and over a
 * WebSocket, and pushes `newHeads` and `logs` subscriptions the way a node does.
 * Every block, hash and address it serves is invented. It exists so the pane can
 * be rehearsed with no network and no credentials. It is not evidence of
 * anything about QuickNode or about the chain.
 *
 * The WebSocket server is written by hand (RFC 6455, text frames only) so the
 * simulator needs nothing beyond `ethers`, which Dispatch already depends on.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { ethers } from 'ethers';

export const CHAIN_ID = 1449000;

// The same two ABI lines the relay decodes with, so topic hashes match exactly.
const VOUCHER = new ethers.Interface([
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
]);
const TRANSFER = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
export const VOUCHER_TOPIC = VOUCHER.getEvent('VoucherRedeemed').topicHash;
export const TRANSFER_TOPIC = TRANSFER.getEvent('Transfer').topicHash;

const BALANCE_OF = '0x70a08231';
const hex = (n) => '0x' + BigInt(n).toString(16);
const lower = (value) => String(value).toLowerCase();

// ── Log filters, as eth_getLogs and eth_subscribe("logs") both use them ──────

export function matches(log, filter = {}) {
  if (filter.address) {
    const wanted = [].concat(filter.address).map(lower);
    if (!wanted.includes(lower(log.address))) return false;
  }
  return (filter.topics ?? []).every((want, index) => {
    if (want === null || want === undefined) return true;
    const have = log.topics[index];
    return have !== undefined && [].concat(want).map(lower).includes(lower(have));
  });
}

// ── The chain: blocks, logs and RLUSD balances ───────────────────────────────

export function createChain({ ledger, rlusd }) {
  const blocks = new Map();
  const balances = new Map();
  let head = 0;
  let first = 0;
  let pending = [];
  let counter = 0;

  const txHash = () => ethers.id(`sim-tx:${++counter}`);

  function voucherEntry(v) {
    const { data, topics } = VOUCHER.encodeEventLog(VOUCHER.getEvent('VoucherRedeemed'), [
      v.channelId, v.claimId, v.digest, v.allocationId, v.agent, v.merchantId,
      v.payout, v.submitter, v.previous, v.cumulative, v.amount,
    ]);
    return { address: ledger, data, topics, txHash: txHash() };
  }

  function transferEntry({ from, to, value }) {
    const { data, topics } = TRANSFER.encodeEventLog(TRANSFER.getEvent('Transfer'), [from, to, value]);
    return {
      address: rlusd, data, topics, txHash: txHash(),
      apply: () => {
        balances.set(lower(from), (balances.get(lower(from)) ?? 0n) - value);
        balances.set(lower(to), (balances.get(lower(to)) ?? 0n) + value);
      },
    };
  }

  function addBlock(number, timestamp, entries) {
    const hash = ethers.id(`sim-block:${number}`);
    const logs = entries.map((entry, index) => {
      entry.apply?.();
      return {
        address: entry.address, blockHash: hash, blockNumber: hex(number), data: entry.data,
        logIndex: hex(index), removed: false, topics: entry.topics,
        transactionHash: entry.txHash, transactionIndex: hex(index),
      };
    });
    const block = {
      number, hash, parentHash: ethers.id(`sim-block:${number - 1}`), timestamp,
      txs: logs.map((log) => log.transactionHash), logs,
    };
    blocks.set(number, block);
    head = number;
    if (!first) first = number;
    return block;
  }

  const resolveTag = (tag, fallback) => {
    if (tag === undefined || tag === null) return fallback;
    if (['latest', 'pending', 'safe', 'finalized'].includes(tag)) return head;
    if (tag === 'earliest') return first;
    return Number.parseInt(tag, 16);
  };

  return {
    get head() { return head; },
    voucherEntry,
    transferEntry,
    addBlock,
    queue: (entry) => { pending.push(entry); return entry.txHash; },
    mine(timestamp) {
      const entries = pending;
      pending = [];
      return addBlock(head + 1, timestamp, entries);
    },
    setBalance: (who, value) => balances.set(lower(who), value),
    balanceOf: (who) => balances.get(lower(who)) ?? 0n,
    getBlock(tag) {
      const block = blocks.get(resolveTag(tag, head));
      if (!block) return null;
      return {
        number: hex(block.number), hash: block.hash, parentHash: block.parentHash,
        timestamp: hex(block.timestamp), nonce: '0x0000000000000000', difficulty: '0x0',
        gasLimit: '0x1c9c380', gasUsed: '0x5208', miner: '0x0000000000000000000000000000000000000000',
        extraData: '0x', baseFeePerGas: '0x3b9aca00', transactions: block.txs,
      };
    },
    getLogs(filter = {}) {
      const from = Math.max(resolveTag(filter.fromBlock, first), first);
      const to = Math.min(resolveTag(filter.toBlock, head), head);
      const found = [];
      for (let number = from; number <= to; number += 1) {
        for (const log of blocks.get(number)?.logs ?? []) if (matches(log, filter)) found.push(log);
      }
      return found;
    },
  };
}

// ── JSON-RPC over HTTP and WebSocket ─────────────────────────────────────────

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function frame(opcode, payload) {
  const body = Buffer.from(payload);
  const size = body.length;
  let header;
  if (size < 126) header = Buffer.from([0x80 | opcode, size]);
  else if (size < 65536) header = Buffer.from([0x80 | opcode, 126, size >> 8, size & 255]);
  else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([header, body]);
}

export function createNodeServer({ chain, port, host = '127.0.0.1' }) {
  const sessions = new Set();
  let stalled = false;

  function call(method, params, session) {
    switch (method) {
      case 'eth_chainId': return hex(CHAIN_ID);
      case 'net_version': return String(CHAIN_ID);
      case 'eth_blockNumber': return hex(chain.head);
      case 'eth_getBlockByNumber': return chain.getBlock(params[0]);
      case 'eth_getLogs': return chain.getLogs(params[0]);
      case 'eth_call': {
        const { data = '0x' } = params[0] ?? {};
        if (!data.startsWith(BALANCE_OF)) throw new RpcError(3, 'execution reverted');
        const who = '0x' + data.slice(34, 74);
        return '0x' + chain.balanceOf(who).toString(16).padStart(64, '0');
      }
      case 'eth_subscribe': {
        if (!session) throw new RpcError(-32601, 'subscriptions need a WebSocket');
        const kind = params[0];
        if (kind !== 'newHeads' && kind !== 'logs') throw new RpcError(-32602, `cannot subscribe to ${kind}`);
        const id = '0x' + crypto.randomBytes(8).toString('hex');
        session.subs.set(id, { kind, filter: params[1] ?? {} });
        return id;
      }
      case 'eth_unsubscribe': return Boolean(session?.subs.delete(params[0]));
      default: throw new RpcError(-32601, `${method} is not served by the simulator`);
    }
  }

  async function answer(message, session) {
    if (Array.isArray(message)) return Promise.all(message.map((one) => answer(one, session)));
    const reply = { jsonrpc: '2.0', id: message?.id ?? null };
    try {
      reply.result = call(message?.method, message?.params ?? [], session);
    } catch (error) {
      reply.error = { code: error.code ?? -32000, message: error.message };
    }
    return reply;
  }

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`simulated XRPL EVM node, chain ${CHAIN_ID}. Not a real node.\n`);
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      let message;
      try { message = JSON.parse(body); } catch {
        response.writeHead(400).end('bad json');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(await answer(message, null)));
    });
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    // While the simulator plays a dead socket it also refuses new ones, so the
    // relay's reconnect attempts fail the way they would against a dropped link.
    if (stalled || !key) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const session = { socket, subs: new Map() };
    sessions.add(session);
    let buffer = Buffer.alloc(0);
    let fragments = [];

    const send = (text) => { if (!socket.destroyed) socket.write(frame(0x1, text)); };
    session.send = send;

    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let size = buffer[1] & 0x7f;
        let offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) {
          if (buffer.length < 10) return;
          size = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const total = offset + (masked ? 4 : 0) + size;
        if (buffer.length < total) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(total);

        if (opcode === 0x8) { socket.end(frame(0x8, payload)); return; }
        if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
        if (opcode === 0xa) continue;
        if (opcode === 0x1 || opcode === 0x2) fragments = [payload];
        else if (opcode === 0x0) fragments.push(payload);
        if (!fin) continue;

        let message;
        try { message = JSON.parse(Buffer.concat(fragments).toString('utf8')); } catch { continue; }
        fragments = [];
        send(JSON.stringify(await answer(message, session)));
      }
    });
    const gone = () => sessions.delete(session);
    socket.on('close', gone);
    socket.on('error', gone);
  });

  const notify = (session, id, result) => session.send?.(JSON.stringify({
    jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: id, result },
  }));

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    }),
    close() {
      for (const session of sessions) session.socket.destroy();
      server.close();
    },
    /** True means the node goes silent on every socket and refuses new ones. HTTP still answers. */
    setStalled(value) { stalled = Boolean(value); },
    get sockets() { return sessions.size; },
    pushHead(block) {
      if (stalled) return;
      const header = {
        number: hex(block.number), hash: block.hash, parentHash: block.parentHash,
        timestamp: hex(block.timestamp),
      };
      for (const session of sessions) {
        for (const [id, sub] of session.subs) if (sub.kind === 'newHeads') notify(session, id, header);
      }
    },
    pushLog(log) {
      if (stalled) return;
      for (const session of sessions) {
        for (const [id, sub] of session.subs) {
          if (sub.kind === 'logs' && matches(log, sub.filter)) notify(session, id, log);
        }
      }
    },
  };
}
