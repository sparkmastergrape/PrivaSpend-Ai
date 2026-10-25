import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { buyResource, loadX402Context } from './ap4m-x402.mjs';
import { decodeX402PaymentRequired } from '@ap4m/sdk';
import { decide } from './policy.mjs';
import { withRetry } from './retry.mjs';

const sdk = createRequire(import.meta.url)('./ap4m-hackathon-sdk.cjs');
const ERC20 = ['function balanceOf(address) view returns (uint256)'];
const REDEEMED_TOPIC = ethers.id('VoucherRedeemed(bytes32,bytes32,bytes32,bytes32,address,bytes32,address,address,uint256,uint256,uint256)');
const fmt = (v) => ethers.formatUnits(v, 18);
const EXPLORER = 'https://explorer.testnet.xrplevm.org';
const buyRetryable = (e) => /waiting for a new chain block|HTTP 503|timed out|fetch failed|ECONNRESET/i.test(String(e?.message ?? e));

export class PreflightError extends Error {}

/**
 * Runs one scenario. The scenario supplies the sellers, the mandate and the reasoning (`run(ctx)`);
 * this function supplies identity, the channel, policy enforcement, payment, settlement and proof.
 * Decisions are plain code over integers, not an LLM, and the scenario cannot bypass the policy.
 */
export async function runAgent({ scenario, built, seed, provider, runId, stateDir, log = console.log }) {
  const policy = scenario.policy;
  const sellers = built.sellers;
  const API = process.env.AP4M_API_URL;
  const cfg = await (await fetch(`${API}/public/config`)).json();
  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  const ledger = cfg.contracts.paymentLedger;
  const token = new ethers.Contract(cfg.contracts.rlusdToken, ERC20, provider);
  const trusted = { payout: process.env.MERCHANT_PAYOUT_ADDRESS, asset: cfg.contracts.rlusdToken };
  const context = await loadX402Context(API);
  const t0 = Date.now();
  const ev = { runId, scenario: scenario.id, title: scenario.title, mandate: policy, seed, agent: wallet.address, payout: trusted.payout, purchases: [], refusals: [], timeline: [],
    // 'live' means every seller fetched its data from a public source when it started (see realdata.mjs). Older runs have no field.
    dataSource: sellers.every((s) => typeof s.live === 'function') ? 'live' : 'fixture' };
  // Ordered, timestamped decisions. Refusals leave no trace on any ledger, so this is the only record of them.
  const mark = (kind, data) => ev.timeline.push({ at: new Date().toISOString(), kind, ...data });

  log(`\nSCENARIO ${scenario.id}  (seed ${seed})`);
  log(`TASK     ${scenario.task}`);
  log(`MANDATE  per-call ceiling ${policy.perCallCeiling} RLUSD, mission budget ${policy.missionBudget} RLUSD, price may not exceed listing +${policy.priceTolerancePct}%`);
  log(`AGENT    ${wallet.address}  (signs vouchers locally; the merchant never sees its key)\n`);

  // 1. identity + channel
  const session = await withRetry(() => sdk.signIn(API, process.env.TEAM_NAME, wallet), { label: 'sign-in', log });
  const channels = await sdk.listChannels(API, session.token);
  const wanted = process.env.CHANNEL_ID?.toLowerCase();
  const open = channels.filter((c) => c.channel_status === 'open');
  let channel = wanted ? open.find((c) => c.channel_id.toLowerCase() === wanted) : undefined;
  if (!channel && open.length) {
    // No CHANNEL_ID: use the open channel with the most cap left, not whichever the service lists first.
    const left = await Promise.all(open.map(async (c) => { const s = await sdk.getChannelState(provider, ledger, c.channel_id); return s.cap - s.redeemed; }));
    channel = open[left.indexOf(left.reduce((a, b) => (b > a ? b : a)))];
  }
  if (!channel) throw new PreflightError('no open channel; open one from the portal or set CHANNEL_ID');
  const channelId = channel.channel_id;
  const state = () => sdk.getChannelState(provider, ledger, channelId);
  let st = await state();
  const remaining = st.cap - st.redeemed;
  log(`[1] channel ${channelId.slice(0, 18)}…  cap ${fmt(st.cap)}  redeemed ${fmt(st.redeemed)}  remaining ${fmt(remaining)} RLUSD`);
  if (remaining < ethers.parseUnits(scenario.maxSpend, 18)) {
    throw new PreflightError(`this scenario can spend up to ${scenario.maxSpend} RLUSD but the channel has ${fmt(remaining)} left; open a new channel or pick another scenario`);
  }
  if (remaining < ethers.parseUnits(scenario.maxQuote, 18)) {
    log(`[1] warning: a seller here asks up to ${scenario.maxQuote} RLUSD, above the ${fmt(remaining)} left. The SDK cannot quote above the remaining cap, so that seller will look unavailable instead of overpriced.`);
  }
  const payoutBefore = await token.balanceOf(trusted.payout);
  log(`[1] merchant payout balance before: ${fmt(payoutBefore)} RLUSD`);
  ev.channelId = channelId;
  ev.payoutBefore = payoutBefore.toString();
  ev.redeemedStart = st.redeemed.toString();

  let spent = 0n;
  // The channel carries one unsettled claim at a time, so a claim must be settled before the next request.
  // That is deferred: the last purchase is never settled by a blocking call, because the service settles on its own.
  let pendingSettle = null;
  async function flushSettle() {
    if (!pendingSettle) return;
    const p = pendingSettle;
    pendingSettle = null;
    log(`    settling ${p.seller}'s claim before the next request...`);
    const s = await settleNow();
    p.settlementTx = s.settlement_tx;
    p.payoutTx = s.payout_tx;
    mark('settle', { seller: p.seller, settlementTx: s.settlement_tx, payoutTx: s.payout_tx });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settleNow = () => withRetry(() => sdk.settle(API, session.token, channelId), { label: 'settle', log, attemptTimeoutMs: 40_000 });
  const find = (id) => { const s = sellers.find((x) => x.id === id); if (!s) throw new Error(`unknown seller ${id}`); return s; };

  // Read a seller's 402 and apply the policy. Probing costs nothing and signs nothing.
  async function quote(seller) {
    await flushSettle();
    let probe;
    try {
      probe = await withRetry(async () => {
        const r = await fetch(seller.url, { headers: { 'X-AP4M-CHANNEL-ID': channelId }, signal: AbortSignal.timeout(20_000) });
        if (r.status === 503) throw new Error('merchant unavailable (503)');
        return r;
      }, { label: 'probe', log, attempts: 3, baseMs: 700 });
    } catch (e) {
      return { ok: false, reason: seller.down ? 'offline' : e.message };
    }
    if (probe.status !== 402) return { ok: false, reason: `HTTP ${probe.status}, not an x402 paywall` };
    const required = decodeX402PaymentRequired(probe.headers.get('payment-required') ?? '');
    const price = BigInt(required.accepts[0].amount);
    st = await state();
    const decision = decide({ required, listing: seller, trusted, policy, spent, channelRemaining: st.cap - st.redeemed });
    return { ok: true, required, price, decision };
  }

  const ctx = {
    log,
    sellers,
    get spent() { return spent; },

    // Free look at a price and what the policy would say.
    async peek(id) {
      const seller = find(id);
      const q = await quote(seller);
      if (!q.ok) { log(`[peek] ${id}: ${q.reason}`); mark('unavailable', { seller: id, stage: 'peek', reason: q.reason }); return null; }
      log(`[peek] ${id}: asks ${fmt(q.price)} (listed ${seller.listedPrice}) -> would ${q.decision.buy ? 'PAY' : `REFUSE [${q.decision.guard}]`}`);
      mark('peek', { seller: id, askedRlusd: fmt(q.price), listedRlusd: seller.listedPrice, wouldPay: q.decision.buy, guard: q.decision.guard });
      if (!q.decision.buy) ev.refusals.push({ seller: id, stage: 'peek', guard: q.decision.guard, reason: q.decision.reason, askedRlusd: fmt(q.price) });
      return q;
    },

    // Ask, read the 402, decide, and only then pay. Returns the delivered resource, or null.
    async buy(id, why) {
      const seller = find(id);
      log(`\n[?] ${id}: ${why}`);
      const q = await quote(seller);
      if (!q.ok) {
        log(`    could not get a price (${q.reason}); skipping`);
        ev.refusals.push({ seller: id, guard: 'Unavailable', reason: q.reason });
        mark('unavailable', { seller: id, stage: 'buy', reason: q.reason });
        return null;
      }
      log(`    HTTP 402. merchant asks ${fmt(q.price)} RLUSD (listed ${seller.listedPrice}) to ${q.required.accepts[0].payTo.slice(0, 10)}…`);
      const d = q.decision;
      if (!d.buy) {
        log(`    DECISION: REFUSE  [${d.guard}] ${d.reason}`);
        log('    no voucher signed, no money moved');
        ev.refusals.push({ seller: id, guard: d.guard, reason: d.reason, askedRlusd: fmt(q.price) });
        mark('refuse', { seller: id, guard: d.guard, reason: d.reason, askedRlusd: fmt(q.price), listedRlusd: seller.listedPrice });
        return null;
      }
      log(`    DECISION: PAY  ${d.reason}`);
      const before = (await state()).redeemed;
      const res = await withRetry(() => buyResource({
        context, provider, wallet, stateDirectory: `${stateDir}/agent`, resourceUrl: seller.url, channelId,
        maximumAmount: d.price.toString(), operation: `${runId}-${id}`.slice(0, 64),
      }), { label: 'buy', log, retryIf: buyRetryable, attempts: 4 });
      const after = (await state()).redeemed;
      spent += d.price;
      log(`    PAID  tx ${res.transactionHash}`);
      log(`          claim ${res.claimId}`);
      const purchase = {
        seller: id, priceRlusd: fmt(d.price), tx: res.transactionHash, claimId: res.claimId,
        redeemedBefore: before.toString(), redeemedAfter: after.toString(),
      };
      ev.purchases.push(purchase);
      mark('pay', { seller: id, priceRlusd: fmt(d.price), tx: res.transactionHash, claimId: res.claimId });
      pendingSettle = purchase;
      return res.resource;
    },
  };

  await built.run(ctx);

  // Proof, read back from the chain.
  log('\n--- PROOF (read from the chain, not from the agent\'s own output) ---');
  if (!ev.purchases.length) log('no purchases were made, so there is nothing to prove on-chain. That is the correct outcome when nothing met the policy.');
  for (const p of ev.purchases) {
    const r = await withRetry(() => provider.getTransactionReceipt(p.tx), { label: 'receipt', log });
    const hit = r.logs.find((l) => l.address.toLowerCase() === ledger.toLowerCase() && l.topics[0] === REDEEMED_TOPIC);
    p.block = r.blockNumber;
    p.status = r.status;
    p.eventClaimId = hit?.topics[2] ?? null;
    p.eventMatchesClaim = hit?.topics[2]?.toLowerCase() === p.claimId.toLowerCase();
    p.deltaRlusd = fmt(BigInt(p.redeemedAfter) - BigInt(p.redeemedBefore));
    log(`${p.seller}: block ${p.block} status ${p.status}  VoucherRedeemed ${p.eventClaimId ? 'found' : 'MISSING'}, claim id matches: ${p.eventMatchesClaim}  channel redeemed +${p.deltaRlusd}`);
    log(`   ${EXPLORER}/tx/${p.tx}`);
  }

  // Settlement: does RLUSD reach the merchant payout?
  if (ev.purchases.length) {
    log('\nwaiting for the payout to arrive (the service settles on its own; no blocking settle call)...');
    const waitForPayout = async (ms) => {
      const end = Date.now() + ms;
      let b = await token.balanceOf(trusted.payout);
      while (b - payoutBefore < spent && Date.now() < end) { await sleep(3000); b = await token.balanceOf(trusted.payout); }
      return b;
    };
    let after = await waitForPayout(45_000);
    ev.settlementMode = 'automatic';
    if (after - payoutBefore < spent) {
      log('not there after 45s; nudging with one settle call (20s limit)...');
      ev.settlementMode = 'nudged';
      try {
        const s = await withRetry(() => sdk.settle(API, session.token, channelId), { label: 'settle-nudge', log, attempts: 1, attemptTimeoutMs: 20_000 });
        ev.settlement = { settlementTx: s.settlement_tx, payoutTx: s.payout_tx, claimsSettled: s.claims_settled, amountRlusd: s.amount_rlusd };
      } catch (e) { log(`nudge failed: ${e.message}`); }
      after = await waitForPayout(30_000);
    }
    if (pendingSettle && after - payoutBefore >= spent) {
      mark('settle', { seller: pendingSettle.seller, via: 'payout balance' });
      pendingSettle = null;
    }
    ev.payoutAfter = after.toString();
    ev.spent = spent.toString();
    log(`merchant payout balance: ${fmt(payoutBefore)} -> ${fmt(after)} RLUSD  (+${fmt(after - payoutBefore)}; agent spent ${fmt(spent)})`);
    if (ev.settlement) log(`   payout tx ${EXPLORER}/tx/${ev.settlement.payoutTx}`);
    log(`   settled ${ev.settlementMode === 'automatic' ? 'automatically by the service' : 'after a nudge'}`);
    ev.payoutDeltaMatchesSpend = after - payoutBefore === spent;
    mark('payout-check', { beforeRlusd: fmt(payoutBefore), afterRlusd: fmt(after), spentRlusd: fmt(spent), matches: ev.payoutDeltaMatchesSpend });
    log(ev.payoutDeltaMatchesSpend
      ? 'payout increase equals what the agent spent.'
      : 'WARNING: payout increase differs from the agent spend (other claims may have settled, or settlement is still pending).');
  }
  ev.elapsedSeconds = Math.round((Date.now() - t0) / 1000);
  log(`\nelapsed ${ev.elapsedSeconds}s   purchases ${ev.purchases.length}   refusals ${ev.refusals.length}   spent ${fmt(spent)} RLUSD`);
  log(`replay this exact run: node demo.mjs --scenario ${scenario.id} --seed ${seed}`);
  return ev;
}
