import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const sdk = createRequire(import.meta.url)('./ap4m-hackathon-sdk.cjs');

// The Voucher type the PaymentLedger verifies (see signVoucher in the AP4M SDK).
export const VOUCHER_TYPES = { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' }] };

// Throwaway identities for the suite. The keys are derived from public strings, hold nothing, and are not the team's
// agent key: a voucher signed by them cannot be redeemed against the team's real channel. The suite never reads
// AGENT_PRIVATE_KEY, so it cannot produce a voucher that could move real funds.
export const TEST_AGENT = new ethers.Wallet(ethers.id('tripwire-test-agent'));
export const TEST_ATTACKER = new ethers.Wallet(ethers.id('tripwire-test-attacker'));
export const TEST_CHANNEL_ID = ethers.id('tripwire-test-channel');
export const OFFLINE_DOMAIN = { name: 'AP4M Payment Ledger', version: '1', chainId: 1449000n, verifyingContract: ethers.getAddress('0x' + '00'.repeat(19) + '01') };

/** The real chain id and PaymentLedger address from the public config (read-only, no key). */
export async function loadLedgerDomain(apiUrl) {
  const res = await fetch(`${apiUrl}/public/config`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`config unavailable (${res.status})`);
  const cfg = await res.json();
  return { ...OFFLINE_DOMAIN, chainId: BigInt(cfg.network.chainId), verifyingContract: ethers.getAddress(cfg.contracts.paymentLedger) };
}

/**
 * Sign a cumulative voucher with the SDK's own signVoucher. The provider is a static-network stub: signing needs the
 * chain id only, so no RPC call is made and nothing is submitted.
 */
export async function signVoucher(wallet, domain, channelId, cumulativeAmount) {
  const stub = new ethers.JsonRpcProvider('http://127.0.0.1:9', Number(domain.chainId), { staticNetwork: ethers.Network.from(Number(domain.chainId)) });
  const signature = await sdk.signVoucher(wallet.connect(stub), domain.verifyingContract, channelId, cumulativeAmount);
  stub.destroy();
  return { channelId, cumulativeAmount: cumulativeAmount.toString(), signature };
}

/** The address that signed the voucher, or null if the signature is malformed. */
export function recoverVoucherSigner(domain, voucher) {
  try {
    return ethers.verifyTypedData(domain, VOUCHER_TYPES, { channelId: voucher.channelId, cumulativeAmount: BigInt(voucher.cumulativeAmount) }, voucher.signature);
  } catch { return null; }
}
