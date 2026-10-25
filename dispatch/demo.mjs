import * as fs from 'node:fs';
import { loadEnv } from './env.mjs';
import { startMerchants } from './merchants.mjs';
import { runAgent, PreflightError } from './agent.mjs';
import { SCENARIOS, byId } from './scenarios.mjs';
import { makeRng, newSeed } from './rng.mjs';
import { startLiveFeed } from './live.mjs';

// node demo.mjs                       random scenario, random seed (the seed is printed so you can replay it)
// node demo.mjs --scenario failover   pick one
// node demo.mjs --seed 12345          replay exactly
// node demo.mjs --list                show the scenarios
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.argv.includes('--list')) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(24)} up to ${s.maxSpend} RLUSD   ${s.title}`);
  process.exit(0);
}

const seed = arg('seed') !== undefined ? Number(arg('seed')) >>> 0 : newSeed();
const rng = makeRng(seed);
const chosen = arg('scenario') && arg('scenario') !== 'random' ? byId(arg('scenario')) : rng.pick(SCENARIOS);
if (!chosen) { console.error(`unknown scenario "${arg('scenario')}". Try --list`); process.exit(2); }

loadEnv();
const runId = `r${Date.now().toString(36)}`;
const stateDir = `./.state/${runId}`;
fs.mkdirSync(stateDir, { recursive: true });
const built = chosen.build(makeRng(seed ^ 0x9e3779b9));

const feed = startLiveFeed({ runId, scenario: chosen.id, title: chosen.title, seed });
const log = feed.log;
log('DISPATCH: an agent that reads x402 paywalls, decides, pays in RLUSD, and proves it on-chain');
log(`${chosen.title}\n`);
const { provider, close } = await startMerchants(built.sellers, stateDir, (m) => log(' ', m));
let code = 0;
try {
  const ev = await runAgent({ scenario: chosen, built, seed, provider, runId, stateDir, log });
  fs.writeFileSync(`./evidence-${runId}.json`, JSON.stringify(ev, null, 2));
  log(`evidence saved to evidence-${runId}.json`);
  feed.finish('done', { purchases: ev.purchases.length, refusals: ev.refusals.length, spent: ev.spent, elapsedSeconds: ev.elapsedSeconds });
} catch (e) {
  if (e instanceof PreflightError) { console.error(`\nNOT STARTED: ${e.message}`); feed.note(`NOT STARTED: ${e.message}`); feed.finish('not-started'); code = 4; }
  else { feed.note(`FAILED: ${String(e.message ?? e).slice(0, 200)}`); feed.finish('failed'); throw e; }
} finally {
  await close();
}
process.exit(code);
