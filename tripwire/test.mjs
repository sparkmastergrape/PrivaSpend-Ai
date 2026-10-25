// Voucher-layer tests. Everything is signed locally with throwaway keys; nothing is submitted anywhere.
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { evaluate, DEFAULT_POLICY } from './guards.mjs';
import { TEST_AGENT, TEST_ATTACKER, signVoucher, recoverVoucherSigner } from './voucher.mjs';

const u = (v) => ethers.parseUnits(v, 18);
const P = DEFAULT_POLICY;
const base = { amount: '0.05', maxPerCall: '0.1', merchantId: 'MERCHANT_VERIFIED_01', payout: '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8' };
const sign = (wallet = TEST_AGENT, cum = u('0.05'), domain = P.domain, channel = P.channelId) => signVoucher(wallet, domain, channel, cum);
const guard = async (voucher, over = {}, policy = P) => evaluate({ ...base, ...over, voucher }, policy).guard;

const good = await sign();
assert.equal(recoverVoucherSigner(P.domain, good), TEST_AGENT.address, 'the SDK signature recovers to the signing key');
assert.equal(evaluate({ ...base, voucher: good }).outcome, 'APPROVED', 'a genuine in-policy voucher is approved');

assert.equal(await guard(undefined), 'VoucherSignatureGuard', 'no voucher, no payment');
assert.equal(await guard(await sign(TEST_ATTACKER)), 'VoucherSignatureGuard', 'signed by someone else');
assert.equal(await guard({ ...good, signature: '0x' + '11'.repeat(65) }), 'VoucherSignatureGuard', 'garbage signature');
assert.equal(await guard({ ...good, signature: 'not a signature' }), 'VoucherSignatureGuard', 'malformed signature');
assert.equal(await guard({ ...good, cumulativeAmount: 'abc' }), 'VoucherSignatureGuard', 'non-numeric amount');

// Tampering after signing: the signature no longer matches what was signed, or the voucher no longer matches the call.
assert.equal(await guard({ ...good, cumulativeAmount: u('0.06').toString() }), 'VoucherBindingGuard', 'amount edited after signing');
assert.equal(await guard(await sign(TEST_AGENT, u('0.05'), P.domain, ethers.id('another-channel'))), 'VoucherBindingGuard', 'voucher for a different channel');
assert.equal(await guard(await sign(TEST_AGENT, u('0.07'))), 'VoucherBindingGuard', 'genuine voucher, but for a different amount than the call');

// A signature made for another ledger or chain is not valid here.
assert.equal(await guard(await sign(TEST_AGENT, u('0.05'), { ...P.domain, verifyingContract: ethers.getAddress('0x' + '00'.repeat(19) + '02') })), 'VoucherSignatureGuard', 'wrong ledger');
assert.equal(await guard(await sign(TEST_AGENT, u('0.05'), { ...P.domain, chainId: 1n })), 'VoucherSignatureGuard', 'wrong chain');

// Replay: cumulative vouchers must climb. Re-presenting what is already redeemed, or less, is refused.
const ledgerAt = { ...P, redeemed: u('0.2') };
assert.equal(await guard(await sign(TEST_AGENT, u('0.2')), {}, ledgerAt), 'VoucherReplayGuard', 'replay of the redeemed amount');
assert.equal(await guard(await sign(TEST_AGENT, u('0.1')), {}, ledgerAt), 'VoucherReplayGuard', 'replay of an older, smaller voucher');
assert.equal(await guard(await sign(TEST_AGENT, u('0.25')), {}, ledgerAt), null, 'the next voucher in the sequence is fine');

// The earlier guards still decide first, even when the voucher is genuine.
assert.equal(await guard(await sign(TEST_AGENT, u('2.5')), { amount: '2.5', maxPerCall: '5' }), 'PaymentLedgerASLGuard', 'over cap with a genuine voucher');
assert.equal(await guard(good, { payout: '0xBAD0000000000000000000000000000000000123' }), 'MerchantGateGuard', 'swapped payout with a genuine voucher');

// The suite's keys are throwaway: derived from public strings, and distinct from each other.
assert.notEqual(TEST_AGENT.address, TEST_ATTACKER.address);
console.log('voucher tests passed: genuine, forged, tampered, wrong ledger/chain, malformed, replay, ordering');
