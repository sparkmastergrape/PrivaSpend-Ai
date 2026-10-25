# PrivaSpend AI: submission text

Limits from the form: short description 200, description 5000, technical description 1000.
Figures below come from dispatch/AUDIT-MANIFEST.md (15 recorded live runs, regenerated 2026-10-25). Regenerate it and update the numbers if you run more. The 15 runs were recorded before the sellers were switched to real data (see the scope paragraph); a new paid run is needed before claiming a purchase of real data in the five changed scenarios.

## Project Name
PrivaSpend AI

## Short Description
An agent buys data over HTTP 402, pays RLUSD under a spending mandate, refuses overpriced sellers, and proves each payment on-chain. A live attack board shows the guards stopping a fooled agent.

## Description
PrivaSpend AI lets an agent spend within hard limits and proves, from the chain, what it spent. Mastercard's stated hard problem is that payments are not the hard part; authority is. An agent that reads merchant text can be talked into a bad payment. This project has two parts: Dispatch, an agent that spends real RLUSD under a mandate, and TRIPWIRE, a board that tests what happens when the agent has been fooled.

DISPATCH is an agent that buys data from sellers over HTTP 402. It reads the 402 challenge, decodes the price and payee, and decides whether to pay. The mandate is a per-call ceiling, a mission budget, a price that may not exceed the seller's listing by more than 25%, a fixed payee, a fixed asset, and the cap left on the AP4M channel. If every check passes it signs a voucher locally and pays in RLUSD. If one fails it refuses, signs nothing, and moves no money. There is no human step. A merchant's prose is never read, only amount, payee, asset and ledger state.

Every run picks one of six seeded scenarios, so runs differ: a visibility audit where a second purchase depends on what the first one shows, a comparison of three vendors of the same quote, a budget that covers two of three datasets, a failover when the preferred seller is offline, a premium report that is honestly priced but above the per-call ceiling, and a live-weather purchase where two feeds sell a real Open-Meteo reading (one raised its price and is refused) and the agent decides whether a crew should work. The seed is printed and replays a run exactly.

The proof is read from the chain, not from the agent's own output. For each purchase the run reads the receipt, finds the VoucherRedeemed event, and checks that the claim id matches. It then compares the merchant payout balance before and after, and that balance must rise by exactly what the agent spent. Across 15 live runs on XRPL EVM Testnet there were 20 purchases totalling 0.47 RLUSD. All 20 were re-read from the chain and confirmed, and the payout balance rose by exactly the amount spent in 15 of 15 runs. The agent also made 13 refusals (10 price changes above the listing, 1 above the per-call ceiling, 2 over the mission budget). Refusals leave no trace on any ledger, so they are labelled agent-reported, not chain-verified.

TRIPWIRE is the attack board for an agent that has been fooled. Each scenario is a hostile merchant message and the pay() call a fooled agent would make from it: a price bump above the limit, a payout address swapped to an attacker, an "ignore all previous instructions" jailbreak, an unverified merchant, and an over-cap voucher. The left column shows what the merchant injected and the resulting call. The right column shows the guard that decided it, the reason, and whether funds moved. A sixth scenario is a legitimate in-policy payment that must be approved, to show the guards are not simply blocking everything. Every scenario is checked against an expected guard, and a mismatch fails the suite. A judge can enter their own pay() parameters and see which guard fires.

Data: every Dispatch seller now fetches real public data when it starts (Open-Meteo weather, FRED price series, National Weather Service alerts, a site's own robots.txt and llms.txt) and goes offline, selling nothing, if the source fails. The 15 recorded runs predate that change: 14 bought sample fixture data and 1 (live-weather) bought a real Open-Meteo reading. No paid run of the new sellers is recorded yet.

TRIPWIRE now signs real EIP-712 vouchers with the SDK's signVoucher, using throwaway test keys (never the team's agent key), and its guards verify them: a voucher forged by another key, a replay of an already-redeemed amount, a tampered amount or channel, and a signature for another ledger or chain are all refused, while the genuine control voucher is approved. 8 scenarios, plus a voucher test file.

What this is not: the decisions are plain code over integers, with no LLM. All sellers share one merchant identity, and its payout wallet also receives deposits from outside these runs, so the balance check is a before/after within a single run. TRIPWIRE's guards are a local model of the money layer: it signs and verifies vouchers locally and never submits one, so no scenario moves funds and an approval means authorised, not paid. It does not call the PaymentLedger contract. The live payments come from Dispatch.

## Technical Description
Node ESM, ethers v6, AP4M SDK, x402. Dispatch starts seller servers with createX402Merchant, reads each PAYMENT-REQUIRED header, and pays with channel vouchers (EIP-712, cumulative). policy.mjs decides with bigint arithmetic: payee, asset, price against listing, per-call ceiling, mission budget, channel cap. Proof: receipt, VoucherRedeemed claim id, and payout balanceOf before/after. Settlement retries with backoff and timeouts; the last settle does not block (payout balance is polled). Each run writes an evidence JSON; audit-manifest.mjs re-reads every purchase from the chain and hashes the files (SHA-256; not a signature, not anchored on-chain). TRIPWIRE: guards.mjs checks registry, payout, per-call limit, cap, then voucher replay, binding and EIP-712 signature (SDK signVoucher, throwaway keys); live mode reads getChannelState.

Scope: no LLM; sellers fetch real public data (fail closed), no paid run yet; one shared merchant identity; TRIPWIRE vouchers are never submitted.
