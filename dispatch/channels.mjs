// Read-only: lists your team's channels and how many more the funding reservation can bind. Sends no transaction,
// opens nothing, signs only the service's sign-in challenge (the key never leaves this machine and is never printed).
//
//   node channels.mjs                          sign in, list channels, then read each channel's reservation
//   node channels.mjs --reservation 0x...      also read this reservation (works with no key: public chain data only)
//
// With no AGENT_PRIVATE_KEY available it skips the sign-in and reads only the on-chain parts.
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { loadEnv } from './env.mjs';

const sdk = createRequire(import.meta.url)('./ap4m-hackathon-sdk.cjs');
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const fmt = (v) => ethers.formatUnits(v, 18);
const MIN_NEEDED = ethers.parseUnits('0.05', 18);

const VAULT_ABI = [
  'function vaultLimits() view returns ((uint32 maximumActiveReservationsPerAccount,uint32 maximumPayoutBindingsPerReservation,uint32 maximumActivePayoutsPerReservation,uint64 maximumAccountLifetimeSeconds,uint64 maximumReservationLifetimeSeconds,uint64 maximumBindingAdmissionLifetimeSeconds,uint256 minimumTransferAmount,uint256 maximumFundingRoundAmount,uint256 maximumAccountLiability,uint256 maximumPayoutCap,uint256 maximumAccountedLiability,uint32 maximumBindingRequestsPerReservation,uint64 maximumBindingRequestLifetimeSeconds))',
  'function reservation(bytes32) view returns ((bytes32 accountId,bytes32 allocationId,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 depositOperationId,uint256 amount,uint256 unassigned,uint256 activePayoutCapacity,uint256 disbursed,uint256 released,uint32 payoutBindingCount,uint32 activePayouts,uint64 validAfter,uint64 allocationValidBefore,uint64 bindingValidBefore,uint8 status))',
  'function payoutBindingRequestCount(bytes32) view returns (uint32)',
  'function payoutIdByChannel(bytes32) view returns (bytes32)',
  'function payoutBinding(bytes32) view returns ((bytes32 reservationId,bytes32 channelId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint256 available,uint256 disbursed,uint256 returned,uint256 executionCount,uint64 boundAt,uint8 status))',
];

let haveKey = true;
try { loadEnv(); } catch { haveKey = false; }
const API = process.env.AP4M_API_URL ?? 'https://hackathon.ap4m.build';
const cfg = await (await fetch(`${API}/public/config`, { signal: AbortSignal.timeout(30_000) })).json();
const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, Number(cfg.network.chainId), { staticNetwork: true }); // the URL can carry a token: never printed
const vault = new ethers.Contract(cfg.contracts.pooledEscrowVault, VAULT_ABI, provider);
const limits = await vault.vaultLimits();
const reservations = new Set(arg('reservation') ? [arg('reservation').toLowerCase()] : []);
let usable = 0;

if (haveKey) {
  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  console.log(`agent ${wallet.address}   gas ${ethers.formatEther(await provider.getBalance(wallet.address))} XRP   vault pool ${cfg.vaultBalance} RLUSD`);
  const session = await sdk.signIn(API, process.env.TEAM_NAME, wallet);
  const channels = await sdk.listChannels(API, session.token);
  console.log(`\nCHANNELS (${channels.length}) as the service lists them`);
  for (const c of channels) {
    let line = `  ${c.channel_id.slice(0, 18)}…  status ${String(c.channel_status).padEnd(9)} cap ${fmt(c.cap_wei)}`;
    try {
      const st = await sdk.getChannelState(provider, cfg.contracts.paymentLedger, c.channel_id);
      const left = st.cap - st.redeemed;
      line += `  redeemed ${fmt(st.redeemed)}  left ${fmt(left)}`;
      if (c.channel_status === 'open' && left >= MIN_NEEDED) usable++;
      const payoutId = await vault.payoutIdByChannel(c.channel_id);
      if (payoutId !== ethers.ZeroHash) reservations.add((await vault.payoutBinding(payoutId)).reservationId.toLowerCase());
    } catch (e) { line += `  (chain read failed: ${String(e.message ?? e).slice(0, 60)})`; }
    if (c.failure) line += `  failure: ${c.failure}`;
    console.log(line);
  }
  if (!channels.length) console.log('  none');
  console.log(`\n${usable ? `${usable} open channel(s) with at least 0.05 RLUSD left: demo.mjs can run.` : 'No open channel with at least 0.05 RLUSD left: demo.mjs will stop with "no open channel".'}`);
} else if (!reservations.size) {
  console.log('No AGENT_PRIVATE_KEY found and no --reservation given: nothing to read. Set ENV_FILE, or pass --reservation 0x...');
}

console.log(`\nVAULT LIMITS per reservation: ${limits.maximumBindingRequestsPerReservation} channel requests, ${limits.maximumPayoutBindingsPerReservation} bound payouts, ${limits.maximumActivePayoutsPerReservation} active at once, cap per channel up to ${fmt(limits.maximumPayoutCap)} RLUSD`);
for (const id of reservations) {
  const r = await vault.reservation(id);
  const requests = await vault.payoutBindingRequestCount(id);
  const open = (n, max) => `${n}/${max}${n >= max ? '  <- FULL' : ''}`;
  console.log(`\nRESERVATION ${id.slice(0, 18)}…`);
  console.log(`  channel requests used   ${open(requests, limits.maximumBindingRequestsPerReservation)}`);
  console.log(`  payouts bound           ${open(r.payoutBindingCount, limits.maximumPayoutBindingsPerReservation)}   (${r.activePayouts} active now, up to ${limits.maximumActivePayoutsPerReservation})`);
  console.log(`  RLUSD                   deposited ${fmt(r.amount)}, unassigned ${fmt(r.unassigned)}, in active payouts ${fmt(r.activePayoutCapacity)}, disbursed ${fmt(r.disbursed)}, released ${fmt(r.released)}`);
  console.log(`  binding window closes   ${new Date(Number(r.bindingValidBefore) * 1000).toISOString()}${Date.now() > Number(r.bindingValidBefore) * 1000 ? '  <- CLOSED' : ''}`);
  const canOpen = requests < limits.maximumBindingRequestsPerReservation && r.payoutBindingCount < limits.maximumPayoutBindingsPerReservation && r.unassigned > 0n && Date.now() < Number(r.bindingValidBefore) * 1000;
  console.log(`  can open another channel: ${canOpen ? 'yes' : 'NO. This reservation cannot bind another channel; a new reservation (a new deposit, done in the portal or by the organizers) is needed.'}`);
}
process.exit(0);
