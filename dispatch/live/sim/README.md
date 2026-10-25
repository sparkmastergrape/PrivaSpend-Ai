# live/sim — rehearse the pane with no network and no keys

```
cd dispatch && npm install
npm run live:sim              # then open http://127.0.0.1:8787
npm run live:sim -- --drop    # the socket goes silent mid-demo, then recovers
```

**This is a simulation.** Every block, hash, address and balance it shows is
invented. It is not QuickNode, it is not the chain, and it produces no
measurement. The numbers in [`../QUICKNODE.md`](../QUICKNODE.md) were measured
on a real account and nothing here replaces them. The chip at the top of the
pane says `simulated node (not QuickNode)` for the whole run.

`demo-loop.mjs` makes real purchases on purpose, because a pane fed by a mock
proves nothing about payments. This folder has a different job. It lets you
check the pane, rehearse the talk, or work on the relay when the venue network
is down or the keys are not to hand.

## What is real and what is invented

| Part | Status |
| :-- | :-- |
| `relay.mjs`, `pane.html`, `trace.mjs` | the real files. The relay gained two optional settings, `LIVE_SOURCE_NAME` and `LIVE_TAPE_FILE`, so a simulated run can name itself and keep its own tape |
| the node (blocks, logs, balances, WebSocket) | invented, in `mock-node.mjs` |
| the Streams webhook | invented, but signed with an HMAC the real relay verifies |
| the two agents' round trip | invented, narrated through the real `trace()` |
| the other teams on the ledger | invented |

The simulator starts the relay as a child process and points it at the
simulated node. It sets `QUICKNODE_EVM_*` to empty, so a real `.env` cannot send
this run to a real node.

## The storyline

1. The relay connects, subscribes, then backfills 800 blocks of invented history.
2. Our buyer buys from our seller every 9 s, 0.20 RLUSD at a time.
3. Other teams trade in the background. Press **All traffic** to see them.
4. Each event reaches the relay twice: by the socket and by a Streams-style
   webhook. They race. The slower one is dropped as a duplicate, so the `via`
   column shows both `push` and `stream`.
5. Past 80% of the 5 RLUSD cap, step 4 turns amber.
6. The next purchase would pass the cap. The agent refuses it (step 3 turns red)
   and nothing reaches the chain.
7. The channel settles. The `Settled → payout` row is the only one where RLUSD moves.
   A new channel opens and the cycle repeats.

With `--drop`, the socket stops pushing at 45 s and refuses new connections for
80 s. The chip turns amber and says `polling fallback`. Rows keep arriving by
Stream and by poll. When the socket returns, the relay reconnects and the chip
goes green.

## Settings

| Variable | Default | Meaning |
| :-- | --: | :-- |
| `SIM_BLOCK_MS` | 3000 | block time |
| `SIM_GAP_MS` | 9000 | gap between our purchases |
| `SIM_CAP` | 5 | funded cap, in RLUSD |
| `SIM_DROP_AT` / `SIM_DROP_FOR` | 45 / 80 | seconds to the drop, and how long it lasts (used with `--drop`) |
| `SIM_SEED` | 1449 | same seed, same show |
| `SIM_NODE_PORT` | 8546 | simulated node |
| `LIVE_PORT` | 8787 | pane |

## Limits

- Transaction links on the tape go to the real explorer. The hashes are invented, so the explorer finds nothing.
- No latency is measured. Local calls take well under 1 ms, which says nothing about any provider.
- The simulator implements only the JSON-RPC methods the relay calls: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_call` (`balanceOf`) and `eth_subscribe` for `newHeads` and `logs`.
- The relay writes its tape to a temporary file during the run, not to `live/tape.jsonl`, so a simulation never mixes into a real rehearsal tape.
