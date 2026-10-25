// Opens one AP4M payment channel from the Agent wallet to the team Merchant (testnet). Usage: node open-channel.mjs [capRlusd]
// Sends one vault transaction from the Agent wallet (needs gas). Prints the channel id; the key is never logged.
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { loadEnv } from './env.mjs';

const sdk = createRequire(import.meta.url)('./ap4m-hackathon-sdk.cjs');
loadEnv();
const cap = process.argv[2] ?? '1';
if (!/^\d+(\.\d{1,6})?$/.test(cap) || Number(cap) <= 0 || Number(cap) > 5) throw new Error('capRlusd must be a number between 0 and 5');

const API = process.env.AP4M_API_URL;
const cfg = await (await fetch(`${API}/public/config`)).json();
const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, 1449000, { staticNetwork: true });
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const gas = await provider.getBalance(wallet.address);
console.log(`agent ${wallet.address}  gas ${ethers.formatEther(gas)} XRP  vault ${cfg.vaultBalance} RLUSD`);
if (gas === 0n) throw new Error(`agent has no gas; fund it at ${cfg.network.faucetUrl}`);

const session = await sdk.signIn(API, process.env.TEAM_NAME, wallet);
const ch = await sdk.requestChannel(API, session.token, wallet, { capRlusd: cap });
console.log(`channel ${ch.channel_id}  status ${ch.channel_status}  cap ${ethers.formatUnits(ch.cap_wei, 18)} RLUSD  payout ${ch.payout}`);
