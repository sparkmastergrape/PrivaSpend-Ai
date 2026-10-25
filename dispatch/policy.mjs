import { ethers } from 'ethers';

const u = (v) => ethers.parseUnits(String(v), 18);
const fmt = (v) => ethers.formatUnits(v, 18);

export const DEFAULT_POLICY = {
  perCallCeiling: '0.05',   // most the agent will pay for any single resource
  missionBudget: '0.08',    // most it will spend on this whole task
  priceTolerancePct: 25,    // a merchant may ask up to listed price + 25%, no more
};

/**
 * Decide whether to pay a decoded x402 challenge. Pure function: price, payee, asset and
 * remaining budget are compared as integers. Nothing the merchant writes in prose is read.
 * Returns { buy, guard, reason }.
 */
export function decide({ required, listing, trusted, policy = DEFAULT_POLICY, spent = 0n, channelRemaining }) {
  const no = (guard, reason) => ({ buy: false, guard, reason });
  if (!required || required.accepts?.length !== 1) return no('ChallengeShapeGuard', `expected exactly one price, got ${required?.accepts?.length ?? 0}`);
  const a = required.accepts[0];
  const price = BigInt(a.amount);

  if (String(a.payTo).toLowerCase() !== trusted.payout.toLowerCase()) {
    return no('PayeeGuard', `payee ${a.payTo} is not the registered merchant payout ${trusted.payout}`);
  }
  if (String(a.asset).toLowerCase() !== trusted.asset.toLowerCase()) {
    return no('AssetGuard', `asked to pay in ${a.asset}, not RLUSD ${trusted.asset}`);
  }
  const listed = u(listing.listedPrice);
  const maxAccepted = (listed * BigInt(100 + policy.priceTolerancePct)) / 100n;
  if (price > maxAccepted) {
    return no('PriceChangeGuard', `asks ${fmt(price)} RLUSD but was listed at ${fmt(listed)} (tolerance ${policy.priceTolerancePct}%)`);
  }
  if (price > u(policy.perCallCeiling)) {
    return no('MaxPerCallGuard', `asks ${fmt(price)} RLUSD, per-call ceiling is ${policy.perCallCeiling}`);
  }
  if (spent + price > u(policy.missionBudget)) {
    return no('MissionBudgetGuard', `${fmt(spent)} spent + ${fmt(price)} exceeds mission budget ${policy.missionBudget}`);
  }
  if (price > channelRemaining) {
    return no('ChannelCapGuard', `asks ${fmt(price)} RLUSD but only ${fmt(channelRemaining)} remains under the channel cap`);
  }
  return { buy: true, guard: null, reason: `${fmt(price)} RLUSD is within listing, ceiling, mission budget and channel cap`, price };
}
