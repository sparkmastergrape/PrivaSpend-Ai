# Dispatch: run it yourself

An agent that reads HTTP 402 paywalls, decides what to buy under a spending mandate, pays in RLUSD through an
AP4M channel on XRPL EVM Testnet, and proves each payment from the chain. This folder is self-contained:
`node_modules` is included, so there is no install step. You need **Node 24** (`node --version`).

## 1. Without any keys (start here)

```bash
node test.mjs                      # policy, retry, and all 6 scenarios x 300 seeds. No network.
node pane/pane.mjs                 # then open http://localhost:8810
node audit-manifest.mjs --verify   # re-reads every recorded purchase from the chain, rewrites AUDIT-MANIFEST.md
```

The pane is a read-only page over the saved `evidence-*.json` files (14 real runs). Pick a run on the left to see
what the agent decided and why. **Re-verify on chain** re-reads that run's receipts and `VoucherRedeemed` events
from the RPC node instead of trusting the saved file. None of this needs a key, sends a transaction or spends anything.

Rows marked **chain** can be re-read from the ledger. Rows marked **agent-reported** (refusals, free price checks)
leave no trace on any ledger, so only the agent's own record backs them.

## 2. A live run (spends testnet RLUSD)

This signs vouchers with the team's agent wallet and pays real testnet RLUSD (0.02-0.05 per run). It needs:

- The team's AP4M credentials in an env file that is **not committed or shared**. Variable names:
  `AGENT_PRIVATE_KEY`, `MERCHANT_PRIVATE_KEY` (or `MERCHANT_SUBMITTER_KEY`), `MERCHANT_PARTICIPANT_ID`,
  `MERCHANT_PAYOUT_ADDRESS`, `TEAM_NAME`. Optional: `CHANNEL_ID`, `AP4M_API_URL`.
- Point to the file with `ENV_FILE`, or export the variables in your shell. Values are read but never printed.
- An **open channel with at least 0.05 RLUSD of cap left**. With several open channels the agent uses the one with
  the most cap; set `CHANNEL_ID` to pick one.

```bash
ENV_FILE=/path/to/.env node dry.mjs 7                          # no spend: reads each real 402 and shows the decision
ENV_FILE=/path/to/.env node demo.mjs --scenario failover --seed 7   # the short demo, about 25-35s, spends 0.03
ENV_FILE=/path/to/.env node demo.mjs                           # random scenario, random seed
node demo.mjs --list                                           # the six scenarios
```

`--seed` replays a run exactly (same data, same prices, same misbehaving seller). Each live run writes a new
`evidence-r*.json`; run `node audit-manifest.mjs --verify` afterwards to refresh the audit.

## What to expect in `failover`

1. The preferred seller is offline.
2. Backup 1 asks 0.05 against a 0.03 listing, so the agent refuses (`PriceChangeGuard`) and signs nothing.
3. Backup 2 asks 0.03 as listed, and the agent pays.
4. The run reads the receipt and the `VoucherRedeemed` event from the chain, then checks the merchant payout
   balance rose by exactly 0.03.

## Limits

- Every seller fetches real data when it starts: Open-Meteo (weather), FRED (diesel, copper, lumber and steel prices), the National Weather Service (alerts), and a site's own robots.txt and llms.txt (AI-crawler access). It needs internet and fails closed: if a source is unreachable the seller goes offline and nothing is substituted. `node check-data.mjs` exercises every source and every scenario's reasoning with no keys and no payment. The 14 recorded runs from before 2026-10-25 other than live-weather bought sample fixture data; no paid run of the new sellers has been recorded.
- The decisions are plain code over integers in `policy.mjs`. There is no LLM.
- All sellers share one merchant identity, and its payout wallet also receives deposits from outside these runs,
  so the balance check is a before/after within a single run.
- The audit hash is not a signature and is not anchored on any chain.
