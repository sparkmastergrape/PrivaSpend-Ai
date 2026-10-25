# TRIPWIRE — LLM Prompt Injection vs. Cryptographic Guardrails

> *"The agent can be talked into anything. The money can't."*

TRIPWIRE is a security-focused demonstration layer built for the **Mastercard XRPL Hackathon**. It pits a vulnerable LLM agent against Mastercard's **AP4M (Agent Pay for Machines)** cryptographic and programmatic authority stack.

---

## 🎯 What TRIPWIRE Proves

While LLMs are inherently susceptible to prompt injection and adversarial manipulation, financial settlement must remain deterministic and safe. TRIPWIRE proves that even if an attacker successfully tricks an LLM into issuing invalid or malicious payments, **the funds cannot move** due to strict cryptographic guardrails:

1. **Know Your Agent (KYA) / Merchant Gate:** Prevents payments to unverified or hijacked payout addresses.
2. **Authorized Spend Limits (ASL):** Programmatically enforced channel caps ($settled \le redeemed \le cap$) backed by EIP-712 local voucher signing.
3. **Max-Per-Call Safety Limits:** Intercepts price bumps at the local agent boundary before voucher creation.

---

## 📂 Repository Contents

- `attacks.json`: Configurable hostile merchant attack scenarios (price bumps, payout swaps, jailbreak prompts, over-cap vouchers).
- `tripwire-engine.mjs`: Test execution harness that runs hostile scenarios against the AP4M SDK and evaluates guardrail responses.
- `server.mjs`: Live interactive dashboard and judge sandbox.
- `ap4m-hackathon-sdk.js`: Official CommonJS SDK helper module.
- `ap4m-x402.mjs`: Official x402 HTTP 402 payment module.

---

## 🚀 Quickstart Guide

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment (optional)
No key is needed. The scenarios sign with public throwaway test keys. Live mode (`LIVE=1 npm start`) only reads a channel's state from the public API:
```bash
export AP4M_API_URL="https://hackathon.ap4m.build"   # default
export CHANNEL_ID="0x..."                           # default: a recorded channel
```

### 3. Run the TRIPWIRE Attack Engine
```bash
node tripwire-engine.mjs
```

### 4. Launch the Live Judge Board
```bash
node server.mjs
```
Open `http://localhost:3000` in your browser.

The page shows the attack board (injected message and resulting `pay()` call on the left, the guard that decided on the right) and a **judge sandbox** form: type your own amount, payee and limits, optionally forge the signature or replay a redeemed voucher, and see which guard fires. The same is available as `POST /api/inject`. The logo is `logo.svg`.

---

## What this actually tests (read before pitching)

- `guards.mjs` holds the guard logic; `tripwire-engine.mjs` and `server.mjs` both call it. Each scenario's result is compared against `expected_guard` / `expected_outcome`; a mismatch exits non-zero.
- Registry, bound payout, cap (1.0) and redeemed (0) are **local policy values**, overridable with `VERIFIED_MERCHANT_ID`, `BOUND_PAYOUT`, `CHANNEL_CAP`, `CHANNEL_REDEEMED`. Offline it does not read the live PaymentLedger. It **does** sign a real EIP-712 voucher for every scenario with the AP4M SDK's `signVoucher` (`voucher.mjs`) and the guards verify it, but the verification is local (`ethers.verifyTypedData`), not the contract's, so it demonstrates guard logic, not on-chain enforcement.
- There is no LLM in the loop. The scenarios assume the agent was fooled and emit the resulting `pay()` call. The jailbreak text is not detected; the cap stops the call.
- `control_legit` must be APPROVED, which shows the guards do not just block everything. Approved means authorised: no voucher is ever submitted, so `fundsMoved` is always `0 RLUSD`.
- Voucher guards, after the amount/payee/cap checks: `VoucherReplayGuard` (cumulative must exceed what the ledger already redeemed), `VoucherBindingGuard` (right channel, and cumulative = redeemed + this call), `VoucherSignatureGuard` (the EIP-712 signature must recover to the channel's agent; no voucher also fails here). `forged_signature` and `voucher_replay` target the last two.
- Signing uses **throwaway test keys derived from public strings** (`TEST_AGENT`, `TEST_ATTACKER` in `voucher.mjs`). The suite never reads `AGENT_PRIVATE_KEY`, so it cannot produce a voucher that could be redeemed against the team's channel. In `--live` mode the domain is the real PaymentLedger address and chain id from the public config; scenarios that need headroom under the cap are reported as SKIP if the live channel has too little left, not as failures.
- `npm test` runs the suite and `test.mjs` (genuine, forged, tampered, wrong ledger or chain, malformed, replay, ordering).
- `ap4m-hackathon-sdk.cjs` is the CommonJS SDK (this package is `"type": "module"`). `ap4m-x402.mjs` needs `@ap4m/sdk` and is not used by the offline suite.

## Live mode and source tag

- `node tripwire-engine.mjs --live` (or `LIVE=1 npm start`) reads the real `cap` / `redeemed` for `CHANNEL_ID` from the PaymentLedger on XRPL EVM Testnet (read-only, no key). Registry and bound payout are still local values.
- `xrpl-tx.mjs` exports `SOURCE_TAG = 2610250006` and `withSourceTag(tx)`, which stamps an unsigned XRPL transaction and refuses to overwrite a different tag. AP4M's voucher flow runs on the EVM testnet, which has no SourceTag field, so nothing in the suite uses it. It counts for the leaderboard only on native XRPL **mainnet** transactions. `findings.json` and `/api/run` also report the tag.
