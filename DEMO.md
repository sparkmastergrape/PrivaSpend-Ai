# Demo script (no open channel needed)

The reservation's channel slots are used up, so a new paid run is not possible until a new reservation is funded.
This demo uses only things that work today, and says plainly which parts are recorded and which are live.

**Before you start:** restart anything left running from earlier (ports 3000 and 8810 may hold old code):
`tripwire`: `npm start`, `dispatch`: `npm run pane`. Both need Node 24 and the installed `node_modules`.

## Run of show (about 3 minutes)

| Time | Show | Command / page | Say |
|---|---|---|---|
| 0:00 | The claim | one slide or the README title | "Payments aren't the hard part; authority is. An agent can be talked into anything. The money can't." |
| 0:20 | TRIPWIRE board | `cd tripwire && npm start`, then http://localhost:3000 | Eight scenarios, each a hostile message and the `pay()` call a fooled agent would make. Left: what was injected. Right: the guard that stopped it and "Funds moved: 0 RLUSD". The control payment is approved, so the guards aren't just blocking everything. Vouchers are real EIP-712 signatures from the SDK. |
| 1:00 | Judge sandbox | the form at the bottom of the board | Let a judge type an amount, change the payee, tick "forge the signature" or "replay", and fire. Prompt text is ignored; only amount, payee, ledger state and signature count. |
| 1:30 | The agent deciding, on real data | `cd dispatch && npm run check-data -- 7` | Real Open-Meteo, FRED, National Weather Service and robots.txt data, the real policy deciding what to buy, refusing a seller that raised its price. **Say: "Payments are simulated in this step, nothing is paid."** |
| 2:15 | The money, recorded | `cd dispatch && npm run pane`, then http://localhost:8810, pick a run, press **Re-verify on chain** | 15 recorded paid runs, 20 purchases, 0.47 RLUSD. The button re-reads each receipt and `VoucherRedeemed` event from the chain now, not from the saved file. Payout balance rose by exactly the spend in 15 of 15. |
| 2:50 | Close | | "Guardrails at the protocol layer, proof from the chain." |

Do not run `demo.mjs`, `dry.mjs` or `open-channel.mjs` on stage: with no open channel they stop or revert.

## If asked

- **"Is this a live payment?"** The 20 purchases are real testnet payments recorded earlier and re-checked on the chain just now. The check-data step on stage is simulated.
- **"Why no new run?"** The funding reservation allows 12 channel requests and 6 bound channels, both used. The limit is set in the vault contract for every team; a new reservation is needed. Reusing one channel would have avoided it.
- **"Is the data real?"** The sellers now fetch real public data and go offline if a source fails. The 15 recorded runs predate that: 14 bought sample fixture data, 1 bought a real Open-Meteo reading. No paid run of the new sellers is recorded yet.
- **"Is TRIPWIRE on-chain?"** No. It is a local model of the money layer that signs and verifies vouchers and never submits one. Live mode reads the real channel's cap and redeemed amount.
- **"Is there an LLM?"** No. The decisions are plain code over integers.
