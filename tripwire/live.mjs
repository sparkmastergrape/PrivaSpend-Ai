import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { loadLedgerDomain } from './voucher.mjs';

const sdk = createRequire(import.meta.url)('./ap4m-hackathon-sdk.cjs');
const API = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const CHANNEL_ID = process.env.CHANNEL_ID || '0x6d824358aa10ae33fb4ccf7deaab5e54147d4682963faeb4334518f2e26f320b';

/** Read the real cap / redeemed for CHANNEL_ID from the PaymentLedger (read-only, no key needed). */
export async function loadLivePolicy() {
  const res = await fetch(`${API}/public/config`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`config unavailable (${res.status})`);
  const cfg = await res.json();
  const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, Number(cfg.network.chainId));
  const ch = await sdk.getChannelState(provider, cfg.contracts.paymentLedger, CHANNEL_ID);
  if (ch.cap === 0n) throw new Error(`channel ${CHANNEL_ID} not found on ledger (cap is 0)`);
  const domain = await loadLedgerDomain(API);
  return { domain, cap: ch.cap, redeemed: ch.redeemed, source: { chain: cfg.network.name, ledger: cfg.contracts.paymentLedger, channelId: CHANNEL_ID, status: ch.status } };
}
