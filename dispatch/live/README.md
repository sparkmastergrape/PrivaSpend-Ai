# dispatch/live — the two-agent pane

A buyer agent signs vouchers, a seller merchant redeems them, and this pane
shows it happening from the chain's side rather than the agents'.

```
cd dispatch && npm run live  # default port 8787, LIVE_PORT=8799 to move it
```

Then open the port it prints. Nothing else needs to be running: the pane shows
whatever is on the PaymentLedger, which during the event is every team's
traffic, with yours marked.

## Which node it reads

QuickNode, over the WebSocket, when `QUICKNODE_EVM_WSS_URL` is set — in the
environment or in `dispatch/.env`, the same precedence `pane/pane.mjs` uses.
Reads that are not subscriptions (balances, backfill, the reconcile poll) go
over `QUICKNODE_EVM_RPC_URL`, falling back to the public XRPL EVM node.

**Those URLs are credentials.** QuickNode puts the token in the path. The relay
holds them and the browser never sees one: the pane is told the provider's name
(`QuickNode`) and nothing else. If an endpoint ever appears in the page source,
in `tape.jsonl` or in the SSE stream, something has regressed.

## Push first, poll as the net

The order is the one any live watcher has to take:

1. open the socket and subscribe
2. only then backfill the recent window
3. then sit on the push

Reversed, a payment can land between the history read and the subscription and
never be seen. A 10-second reconcile poll runs underneath to catch a dropped
socket — and when it is the one producing rows, the chip says `polling
fallback` and step 4 turns amber. A demo that degrades silently while still
claiming "live" is the thing judges catch.

`eth_getLogs` over 20,000 blocks returns `could not coalesce error`. Measured
again on a quiet endpoint, 10,000 answers and 20,000 still does not, so the
2,000-block window is deliberately conservative rather than the hard ceiling —
it survives the event-day load that first produced the error. The backfill
walks in windows and narrows further on failure.

**QuickNode against the published node**, both measured the same minute:

| | public `rpc.testnet.xrplevm.org` | QuickNode |
| :-- | --: | --: |
| `eth_blockNumber`, median of 12 | 51.3 ms | 30.3 ms |
| worst of 12 | 203.6 ms | 40.1 ms |
| `eth_getLogs`, 2,000 blocks | 334 ms | 124 ms |

Identical results — 141 events both times. The tail is the part that matters on
stage: a 204 ms worst case is a visible stutter, and the pane makes a call on
every new head.

A public WebSocket does exist at `wss://ws.testnet.xrplevm.org`, and it opens.
It is simply not in the kit: `GET /public/config` publishes an HTTPS `rpcUrl`
and nothing else, so nothing in the quickstart path pushes. QuickNode is not
the only way to get a socket here — it is the faster one, and the one this was
built and measured on.

## Three roads, one set

The socket pushes, QuickNode Streams posts to `POST /webhook`, and a 10-second
reconcile poll runs underneath both. All three feed one `seen` set, so whichever
arrives first wins and the others are dropped as duplicates. The tape records
which road each row came by, in its `via` field: `push`, `stream`, `poll` or
`backfill`.

`live/QUICKNODE.md` describes the Stream, its server-side filter, and what was
measured against the published node.

The Stream reaches `POST /webhook` through a tunnel, and that is the only route
a tunnelled request gets: anything arriving with a forwarding header is refused
403 elsewhere, so the pane, the SSE feed and `/trace` stay loopback-only while
the webhook is public. `LIVE_PUBLIC=1` serves the pane through the tunnel as
well, if that is what you want on the day.

## Two feeds, and why

The chain is one feed. The agent and merchant are the other.

Steps 1, 2, 3 and 5 are HTTP between the two processes. They leave nothing on a
ledger, so QuickNode cannot see them and no node could — that is the design of
x402, not a gap. The processes that were there report their own timeline to the
relay, and the pane tags those steps **reported**. Step 4 is tagged
**measured**: it is a `VoucherRedeemed` event, read from the chain. It is the
same measured/reported line [`AUDIT-MANIFEST.md`](../AUDIT-MANIFEST.md) draws
over the recorded runs.

```js
import { trace } from './live/trace.mjs';   // from dispatch/
trace(2, 'ok', '0.05 RLUSD asked', { operation });   // POST /trace, fire and forget
```

`POST /trace` takes `{step: 1-5, mark: ok|warn|fail, say, role, operation}`,
caps the body at 4 KB, and rejects anything else with 422. It is a claim by a
process, not evidence, which is why it is bounded, checked, and labelled
differently on screen. The call never awaits: a pane that is not running must
never slow a payment down.

`live/demo-loop.mjs` emits them around a real purchase. With no open channel it
still runs the exchange — the 402 is real, and so is the refusal.

## What the colours mean

| Colour | Meaning |
| :-- | :-- |
| green | the step passed |
| amber | needs a look — near the cap, or the row arrived by poll instead of push |
| red | failed — cumulative over the funded cap, or no feed at all |

Only step 4, `VoucherRedeemed`, is evidenced on chain. Steps 1, 2, 3 and 5 are
what that event implies happened over HTTP, and the note under the strip says
so. The colours are not a claim that the pane watched the HTTP exchange.

## The thing the pane must not blur

In the hot path **no RLUSD moves**. The voucher advances the redeemed watermark
on the PaymentLedger. RLUSD leaves the PooledEscrowVault at settlement, and
that is the only row in the tape marked *settled*. Two tracks, two tempos.

## Files

| File | Holds |
| :-- | :-- |
| `relay.mjs` | the socket, the SSE fan-out, the reconcile poll, `POST /trace` |
| `pane.html` | the UI; talks only to the relay |
| `trace.mjs` | how the agent and merchant narrate their own HTTP |
| `demo-loop.mjs` | drives real purchases so the rows marked *ours* are ours |
| `tape.jsonl` | decoded rows as they were seen — a rehearsal aid, never an endpoint |
