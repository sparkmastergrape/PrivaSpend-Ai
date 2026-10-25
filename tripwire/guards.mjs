import { ethers } from 'ethers';
import { TEST_AGENT, TEST_ATTACKER, TEST_CHANNEL_ID, OFFLINE_DOMAIN, signVoucher, recoverVoucherSigner } from './voucher.mjs';

const UNITS = 18;
const u = (v) => ethers.parseUnits(String(v), UNITS);

// Defaults are overridable via env; MERCHANT_ID / PAYOUT must match the channel's real binding for live runs.
// `agent` is the one address whose signature a voucher on this channel must carry.
export const DEFAULT_POLICY = {
  registry: new Set([process.env.VERIFIED_MERCHANT_ID || 'MERCHANT_VERIFIED_01']),
  boundPayout: (process.env.BOUND_PAYOUT || '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8').toLowerCase(),
  cap: u(process.env.CHANNEL_CAP || '1.0'),
  redeemed: u(process.env.CHANNEL_REDEEMED || '0'),
  channelId: TEST_CHANNEL_ID,
  agent: TEST_AGENT.address,
  domain: OFFLINE_DOMAIN,
};

/**
 * Evaluate a pay() call the way the money layer would. The prompt text is never
 * inspected: the point is that guards key off amount / payee / ledger state / signature only.
 * Order: who is paid, how much, then whether the voucher is genuine and fresh.
 * Returns { outcome, guard, reason }.
 */
export function evaluate(call, policy = DEFAULT_POLICY) {
  const amount = u(call.amount);

  if (!policy.registry.has(call.merchantId)) {
    return deny('KYAParticipantRegistryGuard', `merchant_id ${call.merchantId} is not in ParticipantRegistry.`);
  }
  if (String(call.payout).toLowerCase() !== policy.boundPayout) {
    return deny('MerchantGateGuard', `payout ${call.payout} does not match the channel's bound merchant payout.`);
  }
  if (amount > u(call.maxPerCall)) {
    return deny('MaxPerCallGuard', `${call.amount} RLUSD exceeds max_per_call (${call.maxPerCall} RLUSD).`);
  }
  const cumulative = policy.redeemed + amount;
  if (cumulative > policy.cap) {
    return deny('PaymentLedgerASLGuard', `cumulative ${ethers.formatUnits(cumulative, UNITS)} RLUSD exceeds channel cap ${ethers.formatUnits(policy.cap, UNITS)} RLUSD.`);
  }

  // No voucher, no payment: the ledger moves money only against a signed cumulative voucher.
  const v = call.voucher;
  if (!v) return deny('VoucherSignatureGuard', 'no signed voucher was presented.');
  let claimed;
  try { claimed = BigInt(v.cumulativeAmount); } catch { return deny('VoucherSignatureGuard', 'voucher cumulativeAmount is not an integer.'); }
  if (claimed <= policy.redeemed) {
    return deny('VoucherReplayGuard', `voucher cumulative ${ethers.formatUnits(claimed, UNITS)} RLUSD is not above the ${ethers.formatUnits(policy.redeemed, UNITS)} RLUSD already redeemed; it is a replay.`);
  }
  if (String(v.channelId).toLowerCase() !== String(policy.channelId).toLowerCase() || claimed !== cumulative) {
    return deny('VoucherBindingGuard', `voucher is for channel ${String(v.channelId).slice(0, 10)}… / ${ethers.formatUnits(claimed, UNITS)} RLUSD cumulative, but this call needs this channel / ${ethers.formatUnits(cumulative, UNITS)}.`);
  }
  const signer = recoverVoucherSigner(policy.domain, v);
  if (signer?.toLowerCase() !== policy.agent.toLowerCase()) {
    return deny('VoucherSignatureGuard', `EIP-712 signature recovers to ${signer ?? 'nothing (malformed)'}, not the channel's agent ${policy.agent}.`);
  }
  return { outcome: 'APPROVED', guard: null, reason: 'passed all guards, including the EIP-712 voucher signature' };
}

function deny(guard, reason) {
  return { outcome: 'REJECTED', guard, reason };
}

/**
 * Map an attacks.json scenario to the pay() call a fooled agent would make, and sign the voucher it would present.
 * `signer: "attacker"` is a voucher forged by someone who is not the agent; `voucher: "replay"` re-presents a voucher
 * for an amount the ledger has already redeemed. Signing is local; nothing is submitted.
 */
export async function callFromScenario(s, policy = DEFAULT_POLICY) {
  const redeemed = policy.redeemed > 0n ? policy.redeemed : u(s.channel_redeemed ?? '0');
  const cumulative = s.voucher === 'replay' ? redeemed : redeemed + u(s.requested_amount);
  const wallet = s.signer === 'attacker' ? TEST_ATTACKER : TEST_AGENT;
  const voucher = await signVoucher(wallet, policy.domain, policy.channelId, cumulative);
  return {
    call: { amount: s.requested_amount, maxPerCall: s.max_per_call, merchantId: s.merchant_id, payout: s.payout, voucher },
    redeemed,
    signedBy: wallet.address,
  };
}

/** Run one scenario and compare the observed result against its expectation. */
export async function runScenario(s, policy = DEFAULT_POLICY) {
  const { call, redeemed, signedBy } = await callFromScenario(s, policy);
  // A scenario aimed at a guard after the cap check (voucher guards, or an approval) can only reach it if the call fits
  // under the cap. On a nearly spent live channel it cannot, so say so rather than report a false failure.
  const reachesCap = s.expected_guard === null || /^Voucher/.test(s.expected_guard);
  if (reachesCap && redeemed + u(s.requested_amount) > policy.cap) {
    return { id: s.id, name: s.name, prompt: s.prompt_injection, call, signedBy, pass: null, skipped: `cumulative ${ethers.formatUnits(redeemed + u(s.requested_amount), UNITS)} RLUSD would exceed the ${ethers.formatUnits(policy.cap, UNITS)} RLUSD cap, so the ${s.expected_guard ?? 'approval'} check is not reachable`, fundsMoved: '0 RLUSD', authorised: null };
  }
  const result = evaluate(call, { ...policy, redeemed });
  const pass = result.outcome === s.expected_outcome && result.guard === s.expected_guard;
  return {
    id: s.id, name: s.name, prompt: s.prompt_injection, call, signedBy, ...result,
    expected_guard: s.expected_guard, expected_outcome: s.expected_outcome, pass,
    // The suite never submits a voucher, so no scenario moves funds. An approved call is authorised, not paid.
    fundsMoved: '0 RLUSD',
    authorised: result.outcome === 'APPROVED' ? `${s.requested_amount} RLUSD (voucher signed locally, not submitted)` : null,
  };
}
