# QuickNode in this build

Three surfaces, not one, and the deepest of them replaced code we had written
ourselves. Every number below was measured on this account; none is from a
datasheet.

## 1. The agent transacts through it

Set `QUICKNODE_EVM_RPC_URL` and every provider Dispatch builds uses it:
[`channels.mjs`](../channels.mjs), [`open-channel.mjs`](../open-channel.mjs),
[`merchants.mjs`](../merchants.mjs) and [`audit-manifest.mjs`](../audit-manifest.mjs)
each prefer it over the `rpcUrl` the service publishes, which is the precedence
[`pane/pane.mjs`](../pane/pane.mjs) already used. Leave it unset and they fall
back to `rpc.testnet.xrplevm.org` exactly as before. This is the plainest use
and the easiest to overlook: the payments themselves go through it, and so does
the audit that re-reads them.

## 2. The pane reads through its WebSocket

`live/relay.mjs` holds `QUICKNODE_EVM_WSS_URL` and subscribes to `newHeads` and
to `VoucherRedeemed` logs on the PaymentLedger. Measured on connect: **54 ms
handshake**, chainId 1449000, heads arriving every ~5 s.

The endpoint never reaches the browser. A QuickNode URL carries its token in the
path, so it is a credential: the relay holds it and the pane is told the
provider's name and nothing else.

**Against the published node**, both measured the same minute:

| | public `rpc.testnet.xrplevm.org` | QuickNode |
| :-- | --: | --: |
| `eth_blockNumber`, median of 12 | 51.3 ms | 30.3 ms |
| worst of 12 | 203.6 ms | 40.1 ms |
| `eth_getLogs`, 2,000 blocks | 334 ms | 124 ms |
| events returned | 141 | 141 |

Same answers, and a worst case 5× tighter. The tail is what matters on stage:
the pane reads on every new head, and a 204 ms stall is a visible stutter.

## 3. Streams delivers the events we care about, filtered server-side

Stream `ap4m-voucher-events` — XRP Ledger EVM Testnet, **Logs** dataset,
webhook destination, running continuously from the block it was created at.

The filter runs on QuickNode's side, so blocks that hold nothing for us are
never sent at all:

```js
const LEDGER = "0xcab42800a5ecf0d253fa2581bb3334b4daefae91";
const TOPIC  = "0xe3de5c3755abd99a01530fd79b85708f309453f6d26eb9bb5dde4c14cd5f7175";
function main(payload) {
  const out = [];
  const visit = function (node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== "object" || !Array.isArray(node.topics)) return;
    if (String(node.address).toLowerCase() !== LEDGER) return;
    if (String(node.topics[0]).toLowerCase() !== TOPIC) return;
    out.push(node);
  };
  visit(payload && payload.data ? payload.data : payload);
  return out.length ? { data: out } : null;
}
```

Tested in the Stream Filter Editor against block 9234054, which holds a real
redemption: it returned that one log and dropped the rest of the block. The
dashboard reports the filter running at roughly **30 ms p99**.

**It has delivered.** The first live delivery arrived at block 9235682 and is on
the tape as `"via":"stream"` — channel `0xcd4c3552…`, claim `0x2972d54b…`, tx
`0xd8860d94…`. That one the Stream won. A later delivery carried an event the
socket had already pushed, and the shared `seen` set dropped it:

```
[stream] batch of 1, 1 voucher event(s), 0 new
```

Which road wins varies, and neither is the point. The socket is a direct
subscription and often first; what the Stream adds is backfill and reorg
handling as someone else's problem, and a second road that is still there when
the socket drops.

**What this replaced.** The relay had its own windowed `eth_getLogs` backfill
and a 10-second reconcile poll, written because `eth_getLogs` over 20,000 blocks
returns `could not coalesce error` on this chain. Streams does backfill and
reorg handling as a product feature. The hand-rolled pair stays as the fallback
path — two roads into the same `seen` set, whichever arrives first wins — but
the Stream is the one that is meant to carry the load.

`POST /webhook` on the relay takes the delivery, answers 200 even to a payload
it could not parse (a non-200 makes Streams retry, and retrying an unparseable
body just produces the same failure more often), and verifies the Stream's
security token as an HMAC when `QUICKNODE_WEBHOOK_TOKEN` is set.

**The destination is a tunnel, and `/webhook` is all of the relay it reaches.**
The relay binds loopback; a quick tunnel (`cloudflared tunnel --url
http://127.0.0.1:PORT`) puts a public hostname in front of it so Streams can
deliver. Any request carrying a forwarding header gets 403 on every route but
`/webhook`, so the pane, the SSE feed and `/trace` are not on the internet
along with it. `LIVE_PUBLIC=1` lifts that, deliberately. The quick-tunnel
hostname dies with the `cloudflared` process, so a restart means pasting the
new URL into the Stream's destination — measured end to end, that is the whole
recovery.

## What we are not claiming

- **A public WebSocket does exist** at `wss://ws.testnet.xrplevm.org`, and it
  opens. QuickNode is not the only way to get a push here. It is simply not in
  the kit — `GET /public/config` publishes an HTTPS `rpcUrl` and nothing else —
  so nothing on the quickstart path pushes, and ours does.
- **The 2,000-block window is conservative, not a hard ceiling.** Re-measured
  on a quiet endpoint, 10,000 answers; 20,000 still does not. The small window
  is what survived event-day load.
- **This entry is on the XRPL EVM sidechain, and only there.** AP4M's
  contracts live on chain 1449000, so that is where the payments and the
  `VoucherRedeemed` events are, and all three QuickNode surfaces above point at
  it. QuickNode does serve XRP Ledger Testnet as well; adding that endpoint is
  possible and is not part of this build, because a second endpoint nothing
  reads would be decoration rather than use.

## Reproducing the measurements

```bash
cd dispatch && npm install && npm run live   # subscribes, backfills, serves the pane
curl -s localhost:8787/stream | head -5      # the SSE feed the pane reads
```

`npm run live` needs `QUICKNODE_EVM_WSS_URL` in the environment or in
`dispatch/.env`. Without it the relay falls back to polling the public node and
says so on screen rather than pretending.

The latency table came from 12 `eth_blockNumber` calls against each endpoint in
the same minute, timed with `process.hrtime.bigint()`, and one `eth_getLogs`
over the same 2,000-block range on each.
