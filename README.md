<p align="center"><img src="tripwire/logo.svg" alt="TRIPWIRE" width="120"></p>

# TRIPWIRE + Dispatch

Mastercard / XRPL hackathon entry on AP4M (Agent Pay for Machines) and x402, settled in RLUSD on XRPL EVM Testnet.

> The agent can be talked into anything. The money can't.

Mastercard's framing is that payments aren't the hard part; authority is. This project has two parts that show it from both sides:

| Part | What it shows | Folder |
|---|---|---|
| **Dispatch** | An agent that reads HTTP 402 paywalls, buys real public data under a spending mandate, pays RLUSD through an AP4M channel, and proves each payment from the chain. | [dispatch/](dispatch/README.md) |
| **TRIPWIRE** | An attack board: hostile merchant messages and the `pay()` calls a fooled agent would make, each stopped by a named guard, with real EIP-712 vouchers signed and verified. | [tripwire/](tripwire/README-TRIPWIRE.md) |

Submission text: [tripwire/SUBMISSION.md](tripwire/SUBMISSION.md). Numbers come from [dispatch/AUDIT-MANIFEST.md](dispatch/AUDIT-MANIFEST.md).

## Run it (no keys, no payment)

```bash
cd dispatch && npm install && npm test        # policy, retry, 6 scenarios x 300 seeds
cd dispatch && npm run check-data             # every seller's real source, plus the scenarios' reasoning on it (needs internet)
cd dispatch && npm run audit                  # re-reads all recorded purchases from the chain, rewrites AUDIT-MANIFEST.md
cd tripwire && npm install && npm test        # 8 attack scenarios + voucher tests
cd tripwire && npm start                      # attack board with a judge sandbox on http://localhost:3000
cd dispatch && npm run pane                   # read-only desk over the recorded runs on http://localhost:8810
```

A live paid run needs your own AP4M keys in an untracked `.env` and an open channel with at least 0.05 RLUSD left: `cd dispatch && npm run channels` shows your channels and how many more the reservation can bind, then `node demo.mjs`.

## What is and is not proven

- **Recorded:** 15 live runs on XRPL EVM Testnet, 20 purchases totalling 0.47 RLUSD, all 20 re-read from the chain and confirmed; the merchant payout balance rose by exactly the spend in 15 of 15 runs. Refusals are agent-reported and leave no ledger trace.
- **Data:** the Dispatch sellers now fetch real public data when they start (Open-Meteo, FRED, National Weather Service, a site's own robots.txt) and go offline if the source fails. The 15 recorded runs predate that change (14 bought sample fixture data, 1 bought a real Open-Meteo reading); no paid run of the new sellers is recorded yet.
- **TRIPWIRE guards are a local model of the money layer.** They sign and verify EIP-712 vouchers locally with throwaway test keys and never submit one, so no scenario moves funds and an approval means authorised, not paid. They do not call the PaymentLedger contract; live mode only reads the channel's cap and redeemed amount.
- No LLM is in the loop: the scenarios replay the call a fooled agent would make.
- The audit hash is not a signature and is not anchored on any chain.
- Judging fit: autonomy, use-case clarity, on-chain proof, RLUSD settlement, demo quality and creativity are mapped, with the gaps stated, in [dispatch/README.md](dispatch/README.md#the-six-judging-questions).

The earlier multi-micro-payment sample that used to be this README is kept as [README-multi-micro.md](README-multi-micro.md).
