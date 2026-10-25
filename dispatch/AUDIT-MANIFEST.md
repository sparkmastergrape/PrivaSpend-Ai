# Dispatch audit manifest

Generated 2026-10-25T14:58:57.851Z from 15 evidence files in this folder.

## What this is, and is not

- A summary of what real runs recorded, plus a SHA-256 over those files. Every figure below comes from an evidence file or, where marked, from a fresh read of the chain.
- The hash lets you detect that a file changed **if you keep the hash somewhere other than this folder**. It is not a signature and it is not anchored on any chain.
- It does not prove a run happened. The transactions do: each purchase below has a hash you can look up on the XRPL EVM Testnet explorer.
- Refusals and peeks are the agent's own record. They leave nothing on a ledger, so nothing here can independently confirm them.
- Data bought: 1 of 15 runs bought real data fetched from a public source when the seller started (Open-Meteo, FRED, the National Weather Service, or a site's own robots.txt). The other 14 were recorded before that change and bought sample fixture data, not a live measurement. The agent's decisions are plain code over integers, not an LLM.

## Totals

- Runs: 15
- Purchases: 20, totalling 0.47 RLUSD
- Policy refusals by the agent (agent-reported): 13 (PriceChangeGuard x10, MaxPerCallGuard x1, MissionBudgetGuard x2)
- Runs where the merchant payout balance rose by exactly the amount spent: 15 of 15 that recorded the check
- Purchases re-read from the chain at 2026-10-25T14:58:54.933Z: 20 of 20 confirmed (receipt status 1, VoucherRedeemed found, claim id matches)

## Hash

Combined SHA-256: `2ff6202d634e1fecd76cbb967bac03c44b55370e5a8bb1ded3e6a1f64c79f380`

It is the SHA-256 of the following lines, which `sha256sum --text` prints for these files (plain `sha256sum` on Windows Git Bash adds a `*` binary marker, which changes the combined hash but not the per-file hashes):

```
8562918807908edfd6607dd34889720f47b8115ac524eaf920c606cd9fc9e97c  evidence-rmvnjbzqp.json
03aa32456c2a1739c90717da371a64b046c10b0c3cceb3ae5b4d7e10202b43a3  evidence-rmvnjd3h4.json
e6e89e145246e088fb55482599452fcabbcdc0379b8c03c78d0a470304a33585  evidence-rmvnjkwvv.json
23b8a2eb6a0ff535631a23d3be8eab42a95d6c750b7098132c62dae9e16809fa  evidence-rmvnjnmmi.json
897b7397954d27d6f1e3894ccd76d2cb084e3b0faafa6df8e4529e41d222e597  evidence-rmvnjwr03.json
aa5df4e4d9bbd02136984b20704f1b65ba21b70fb632a27cb5b61776fba04940  evidence-rmvnk1su3.json
63f5f9a9d01d682e4a186e703899687c87c688eb27225435ea13f6c0b4bec482  evidence-rmvnk32t1.json
1e509a683746a17665d951670ae713adef1b57d272e407c771533ada5c75c139  evidence-rmvnl4p7q.json
6e291bf38c9523105a31a9b0564c35e10feca927b05507a74f57fb2fdfaf44cb  evidence-rmvnlav5a.json
13856c532295fec562685adc473ab0a9966a883cb6f61b5997679e774b1e889a  evidence-rmvnlbaa0.json
4890916f734b07dae72c3333dfe97b3c6ea084f658fe52ca07f960d17b5fbd9a  evidence-rmvnluenf.json
bbdd4485b1164ff054d1acf6a5b9bdb4ebcdff8b9537b6897608e760246ecd58  evidence-rmvnma61r.json
60fa76a80f4789a4aec5864b9f9d024addf12097c188b76bbc2a2126da2042bf  evidence-rmvnmt9nn.json
a3b37b2bbe5d8935fae3b33d62f8c8b9c36e487efa022c58b88228f593357ba9  evidence-rmvnn5ikc.json
ef0fcf0ce0e49b8e835c2b0fd03fdd58c92b4f0f3bbf995ff675e44fc906564e  evidence-rmvnspwts.json
```

To reproduce: `ls evidence-r*.json | LC_ALL=C sort | while read f; do sha256sum --text "$f"; done | sha256sum --text`

## Runs

### visibility-audit, first version (before scenarios)

- Evidence file: `evidence-rmvnjbzqp.json`  sha256 `8562918807908edf…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Spent: 0.02 RLUSD across 1 purchase(s); elapsed 27s
- Merchant payout balance: 0.915682 -> 0.935682 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to citation-snapshot: [0xfdfe7e5f…](https://explorer.testnet.xrplevm.org/tx/0xfdfe7e5fd59c68bdf42d5c27b8935d59680fe94a9bd0ef61ad2ca195ac8fae1a), claim `0x265be473…`; re-verified from chain, block 9230867
- Refused premium-forecast [PriceChangeGuard] (agent-reported): asks 0.06 RLUSD but was listed at 0.02 (tolerance 25%)

### visibility-audit, first version (before scenarios)

- Evidence file: `evidence-rmvnjd3h4.json`  sha256 `03aa32456c2a1739…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Spent: 0.05 RLUSD across 2 purchase(s); elapsed 72s
- Merchant payout balance: 0.935682 -> 0.985682 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to citation-snapshot: [0x2d6448f8…](https://explorer.testnet.xrplevm.org/tx/0x2d6448f8933c1c8ec266dfc1817f3c3b61e60b3be0ee46105975a5fd7d97abe6), claim `0x3bb27a35…`; re-verified from chain, block 9230876
- Paid 0.03 RLUSD to competitor-benchmark: [0x26d131f8…](https://explorer.testnet.xrplevm.org/tx/0x26d131f8dc43bc2ad65778af0a7c3292ef95b34c63e1d34c8130478372820fdd), claim `0x9d6340b9…`; re-verified from chain, block 9230880
- Could not reach premium-forecast (agent-reported): merchant unavailable (503)

### comparison-shopper (seed 7)

- Evidence file: `evidence-rmvnjkwvv.json`  sha256 `e6e89e145246e088…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario comparison-shopper --seed 7`
- Spent: 0.02 RLUSD across 1 purchase(s); elapsed 25s
- Merchant payout balance: 0.985682 -> 1.005682 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to quote-vendor-a: [0x56234843…](https://explorer.testnet.xrplevm.org/tx/0x56234843d7d992c51980a3e7019fd534ec20a10f732888917d8d9ccc8ba7e2c1), claim `0xd487e8b8…`; re-verified from chain, block 9230939

### failover (seed 4182471775)

- Evidence file: `evidence-rmvnjnmmi.json`  sha256 `23b8a2eb6a0ff535…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario failover --seed 4182471775`
- Spent: 0.03 RLUSD across 1 purchase(s); elapsed 32s
- Merchant payout balance: 1.005682 -> 1.035682 RLUSD (rose by exactly the spend)
- Paid 0.03 RLUSD to backup-leads-2: [0x820dbe14…](https://explorer.testnet.xrplevm.org/tx/0x820dbe14ade2e72b8d214d125dc0cb7807f69904c4e796f0655643121578cb15), claim `0x9183dbfc…`; re-verified from chain, block 9230961
- Refused backup-leads-1 [PriceChangeGuard] (agent-reported): asks 0.05 RLUSD but was listed at 0.03 (tolerance 25%)
- Could not reach primary-leads (agent-reported): offline

### visibility-audit (seed 3429393645)

- Evidence file: `evidence-rmvnjwr03.json`  sha256 `897b7397954d27d6…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario visibility-audit --seed 3429393645`
- Spent: 0.05 RLUSD across 2 purchase(s); elapsed 65s
- Merchant payout balance: 1.035682 -> 1.085682 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to citation-snapshot: [0x8aff7049…](https://explorer.testnet.xrplevm.org/tx/0x8aff7049b3578be140f1e97c5f388d6628be346443eefb6049f5dbc4df06efa2), claim `0x761ef41b…`; re-verified from chain, block 9231035
- Paid 0.03 RLUSD to competitor-benchmark: [0xea8e9a5f…](https://explorer.testnet.xrplevm.org/tx/0xea8e9a5f4a0da70e42b1efdf1fc23708a0626ee96ff0c8c526ca1de3cb54d23b), claim `0xc255cdbe…`; re-verified from chain, block 9231040
- Refused premium-forecast [PriceChangeGuard] (agent-reported): asks 0.04 RLUSD but was listed at 0.02 (tolerance 25%)

### premium-too-expensive (seed 845217676)

- Evidence file: `evidence-rmvnk1su3.json`  sha256 `aa5df4e4d9bbd021…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario premium-too-expensive --seed 845217676`
- Spent: 0.02 RLUSD across 1 purchase(s); elapsed 38s
- Merchant payout balance: 1.105682 -> 1.125682 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to summary-report: [0x91b87da7…](https://explorer.testnet.xrplevm.org/tx/0x91b87da7db3f23f0edaec0484be8554c728eebbf009fd4137e34405cbc70e36a), claim `0x4d5a984b…`; re-verified from chain, block 9231075
- Refused premium-report [MaxPerCallGuard] (agent-reported): asks 0.09 RLUSD, per-call ceiling is 0.05

### budget-squeeze (seed 1257964041)

- Evidence file: `evidence-rmvnk32t1.json`  sha256 `63f5f9a9d01d682e…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario budget-squeeze --seed 1257964041`
- Spent: 0.04 RLUSD across 2 purchase(s); elapsed 78s
- Merchant payout balance: 1.125682 -> 1.165682 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to demand-data: [0xc374f5b6…](https://explorer.testnet.xrplevm.org/tx/0xc374f5b6bba80afab37ae9cc815e1014f932d5530234e7f8e2e0093618931eb5), claim `0xf1cf07de…`; re-verified from chain, block 9231086
- Paid 0.02 RLUSD to pricing-data: [0x19480ea4…](https://explorer.testnet.xrplevm.org/tx/0x19480ea4948a0bdae93e76238e170475113245a9d20296237ed9498717da6162), claim `0xe44fd8ba…`; re-verified from chain, block 9231091
- Refused competition-data [MissionBudgetGuard] (agent-reported): 0.04 spent + 0.02 exceeds mission budget 0.05

### comparison-shopper (seed 99)

- Evidence file: `evidence-rmvnl4p7q.json`  sha256 `1e509a683746a176…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario comparison-shopper --seed 99`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.02 RLUSD across 1 purchase(s); elapsed 150s
- Merchant payout balance: 11.270426 -> 11.290426 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to quote-vendor-c: [0xb17fd286…](https://explorer.testnet.xrplevm.org/tx/0xb17fd2869e1843b63eb7ad0182f46ad4cf3c9d3baba4defbc1ee3ff6bbee6399), claim `0xe8fd0f6f…`; re-verified from chain, block 9231389
- Refused quote-vendor-b [PriceChangeGuard] (agent-reported): asks 0.04 RLUSD but was listed at 0.03 (tolerance 25%)

### comparison-shopper (seed 99)

- Evidence file: `evidence-rmvnlav5a.json`  sha256 `6e291bf38c952310…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario comparison-shopper --seed 99`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.02 RLUSD across 1 purchase(s); elapsed 19s; settlement automatic
- Merchant payout balance: 11.290426 -> 11.310426 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to quote-vendor-c: [0x8eb9faa3…](https://explorer.testnet.xrplevm.org/tx/0x8eb9faa3381aecf6e7263ed6d12fc73bdcea024745d94fefd223e6ae1a4263db), claim `0x1ef735db…`; re-verified from chain, block 9231439
- Refused quote-vendor-b [PriceChangeGuard] (agent-reported): asks 0.04 RLUSD but was listed at 0.03 (tolerance 25%)

### budget-squeeze (seed 1257964041)

- Evidence file: `evidence-rmvnlbaa0.json`  sha256 `13856c532295fec5…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario budget-squeeze --seed 1257964041`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.04 RLUSD across 2 purchase(s); elapsed 74s; settlement automatic
- Merchant payout balance: 11.310426 -> 11.350426 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to demand-data: [0xf1bd150c…](https://explorer.testnet.xrplevm.org/tx/0xf1bd150cd997c0a2ad2ead6187c1312605a67745c19ef02c940c8540ef4736b8), claim `0xf66b21a9…`; re-verified from chain, block 9231442
- Paid 0.02 RLUSD to pricing-data: [0x0780a516…](https://explorer.testnet.xrplevm.org/tx/0x0780a516a825e5587dbc13bfba8695bb1cf6d64ce93ff3c4dbeeef5d8c0af130), claim `0x4845b291…`; re-verified from chain, block 9231447
- Refused competition-data [MissionBudgetGuard] (agent-reported): 0.04 spent + 0.02 exceeds mission budget 0.05

### failover (seed 7)

- Evidence file: `evidence-rmvnluenf.json`  sha256 `4890916f734b07da…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario failover --seed 7`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.03 RLUSD across 1 purchase(s); elapsed 24s; settlement automatic
- Merchant payout balance: 11.559938 -> 11.589938 RLUSD (rose by exactly the spend)
- Paid 0.03 RLUSD to backup-leads-2: [0x386263a5…](https://explorer.testnet.xrplevm.org/tx/0x386263a5d5c8301b056b0d261754c2aba0ffbc94c56d9d8fe6c38ab014408c86), claim `0xae1fde16…`; re-verified from chain, block 9231596
- Refused backup-leads-1 [PriceChangeGuard] (agent-reported): asks 0.05 RLUSD but was listed at 0.03 (tolerance 25%)
- Could not reach primary-leads (agent-reported): offline

### failover (seed 7)

- Evidence file: `evidence-rmvnma61r.json`  sha256 `bbdd4485b1164ff0…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario failover --seed 7`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.03 RLUSD across 1 purchase(s); elapsed 22s; settlement automatic
- Merchant payout balance: 11.619938 -> 11.649938 RLUSD (rose by exactly the spend)
- Paid 0.03 RLUSD to backup-leads-2: [0x1b6bdb92…](https://explorer.testnet.xrplevm.org/tx/0x1b6bdb92acba1929a176a406e98e055e5df22f54d61572732a9919bcd02ab3f4), claim `0x6aefed20…`; re-verified from chain, block 9231723
- Refused backup-leads-1 [PriceChangeGuard] (agent-reported): asks 0.05 RLUSD but was listed at 0.03 (tolerance 25%)
- Could not reach primary-leads (agent-reported): offline

### visibility-audit (seed 7)

- Evidence file: `evidence-rmvnmt9nn.json`  sha256 `60fa76a80f4789a4…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario visibility-audit --seed 7`
- Mandate: ceiling 0.05, mission budget 0.08, price within listing +25%
- Spent: 0.05 RLUSD across 2 purchase(s); elapsed 71s; settlement automatic
- Merchant payout balance: 11.649938 -> 11.699938 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to citation-snapshot: [0xdf72bac0…](https://explorer.testnet.xrplevm.org/tx/0xdf72bac02e9e6200e4cba90b251de34ea6a3645ed21ea841b931b514fa1e7f1e), claim `0xcffa5fdd…`; re-verified from chain, block 9231877
- Paid 0.03 RLUSD to competitor-benchmark: [0x6c183e41…](https://explorer.testnet.xrplevm.org/tx/0x6c183e41f73ca8baef0ebbdd10f069a28f5c93457aa2fa2943065068b024dec9), claim `0x0d2458ea…`; re-verified from chain, block 9231883
- Refused premium-forecast [PriceChangeGuard] (agent-reported): asks 0.04 RLUSD but was listed at 0.02 (tolerance 25%)

### failover (seed 7)

- Evidence file: `evidence-rmvnn5ikc.json`  sha256 `a3b37b2bbe5d8935…`
- Data: sample fixture data (recorded before sellers fetched real data)
- Replay: `node demo.mjs --scenario failover --seed 7`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.03 RLUSD across 1 purchase(s); elapsed 35s; settlement automatic
- Merchant payout balance: 11.699938 -> 11.729938 RLUSD (rose by exactly the spend)
- Paid 0.03 RLUSD to backup-leads-2: [0xa79fbc1e…](https://explorer.testnet.xrplevm.org/tx/0xa79fbc1e3e30aa216f32aee5aceeab73e6f9af07931d7c04e962aa8c516c8720), claim `0x289eb8c5…`; re-verified from chain, block 9231976
- Refused backup-leads-1 [PriceChangeGuard] (agent-reported): asks 0.05 RLUSD but was listed at 0.03 (tolerance 25%)
- Could not reach primary-leads (agent-reported): offline

### live-weather (seed 601248561)

- Evidence file: `evidence-rmvnspwts.json`  sha256 `ef0fcf0ce0e49b8e…`
- Data: real, fetched from a public source when the seller started
- Replay: `node demo.mjs --scenario live-weather --seed 601248561`
- Mandate: ceiling 0.05, mission budget 0.05, price within listing +25%
- Spent: 0.02 RLUSD across 1 purchase(s); elapsed 26s; settlement automatic
- Merchant payout balance: 11.939426 -> 11.959426 RLUSD (rose by exactly the spend)
- Paid 0.02 RLUSD to weather-feed-b: [0x8db58d10…](https://explorer.testnet.xrplevm.org/tx/0x8db58d105a74c6dfc4627389f5e298e6975f259a8cbbca62b5dec31ea4714360), claim `0x3e1d4bfb…`; re-verified from chain, block 9233591
- Refused weather-feed-a [PriceChangeGuard] (agent-reported): asks 0.04 RLUSD but was listed at 0.02 (tolerance 25%)
