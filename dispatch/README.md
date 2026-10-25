# DISPATCH

An agent that reads HTTP 402 paywalls, decides what to buy under a spending mandate, pays in RLUSD through an
AP4M channel, and proves it from the chain. One command, about a minute, nothing pre-recorded.

```bash
npm install        # installs ethers and the AP4M SDK (@ap4m/sdk from hackathon.ap4m.build, Node 24)
npm test           # policy, retry, and every scenario over 300 seeds. No network.
npm run channels   # read-only: your channels, their status and cap left, and how many more channels the reservation can bind
node dry.mjs 7     # for every scenario: starts the real sellers, reads the real 402s, shows each decision. Spends nothing.
npm run demo       # a live run of a random scenario. Spends 0.02-0.05 RLUSD of channel cap.
```

Needs an **open channel with at least 0.05 RLUSD of cap left** (more for the premium scenario, whose seller asks 0.09). Keys are read from `../../ap4m-hackathon/.env`
(or `ENV_FILE`, or the shell) and never printed.

## The desk

```bash
npm run pane       # then open http://localhost:8810
```

A read-only page over the saved `evidence-*.json` files: tiles for spend, refusals and the payout check, a
chronological decision table, and the six judging questions for the selected run. Each row is labelled
**chain** (a payment or settlement that can be re-read) or **agent-reported** (peeks and refusals, which leave no
trace on any ledger). **Re-verify on chain** re-reads every purchase's receipt and its VoucherRedeemed event from
the RPC node, without using the saved file's own proof fields. The desk holds no keys and sends nothing.
Runs recorded before the timeline existed show without timestamps.

## Audit manifest

```bash
npm run audit      # writes AUDIT-MANIFEST.md and re-reads every purchase from the chain
```

Summarises the saved `evidence-*.json` files and hashes them (SHA-256, reproducible with `sha256sum --text`).
It stops if there are no evidence files and never fills in defaults. The hash only detects later edits if you keep
it somewhere other than this folder; it is not a signature and is not anchored on any chain. Refusals are marked
agent-reported.

## Scenarios

Every run picks a scenario and a seed. The seed drives the data, prices and which seller misbehaves, so runs
differ; it is printed, and `--seed N` replays a run exactly.

```bash
node demo.mjs                         # random scenario, random seed
node demo.mjs --scenario failover     # pick one
node demo.mjs --scenario failover --seed 7   # replay exactly
node demo.mjs --list
```

| Scenario | What the agent faces | Spends up to |
|---|---|---|
| visibility-audit | Buys a live robots.txt/llms.txt snapshot of a real site; only if an AI crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) is blocked does it buy a peer benchmark, then checks a deep audit whose price rose after listing. Sometimes it stops early. | 0.05 |
| comparison-shopper | Three vendors reselling real FRED price series: one cheap but on a monthly series (so its latest reading is weeks old), one honest weekly diesel price, one weekly diesel price that raised its price. Peeks at all for free, buys one. | 0.04 |
| budget-squeeze | Wants three real datasets (Open-Meteo weather, FRED diesel, FRED lumber or steel); the mission budget covers two. What the first purchase shows (a crew hold, or a price up 5% or more on the year) decides which of the others it buys. | 0.04 |
| failover | Active National Weather Service alerts for a service area. The preferred seller is offline and one backup raised its price. Takes the honest backup. | 0.03 |
| premium-too-expensive | A full FRED price report (last 24 observations) that is honestly priced but above the per-call ceiling, and a cheaper summary of the same series. | 0.03 |
| live-weather | Two feeds sell a current Open-Meteo reading for a service area; one raised its price after listing. Buys the honest one, then decides whether a crew works (rule-based: gusts, rain chance, cold). If the live source fails, the seller is marked down and nothing is substituted. | 0.03 |

The agent refuses to start if the channel cannot cover the scenario's maximum spend (exit code 4), and warns
when a seller asks more than the cap left, because the SDK cannot quote above it.

Decisions are plain code over integers in [policy.mjs](policy.mjs): payee, asset, price against listing,
ceiling, mission budget, and remaining channel cap. There is no LLM, and a merchant's prose is never read.

## The six judging questions

| Question | Where this stands |
|---|---|
| Autonomy | Reads the real 402, decodes it, decides and pays with no human step. Verified in a live run. |
| Use case clarity | The report cannot be written without buying, since only the sellers hold the data. **Every scenario's sellers fetch real data when they start** (Open-Meteo, FRED, the National Weather Service, a site's own robots.txt) and go offline if the source fails; nothing is substituted. The 15 runs recorded before 2026-10-25 predate this: 14 of them bought sample fixture data, and only live-weather has a recorded paid run on real data. No paid run of the new sellers has been recorded yet. |
| On-chain proof | Each purchase's receipt is read from the chain; the VoucherRedeemed log is found and its claim id matches. Explorer links are printed. |
| RLUSD settlement | Merchant payout `balanceOf` before and after: +0.05 against 0.05 spent, in the 2026-10-25 run. |
| Demo quality | One command, 26s in the last run (live-weather). Needs an open channel with cap left. |
| Creativity | Data-dependent multi-step buying and a refused price bump, on real public data. **Not met:** an LLM doing the reasoning. |

## Things learned the hard way

- The channel carries one unsettled claim at a time. The agent settles after each purchase; without that the
  next seller's challenge reverts and answers 503.
- The SDK will not quote a price above the channel's remaining cap, so a "price bump" seller must stay under it
  or it cannot even issue a 402.
- The RPC node sometimes answers "tx not found" for a transaction it just accepted, and the gateway sometimes
  returns HTML. [retry.mjs](retry.mjs) retries transient failures with backoff and a per-attempt timeout, and
  never retries a 4xx.
