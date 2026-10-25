<p align="center"><img src="tripwire/logo.svg" alt="TRIPWIRE" width="120"></p>

# PrivaSpend

**Spend limits, threat protection and on-chain proof for AI agents.** Built from two parts: TRIPWIRE (the attack board) and Dispatch (the paying agent).

Mastercard / XRPL hackathon entry on AP4M (Agent Pay for Machines) and x402, settled in RLUSD on XRPL EVM Testnet.

> The agent can be talked into anything. The money can't.

Mastercard's framing is that payments aren't the hard part; authority is. This project has two parts that show it from both sides:

| Part | What it shows | Folder |
|---|---|---|
| **Dispatch** | An agent that reads HTTP 402 paywalls, buys real public data under a spending mandate, pays RLUSD through an AP4M channel, and proves each payment from the chain. | [dispatch/](dispatch/README.md) |
| **TRIPWIRE** | An attack board: hostile merchant messages and the `pay()` calls a fooled agent would make, each stopped by a named guard, with real EIP-712 vouchers signed and verified. | [tripwire/](tripwire/README-TRIPWIRE.md) |
| **Live pane** | A two-agent channel view fed by a QuickNode WebSocket, a QuickNode Stream and a reconcile poll, showing `VoucherRedeemed` as it lands and marking what the chain measured against what a process only reported. | [dispatch/live/](dispatch/live/README.md) |

Submission text: [tripwire/SUBMISSION.md](tripwire/SUBMISSION.md). Numbers come from [dispatch/AUDIT-MANIFEST.md](dispatch/AUDIT-MANIFEST.md).

## Run it (no keys, no payment)

```bash
cd dispatch && npm install && npm test        # policy, retry, 6 scenarios x 300 seeds (npm install fetches the AP4M SDK from hackathon.ap4m.build)
cd dispatch && npm run check-data             # every seller's real source, plus the scenarios' reasoning on it (needs internet)
cd dispatch && npm run audit                  # re-reads all recorded purchases from the chain, rewrites AUDIT-MANIFEST.md
cd tripwire && npm install && npm test        # 8 attack scenarios + voucher tests
cd tripwire && npm start                      # attack board with a judge sandbox on http://localhost:3000
cd dispatch && npm run pane                   # read-only desk over the recorded runs on http://localhost:8810
cd dispatch && npm run live                   # live channel pane over QuickNode on http://localhost:8787
```

A live paid run needs your own AP4M keys in an untracked `.env` and an open channel with at least 0.05 RLUSD left: `cd dispatch && npm run channels` shows your channels and how many more the reservation can bind, then `node demo.mjs`.

## What is and is not proven

- **Recorded:** 15 live runs on XRPL EVM Testnet, 20 purchases totalling 0.47 RLUSD, all 20 re-read from the chain and confirmed; the merchant payout balance rose by exactly the spend in 15 of 15 runs. Refusals are agent-reported and leave no ledger trace.
- **Data:** the Dispatch sellers now fetch real public data when they start (Open-Meteo, FRED, National Weather Service, a site's own robots.txt) and go offline if the source fails. The 15 recorded runs predate that change (14 bought sample fixture data, 1 bought a real Open-Meteo reading); no paid run of the new sellers is recorded yet.
- **TRIPWIRE guards are a local model of the money layer.** They sign and verify EIP-712 vouchers locally with throwaway test keys and never submit one, so no scenario moves funds and an approval means authorised, not paid. They do not call the PaymentLedger contract; live mode only reads the channel's cap and redeemed amount.
- No LLM is in the loop: the scenarios replay the call a fooled agent would make.
- The audit hash is not a signature and is not anchored on any chain.
- **QuickNode is used three ways, and measured.** Dispatch's providers prefer
  `QUICKNODE_EVM_RPC_URL` when it is set, so the payments and the audit that
  re-reads them go through it; the live pane holds a QuickNode WebSocket and
  subscribes to `newHeads` and `VoucherRedeemed`; and a QuickNode Stream with a
  server-side filter posts the same events to the pane's webhook. Against the
  published node, both measured the same minute: `eth_blockNumber` median
  30.3 ms against 51.3 ms and worst case 40.1 ms against 203.6 ms;
  `eth_getLogs` over 2,000 blocks 124 ms against 334 ms, 141 events either way.
  What is *not* claimed is listed in
  [dispatch/live/QUICKNODE.md](dispatch/live/QUICKNODE.md) — a public WebSocket
  does exist, and the Stream has so far only matched events the socket had
  already pushed.
- **The live pane shows the network's traffic, not only ours.** A row is marked
  *ours* only when it is on our channel, and the payout binding's 12 channel
  requests are spent, so a new allocation has to be funded before the pane can
  mark one. Everything else on it is real traffic from the shared testnet.
- Judging fit: autonomy, use-case clarity, on-chain proof, RLUSD settlement, demo quality and creativity are mapped, with the gaps stated, in [dispatch/README.md](dispatch/README.md#the-six-judging-questions).

The earlier multi-micro-payment sample that used to be this README is kept as [README-multi-micro.md](README-multi-micro.md).
