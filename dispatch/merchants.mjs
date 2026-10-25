import { ethers } from 'ethers';
import { loadX402Context, createX402Merchant } from './ap4m-x402.mjs';

const BASE_PORT = 8411;

/**
 * Start one independent x402 seller per entry. They share the team's single on-chain Merchant identity
 * and payout wallet (the hackathon registers one per team) but run as separate services with their own
 * price and content. A seller marked `down` is given a URL but never started, so it is unreachable.
 * Sets `url` on each seller.
 */
export async function startMerchants(sellers, stateRoot, log = () => {}) {
  const context = await loadX402Context(process.env.AP4M_API_URL);
  const rpcUrl = process.env.QUICKNODE_EVM_RPC_URL
    || (await (await fetch(`${process.env.AP4M_API_URL}/public/config`)).json()).network.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1449000);
  // The Merchant's own wallet sends the redemption and pays its gas. The agent only ever signs vouchers.
  const submitter = new ethers.Wallet(process.env.MERCHANT_SUBMITTER_KEY ?? process.env.MERCHANT_PRIVATE_KEY, provider);
  const closers = [];
  for (const [i, s] of sellers.entries()) {
    const port = BASE_PORT + i;
    s.url = `http://127.0.0.1:${port}/resource`;
    if (s.live && !s.down) {
      // Real data is fetched once, when the seller starts. If the source is unreachable the seller goes offline;
      // nothing is substituted, so the agent never pays for made-up data.
      try {
        s.content = await s.live();
        // What the directory advertises (for example data age) comes from the real data, not from the scenario.
        if (s.metaFrom) s.meta = s.metaFrom(s.content);
      } catch (e) { s.down = true; log(`seller ${s.id}: live source failed (${e.message}); seller OFFLINE, nothing substituted`); }
    }
    if (!s.down && s.content?.placeholder) throw new Error(`seller ${s.id} would serve placeholder content`);
    if (s.down) { log(`seller ${s.id} on :${port} is OFFLINE`); continue; }
    const { server, close } = createX402Merchant({
      context, provider, submitter, resourceUrl: s.url,
      merchantParticipantId: process.env.MERCHANT_PARTICIPANT_ID,
      payout: process.env.MERCHANT_PAYOUT_ADDRESS,
      amount: ethers.parseUnits(s.price, 18).toString(),
      content: { ...s.content, measuredAt: new Date().toISOString() },
      stateDirectory: `${stateRoot}/${s.id}`,
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    closers.push(close);
    log(`seller ${s.id} on :${port} asking ${s.price} RLUSD (listed ${s.listedPrice})`);
  }
  return { provider, close: async () => { for (const c of closers) await c(); } };
}
