# Monitoring the two wallets

Open **http://localhost:8810/wallets** (start the pane with `node pane/pane.mjs` from `dispatch/`).

| Wallet | Address | What to watch |
|---|---|---|
| Agent (buyer) | `0x37f2f4166646ea3cea94bb37babd88a01f52a7a2` | **Channel balance left** goes down on every purchase. The wallet's own RLUSD stays flat, because the agent pays out of channel escrow. |
| Merchant (payout) | `0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8` | **Wallet RLUSD** goes up when a voucher is redeemed (settled), not when the agent buys. |

Override with `WATCH_AGENT` / `WATCH_MERCHANT` if the wallets change.

## How it polls

The page asks the pane every 2 s (`/api/wallets`). The pane reads the chain over JSON-RPC and caches for 1 s:

- latest block, RLUSD and native balances of both wallets;
- channel state of the newest channel in the saved runs;
- `/api/redemptions` (page refreshes it every 10 s): `VoucherRedeemed` events on the PaymentLedger for that channel, with each one marked **saved run: yes/no**. A redemption marked "no" is spending that no saved run accounts for.

No API key reaches the browser. RPC URL and token are read by the pane from the environment only, and error notes show a short code, never the endpoint.

## Using QuickNode

Without a QuickNode URL the page falls back to the public node and shows the badge `public node` plus a note. **No QuickNode URL has been tested yet.** To use one:

1. Create an **XRPL EVM Testnet** endpoint in the QuickNode dashboard (chain id 1449000; mainnet is 1440000 and will be rejected).
2. Put these in a gitignored env file (`ENV_FILE`, or `../../ap4m-hackathon/.env`, or `prep/.env`). Do not paste the URL in chat or commit it:

   ```
   QUICKNODE_EVM_RPC_URL=https://<name>.xrplevm.quiknode.pro/<token>/
   # only if you use header auth instead of the token in the URL:
   QUICKNODE_EVM_TOKEN=<token>
   ```
3. Restart the pane. The pane checks `eth_chainId` == 1449000; if the check fails it falls back to the public node and says so. The badge changes to `QuickNode` when it works.

## Live push over WebSocket (built, optional)

Set `QUICKNODE_EVM_WSS_URL=wss://<name>.xrplevm.quiknode.pro/<token>/` (same env file, same rules) and restart. The pane then subscribes to new blocks and to `VoucherRedeemed` on the PaymentLedger, and pushes them to the page over `/api/live` (server-sent events). The header badge changes from `polling` to `live: websocket`, and a redemption refreshes the page at once and writes a line in the change log. If the socket fails or closes, the badge returns to `polling` and the pane retries with backoff; the 2 s polling never stops, so a dead socket cannot blank the demo.

Verified against a **local mock** WebSocket node only (blocks and logs arrive as events, wrong-chain and no-URL fall back to polling). A real QuickNode WSS endpoint has not been tried, and QuickNode's docs I read did not document `eth_subscribe` for XRPL EVM, so confirm it on your endpoint. A guard that blocks a purchase never reaches the chain, so it produces no block or log event; the guard refusals show in the run's evidence, not here.

## Webhooks and Streams (not built)

From the QuickNode docs:

- **Streams** support XRPL EVM (Block, Block with Receipts, Transactions, Logs, Receipts datasets).
- **Webhooks** list XRPL EVM testnet. REST API at `https://api.quicknode.com/` with an `x-api-key` header; template `evmWalletFilter` takes `templateArgs.wallets`. Docs say 30 credits per payload; deliveries come from 141.148.40.227.
- Both need a **public HTTPS receiver**. The docs I read do not name the signature header, so do not verify signatures by guessing a header name.
- `eth_subscribe` over WSS is not documented for this chain.

Recommendation: keep polling for the demo. The wallets change only on a purchase or a redemption, so 2 s polling shows it within one block, and push adds a public endpoint that can fail on stage. Build the webhook receiver only if you want an always-on alert while the laptop is closed.

## Reading the redemptions table

Rows in amber were not recorded by any saved run. They can be from before the first saved run, from the starter-kit merchant process, or from a run in progress. A new one appearing while no run is active means something else is spending on the channel.
