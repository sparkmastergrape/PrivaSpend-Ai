import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { decide, DEFAULT_POLICY } from './policy.mjs';
import { withRetry } from './retry.mjs';

const PAYOUT = '0xff9395aa0918a789b4dc40e7cf147a73c92fcbf8', ASSET = '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3';
const trusted = { payout: PAYOUT, asset: ASSET };
const w = (v) => ethers.parseUnits(v, 18);
const req = (amount, over = {}) => ({ accepts: [{ amount: w(amount).toString(), payTo: PAYOUT, asset: ASSET, ...over }] });
const listing = { listedPrice: '0.02' };
const base = { listing, trusted, policy: DEFAULT_POLICY, spent: 0n, channelRemaining: w('0.5') };
const guard = (x) => decide({ ...base, ...x }).guard;

assert.equal(decide({ ...base, required: req('0.02') }).buy, true, 'fair price is bought');
assert.equal(guard({ required: req('0.40') }), 'PriceChangeGuard', 'price bump vs listing');
assert.equal(guard({ required: req('0.02', { payTo: '0xBAD0000000000000000000000000000000000123' }) }), 'PayeeGuard', 'payee swap');
assert.equal(guard({ required: req('0.02', { asset: '0x0000000000000000000000000000000000000001' }) }), 'AssetGuard', 'wrong asset');
assert.equal(guard({ listing: { listedPrice: '0.10' }, required: req('0.09') }), 'MaxPerCallGuard', 'over ceiling but within listing');
assert.equal(guard({ required: req('0.02'), spent: w('0.07') }), 'MissionBudgetGuard', 'mission budget');
assert.equal(guard({ required: req('0.02'), channelRemaining: w('0.01') }), 'ChannelCapGuard', 'channel cap');
assert.equal(guard({ required: { accepts: [] } }), 'ChallengeShapeGuard', 'no price');
assert.equal(guard({ required: { accepts: [req('0.02').accepts[0], req('0.02').accepts[0]] } }), 'ChallengeShapeGuard', 'two prices');
assert.equal(decide({ ...base, required: req('0.0250') }).buy, true, 'inside 25% tolerance');
assert.equal(guard({ required: req('0.0251') }), 'PriceChangeGuard', 'just outside tolerance');

let n = 0;
assert.equal(await withRetry(async () => { if (++n < 3) throw new SyntaxError('html'); return 'ok'; }, { sleep: async () => {}, log: () => {} }), 'ok');
console.log('all policy + retry tests passed');

// ── scenarios: reasoning runs against a fake market, with the real policy deciding ──────────────────
import { SCENARIOS } from './scenarios.mjs';
import { makeRng } from './rng.mjs';

function fakeCtx(built, policy) {
  let spent = 0n;
  const out = { purchases: [], refusals: [], logs: [] };
  const quote = (s) => {
    if (s.down) return null;
    const required = { accepts: [{ amount: w(s.price).toString(), payTo: PAYOUT, asset: ASSET }] };
    return { price: w(s.price), decision: decide({ required, listing: s, trusted, policy, spent, channelRemaining: w('10') }) };
  };
  const find = (id) => built.sellers.find((s) => s.id === id);
  const ctx = {
    log: (m) => out.logs.push(m), sellers: built.sellers,
    async peek(id) { return quote(find(id)); },
    async buy(id) {
      const q = quote(find(id));
      if (!q) { out.refusals.push({ id, guard: 'Unavailable' }); return null; }
      if (!q.decision.buy) { out.refusals.push({ id, guard: q.decision.guard }); return null; }
      spent += q.price; out.purchases.push(id);
      return find(id).content;
    },
  };
  return { ctx, out, spent: () => spent };
}

const runs = {};
const fingerprints = new Set();
for (const sc of SCENARIOS) {
  runs[sc.id] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const built = sc.build(makeRng(seed));
    for (const s of built.sellers) { w(s.price); w(s.listedPrice); } // every price must parse
    const f = fakeCtx(built, sc.policy);
    await built.run(f.ctx);
    assert.ok(f.spent() <= w(sc.policy.missionBudget), `${sc.id} seed ${seed} overspent the mission budget`);
    assert.ok(f.spent() <= w(sc.maxSpend), `${sc.id} seed ${seed} spent more than its declared maxSpend ${sc.maxSpend}`);
    runs[sc.id].push({ seed, built, ...f.out });
    fingerprints.add(sc.id + JSON.stringify(built.sellers.map((s) => [s.price, s.content])));
  }
}
const R = (id) => runs[id];
const outcomes = new Set(R('visibility-audit').map((r) => r.purchases.length));
assert.deepEqual([...outcomes].sort(), [1, 2], 'audit sometimes stops early and sometimes buys more');
for (const r of R('visibility-audit').filter((x) => x.purchases.length === 2)) assert.ok(r.refusals.some((x) => x.id === 'premium-deep-audit' && x.guard === 'PriceChangeGuard'));
for (const r of R('comparison-shopper')) {
  assert.equal(r.purchases.length, 1, 'shopper buys exactly one');
  const bought = r.built.sellers.find((s) => s.id === r.purchases[0]);
  assert.ok(bought.meta.ageDays <= 14 && bought.price === bought.listedPrice, 'shopper buys fresh and honestly priced');
}
for (const r of R('budget-squeeze')) { assert.equal(r.purchases.length, 2); assert.ok(r.refusals.some((x) => x.guard === 'MissionBudgetGuard')); }
for (const r of R('failover')) {
  assert.equal(r.purchases.length, 1);
  const bought = r.built.sellers.find((s) => s.id === r.purchases[0]);
  assert.ok(!bought.down && bought.price === bought.listedPrice, 'failover never buys from the seller that raised its price');
  assert.ok(r.refusals.some((x) => x.id === 'primary-alerts' && x.guard === 'Unavailable'));
}
for (const r of R('premium-too-expensive')) { assert.deepEqual(r.purchases, ['summary-report']); assert.ok(r.refusals.some((x) => x.guard === 'MaxPerCallGuard')); }
for (const r of R('live-weather')) {
  assert.equal(r.purchases.length, 1, 'live-weather buys exactly one reading');
  const bought = r.built.sellers.find((s) => s.id === r.purchases[0]);
  assert.equal(bought.price, bought.listedPrice, 'live-weather never buys from the feed that raised its price');
  assert.equal(typeof bought.live, 'function');
}
{
  const { crewCall, fetchWeather } = await import('./scenarios.mjs');
  assert.equal(crewCall({ gustTenthsMph: 249, precipChancePercent: 49, tempTenthsF: 201 }).hold, false);
  assert.deepEqual(crewCall({ gustTenthsMph: 250, precipChancePercent: 10, tempTenthsF: 500 }).why, ['gusts 25.0 mph (limit 25)']);
  assert.equal(crewCall({ gustTenthsMph: 50, precipChancePercent: 50, tempTenthsF: 500 }).hold, true);
  assert.equal(crewCall({ gustTenthsMph: 50, precipChancePercent: 5, tempTenthsF: 200 }).hold, true);
  // the live source failing, or answering with junk, must fail closed rather than yield a made-up reading
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(() => fetchWeather('Erie PA'), /HTTP 503/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ current: { temperature_2m: 50 }, daily: {} }) });
    await assert.rejects(() => fetchWeather('Erie PA'), /no usable/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ current: { time: 't', temperature_2m: 45.1, wind_speed_10m: 11.7, wind_gusts_10m: 20.8, precipitation: 0 }, daily: { precipitation_probability_max: [2] } }) });
    const ok = await fetchWeather('Erie PA');
    assert.deepEqual([ok.tempTenthsF, ok.gustTenthsMph, ok.precipChancePercent], [451, 208, 2]);
    for (const v of Object.values(ok)) assert.ok(typeof v !== 'number' || Number.isSafeInteger(v), 'content must be canonical-JSON safe');
    globalThis.fetch = async () => { throw new Error('network down'); };
    await assert.rejects(() => fetchWeather('Erie PA'), /network down/);
  } finally { globalThis.fetch = realFetch; }
}
// ── no seller can serve made-up data: every one fetches live, and its offline stand-in is flagged ────
for (const sc of SCENARIOS) for (let seed = 1; seed <= 50; seed++) {
  for (const s of sc.build(makeRng(seed)).sellers) {
    assert.equal(typeof s.live, 'function', `${sc.id}/${s.id} has no live source`);
    assert.equal(s.content.placeholder, true, `${sc.id}/${s.id} offline stand-in must be flagged so merchants.mjs refuses to serve it`);
  }
}
{
  const R = await import('./realdata.mjs');
  const robots = R.parseRobots('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /private/\n\nUser-agent: PerplexityBot\nDisallow: /a/\nAllow: /\n');
  assert.equal(R.crawlerAllowed(robots, 'GPTBot'), 0, 'stacked user-agent lines share one group');
  assert.equal(R.crawlerAllowed(robots, 'ClaudeBot'), 0);
  assert.equal(R.crawlerAllowed(robots, 'Google-Extended'), 1, 'falls back to * when no specific group');
  assert.equal(R.crawlerAllowed(robots, 'PerplexityBot'), 1, 'a path-only Disallow does not block the root');
  assert.equal(R.crawlerAllowed(R.parseRobots(''), 'GPTBot'), 1, 'no robots.txt blocks nothing');
  assert.equal(R.crawlerAllowed(R.parseRobots('User-agent: *\nDisallow: /\n'), 'ClaudeBot'), 0, '* blocks everyone without a specific group');
  const csv = ['observation_date,X', ...Array.from({ length: 30 }, (_, i) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01,${100 + i}`), '2026-07-01,.', '2026-08-01,140.5'].join('\n');
  const rows = R.parseFredCsv(csv);
  assert.equal(rows.at(-1).value, 140.5, 'missing "." values are skipped');
  const sum = R.summariseSeries('lumber', rows, new Date('2026-08-11').getTime());
  assert.equal(sum.latestMilli, 140500);
  assert.equal(sum.ageDays, 10);
  for (const v of Object.values(sum)) assert.ok(typeof v !== 'number' || Number.isSafeInteger(v), 'content must be canonical-JSON safe');
  assert.throws(() => R.parseFredCsv('observation_date,X\n2024-01-01,1'), /too few/);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => '', json: async () => ({}) });
    await assert.rejects(() => R.fetchFred('diesel'), /HTTP 503/);
    await assert.rejects(() => R.fetchNwsAlerts('Tulsa OK'), /HTTP 503/);
    await assert.rejects(() => R.fetchCrawlerAccess('example.com'), /HTTP 503/);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '<!doctype html><html>', json: async () => ({}) });
    await assert.rejects(() => R.fetchCrawlerAccess('example.com'), /HTML page/);
    await assert.rejects(() => R.fetchNwsAlerts('Tulsa OK'), /features/);
  } finally { globalThis.fetch = realFetch; }
}
assert.ok(fingerprints.size > 200, `scenario data should vary by seed (got ${fingerprints.size} distinct)`);
assert.equal(JSON.stringify(SCENARIOS[0].build(makeRng(7)).sellers), JSON.stringify(SCENARIOS[0].build(makeRng(7)).sellers), 'same seed replays identically');
console.log(`scenario tests passed: ${SCENARIOS.length} scenarios x 300 seeds, ${fingerprints.size} distinct builds`);
