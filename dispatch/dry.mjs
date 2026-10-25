// No payments. For every scenario: start its real sellers, read each real 402, show what the policy decides.
import * as fs from 'node:fs';
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import { decodeX402PaymentRequired } from '@ap4m/sdk';
import { loadEnv } from './env.mjs';
import { startMerchants } from './merchants.mjs';
import { decide } from './policy.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { makeRng } from './rng.mjs';
const sdk = createRequire(import.meta.url)('./ap4m-hackathon-sdk.cjs');
loadEnv();
const seed = Number(process.argv[2] ?? 42);
const API = process.env.AP4M_API_URL, cfg = await (await fetch(`${API}/public/config`)).json();
for (const sc of SCENARIOS) {
  const built = sc.build(makeRng(seed ^ 0x9e3779b9));
  const dir = `./.state/dry-${sc.id}-${Date.now().toString(36)}`; fs.mkdirSync(dir, { recursive: true });
  const { provider, close } = await startMerchants(built.sellers, dir);
  try {
    const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
    const session = await sdk.signIn(API, process.env.TEAM_NAME, wallet);
    const open = (await sdk.listChannels(API, session.token)).filter((c) => c.channel_status === 'open');
    const states = await Promise.all(open.map((c) => sdk.getChannelState(provider, cfg.contracts.paymentLedger, c.channel_id)));
    const best = states.reduce((bi, s, i) => (s.cap - s.redeemed > states[bi].cap - states[bi].redeemed ? i : bi), 0);
    const ch = open[best], st = states[best];
    const trusted = { payout: process.env.MERCHANT_PAYOUT_ADDRESS, asset: cfg.contracts.rlusdToken };
    console.log(`\n${sc.id}  (seed ${seed}, channel has ${ethers.formatUnits(st.cap - st.redeemed, 18)} left)`);
    for (const s of built.sellers) {
      let r; try { for (let i = 0; i < 4; i++) { r = await fetch(s.url, { headers: { 'X-AP4M-CHANNEL-ID': ch.channel_id }, signal: AbortSignal.timeout(15000) }); if (r.status !== 503) break; await new Promise((x) => setTimeout(x, 1500 * (i + 1))); } } catch { console.log(`  ${s.id.padEnd(22)} unreachable`); continue; }
      if (r.status !== 402) { console.log(`  ${s.id.padEnd(22)} HTTP ${r.status}`); continue; }
      const req = decodeX402PaymentRequired(r.headers.get('payment-required'));
      const d = decide({ required: req, listing: s, trusted, policy: sc.policy, spent: 0n, channelRemaining: st.cap - st.redeemed });
      console.log(`  ${s.id.padEnd(22)} asks ${ethers.formatUnits(req.accepts[0].amount, 18).padEnd(5)} listed ${s.listedPrice.padEnd(5)} -> ${d.buy ? 'PAY' : `REFUSE [${d.guard}]`}`);
    }
  } finally { await close(); }
}
process.exit(0);
