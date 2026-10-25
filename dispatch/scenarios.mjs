// Each scenario builds its own sellers, mandate and reasoning from a seeded RNG, so no two runs match
// unless you replay the seed. `run(ctx)` is the agent's reasoning: it may peek at prices for free, then
// buy. Every payment still goes through the same policy, which the scenario cannot override.
//
// Seller fields: id, price (what the 402 asks), listedPrice (what the directory advertised),
// description, content, live, metaFrom, down (not started: unreachable), meta (advertised facts).
//
// Every seller sells REAL data. `live()` runs when the seller starts (merchants.mjs); if the source is
// unreachable the seller goes offline and nothing is substituted. The `placeholder` content exists only so the
// offline tests can run the reasoning; merchants.mjs refuses to serve it. `metaFrom(content)` turns the
// real data into the facts the directory advertises (for example how old it is).
import { AREAS, CRAWLERS, fetchFred, fetchCrawlerAccess, fetchDeepAudit, fetchPeerBenchmark, fetchNwsAlerts } from './realdata.mjs';

const money = (cents) => (cents / 100).toFixed(2);
const CRAWLER_KEYS = Object.keys(CRAWLERS);
const pct = (bp) => (bp / 100).toFixed(1);
const dollars = (milli) => (milli / 1000).toFixed(3);

// ── 1. AI-crawler access audit: buy the snapshot; only if it shows a blocked crawler, buy more ───────
const TARGETS = ['www.seedvaluemarketing.com', 'www.nytimes.com', 'www.cnn.com', 'www.theguardian.com', 'www.bbc.com'];
const PEERS = ['moz.com', 'ahrefs.com', 'www.semrush.com', 'www.searchenginejournal.com', 'www.wikipedia.org'];

const visibilityAudit = {
  id: 'visibility-audit',
  title: 'AI-crawler audit (buys more only if the first purchase shows a blocked crawler)',
  task: 'report which AI crawlers a site lets in; if any are blocked, size the gap against a peer set',
  policy: { perCallCeiling: '0.05', missionBudget: '0.08', priceTolerancePct: 25 },
  maxSpend: '0.05', maxQuote: '0.05',
  build(rng) {
    const domain = rng.pick(TARGETS);
    const weak = rng.int(0, 1) === 1;
    const snapPh = { placeholder: true, domain, robotsStatus: 200, llmsTxt: rng.int(0, 1) };
    CRAWLER_KEYS.forEach((k, i) => { snapPh[`${k}Allowed`] = weak && (i === 0 || rng.int(0, 1)) ? 0 : 1; });
    const benchPh = { placeholder: true, peerCount: PEERS.length, llmsTxtPeers: rng.int(0, 3) };
    for (const k of CRAWLER_KEYS) benchPh[`${k}PeersAllowing`] = rng.int(3, PEERS.length);
    return {
      sellers: [
        { id: 'crawler-snapshot', price: '0.02', listedPrice: '0.02', description: 'AI crawler access snapshot (robots.txt, llms.txt)', content: snapPh, live: () => fetchCrawlerAccess(domain) },
        { id: 'peer-benchmark', price: '0.03', listedPrice: '0.03', description: 'Peer-set crawler access benchmark', content: benchPh, live: () => fetchPeerBenchmark(PEERS) },
        { id: 'premium-deep-audit', price: '0.04', listedPrice: '0.02', description: 'Premium deep audit with structured data (price rose after listing)', content: { placeholder: true, domain }, live: () => fetchDeepAudit(domain) },
      ],
      async run(ctx) {
        const snap = await ctx.buy('crawler-snapshot', 'need a measured snapshot of which AI crawlers the site lets in');
        if (!snap) return ctx.log('\nno snapshot, no report.');
        const blocked = CRAWLER_KEYS.filter((k) => snap[`${k}Allowed`] === 0);
        let bench = null;
        if (blocked.length) {
          ctx.log(`\n[reason] blocked: ${blocked.map((k) => CRAWLERS[k]).join(', ')} -> buying a peer benchmark to see whether that is unusual`);
          bench = await ctx.buy('peer-benchmark', 'size the gap on the blocked crawlers');
          ctx.log('\n[reason] a deep audit would show structured data and sitemap gaps -> checking the premium deep audit');
          await ctx.buy('premium-deep-audit', 'optional: structured-data and sitemap audit');
        } else {
          ctx.log('\n[reason] no AI crawler is blocked -> no benchmark or deep audit needed; stopping early to save budget');
        }
        ctx.log('\n--- REPORT ---');
        ctx.log(`site: ${snap.domain}  (live robots.txt read ${snap.fetchedAt ?? 'in the offline test'})`);
        for (const k of CRAWLER_KEYS) {
          const peers = bench?.[`${k}PeersAllowing`];
          ctx.log(`  ${CRAWLERS[k].padEnd(16)} ${snap[`${k}Allowed`] ? 'allowed' : 'BLOCKED'}${peers !== undefined ? `   ${peers} of ${bench.peerCount} peers allow it` : ''}`);
        }
        ctx.log(`  llms.txt         ${snap.llmsTxt ? 'present' : 'missing'}`);
        if (bench) {
          const behind = blocked.filter((k) => bench[`${k}PeersAllowing`] > bench.peerCount / 2);
          ctx.log(behind.length
            ? `conclusion: ${behind.map((k) => CRAWLERS[k]).join(', ')} blocked while most peers allow it. Revisit robots.txt first.`
            : 'conclusion: the blocks match what most peers do; treat them as a policy choice, not a gap.');
        } else {
          ctx.log('conclusion: no crawler blocked; spent the minimum and stopped.');
        }
      },
    };
  },
};

// ── 2. comparison shopper: three vendors, one purchase ───────────────────────────────────────────────
// Every vendor resells a real public price series. Freshness is the real age of the latest observation.
const comparisonShopper = {
  id: 'comparison-shopper',
  title: 'Comparison shopper (peeks at every price for free, buys the best acceptable one)',
  task: 'get a current price reading for a cost input and pay as little as is sensible for fresh data',
  policy: { perCallCeiling: '0.05', missionBudget: '0.05', priceTolerancePct: 25 },
  maxSpend: '0.04', maxQuote: '0.06',
  build(rng) {
    const staleKey = rng.pick(['copper', 'lumber', 'steel']);
    const kinds = rng.shuffle(['cheap-stale', 'fair-fresh', 'bumped']);
    const fairCents = rng.int(2, 3);
    const sellers = kinds.map((kind, i) => {
      const id = `quote-vendor-${'abc'[i]}`;
      const key = kind === 'cheap-stale' ? staleKey : 'diesel';
      const ageDays = kind === 'cheap-stale' ? rng.int(30, 70) : rng.int(1, 9);
      const common = { id, content: { placeholder: true, ageDays, latestMilli: rng.int(1000, 9000) }, meta: { ageDays }, metaFrom: (c) => ({ ageDays: c.ageDays }), live: () => fetchFred(key) };
      if (kind === 'cheap-stale') return { ...common, price: '0.01', listedPrice: '0.01', description: 'cheapest, but its series is published monthly' };
      if (kind === 'fair-fresh') return { ...common, price: money(fairCents), listedPrice: money(fairCents), description: 'weekly series, honestly priced' };
      return { ...common, price: '0.04', listedPrice: '0.03', description: 'weekly series, but asks more than it listed' };
    });
    return {
      sellers,
      async run(ctx) {
        ctx.log('\n[reason] goal: a current price reading for a cost input. A reading more than 14 days old is not useful. Comparing all vendors before paying anyone.');
        const options = [];
        for (const s of ctx.sellers) {
          const q = await ctx.peek(s.id);
          if (!q) continue;
          const fresh = s.meta.ageDays <= 14;
          ctx.log(`    ${s.id}: ${q.decision.buy ? 'acceptable' : `refused [${q.decision.guard}]`}, ${fresh ? 'fresh' : `stale (${s.meta.ageDays} days)`}`);
          if (q.decision.buy && fresh) options.push({ s, price: q.price });
        }
        if (!options.length) return ctx.log('\nno acceptable fresh vendor; buying nothing.');
        options.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
        ctx.log(`\n[reason] cheapest acceptable fresh vendor is ${options[0].s.id}`);
        const data = await ctx.buy(options[0].s.id, 'cheapest acceptable fresh reading');
        ctx.log('\n--- REPORT ---');
        if (data) {
          ctx.log(`${data.label}: ${dollars(data.latestMilli)} ${data.units}, observed ${data.latestDate} (${data.ageDays} days old), from ${options[0].s.id}.`);
          ctx.log(`LIVE data from ${data.source}; check it yourself: ${data.sourceUrl}`);
          ctx.log('Bought one reading, declined the other two.');
        }
      },
    };
  },
};

// ── 3. budget squeeze: wants three things, can afford two ────────────────────────────────────────────
const budgetSqueeze = {
  id: 'budget-squeeze',
  title: 'Budget squeeze (wants three datasets, mission budget covers two)',
  task: 'assemble a crew-cost brief from weather, fuel and materials data with a hard 0.05 RLUSD mission budget',
  policy: { perCallCeiling: '0.05', missionBudget: '0.05', priceTolerancePct: 25 },
  maxSpend: '0.04', maxQuote: '0.02',
  build(rng) {
    const area = rng.pick(Object.keys(AREAS));
    const materialsKey = rng.pick(['lumber', 'steel']);
    const first = rng.pick(['weather', 'fuel', 'materials']);
    const content = {
      weather: { placeholder: true, area, tempTenthsF: rng.int(150, 800), windTenthsMph: 80, gustTenthsMph: rng.int(50, 400), precipTenthsMm: 0, precipChancePercent: rng.int(0, 90) },
      fuel: { placeholder: true, yoyBp: rng.int(-500, 1500) },
      materials: { placeholder: true, yoyBp: rng.int(-500, 1500) },
    };
    const live = { weather: () => fetchWeather(area), fuel: () => fetchFred('diesel'), materials: () => fetchFred(materialsKey) };
    return {
      sellers: ['weather', 'fuel', 'materials'].map((k) => ({ id: `${k}-data`, price: '0.02', listedPrice: '0.02', description: `${k} dataset`, content: content[k], live: live[k] })),
      first,
      async run(ctx) {
        // The agent reads stress off the real figures: a crew hold, or a price up 5% or more on the year.
        const stressed = (kind, d) => (kind === 'weather' ? crewCall(d).hold : d.yoyBp >= 500);
        const lead = await ctx.buy(`${first}-data`, 'the lead dataset; what it shows decides what else matters');
        if (!lead) return ctx.log('\nno lead dataset, no brief.');
        const stress = stressed(first, lead);
        const next = first === 'weather' ? (stress ? 'fuel' : 'materials')
          : stress ? 'weather'
            : first === 'fuel' ? 'materials' : 'fuel';
        const leftover = ['weather', 'fuel', 'materials'].find((k) => k !== first && k !== next);
        ctx.log(`\n[reason] the ${first} data ${stress ? 'shows stress' : 'looks calm'}, so ${next} matters most next. Buying that, then trying ${leftover} as a nice-to-have.`);
        const second = await ctx.buy(`${next}-data`, 'chosen from what the lead dataset showed');
        await ctx.buy(`${leftover}-data`, 'nice-to-have, only if the budget allows');
        const got = { [first]: lead, ...(second ? { [next]: second } : {}) };
        ctx.log('\n--- REPORT ---');
        if (got.weather) ctx.log(`weather ${got.weather.area}: crew ${crewCall(got.weather).hold ? 'HOLD' : 'GO'} (gusts ${tenths(got.weather.gustTenthsMph)} mph, rain chance ${got.weather.precipChancePercent}%)`);
        if (got.fuel) ctx.log(`fuel: diesel ${dollars(got.fuel.latestMilli)} ${got.fuel.units ?? 'USD per gallon'}, ${pct(got.fuel.yoyBp)}% on the year`);
        if (got.materials) ctx.log(`materials: ${got.materials.label ?? 'price index'} ${pct(got.materials.yoyBp)}% on the year`);
        ctx.log(`brief built from ${Object.keys(got).join(' + ')}; ${leftover} left out because the mission budget was spent.`);
      },
    };
  },
};

// ── 4. failover: the preferred seller is down ────────────────────────────────────────────────────────
const failover = {
  id: 'failover',
  title: 'Failover (the preferred seller is offline; one backup lies about its price)',
  task: 'get the active National Weather Service alerts for a service area, preferring the primary source',
  policy: { perCallCeiling: '0.05', missionBudget: '0.05', priceTolerancePct: 25 },
  maxSpend: '0.03', maxQuote: '0.05',
  build(rng) {
    const area = rng.pick(Object.keys(AREAS));
    const liar = rng.int(0, 1);
    const ph = () => ({ placeholder: true, area, activeAlerts: rng.int(0, 4), severeAlerts: 0, events: 'none' });
    const sellers = [
      { id: 'primary-alerts', price: '0.02', listedPrice: '0.02', down: true, description: 'preferred source (offline)', content: ph(), live: () => fetchNwsAlerts(area) },
      { id: 'backup-alerts-1', price: liar === 0 ? '0.05' : '0.03', listedPrice: '0.03', description: liar === 0 ? 'backup that raised its price' : 'honest backup', content: ph(), live: () => fetchNwsAlerts(area) },
      { id: 'backup-alerts-2', price: liar === 1 ? '0.05' : '0.03', listedPrice: '0.03', description: liar === 1 ? 'backup that raised its price' : 'honest backup', content: ph(), live: () => fetchNwsAlerts(area) },
    ];
    return {
      sellers,
      async run(ctx) {
        ctx.log(`\n[reason] preferred source first: primary-alerts for ${area}`);
        let data = await ctx.buy('primary-alerts', 'preferred source');
        let from = 'primary-alerts';
        if (!data) {
          ctx.log('\n[reason] primary did not deliver. Checking the backups and taking the first acceptable one.');
          for (const id of ['backup-alerts-1', 'backup-alerts-2']) {
            data = await ctx.buy(id, 'backup source');
            if (data) { from = id; break; }
          }
        }
        ctx.log('\n--- REPORT ---');
        if (data) {
          ctx.log(`${data.area}: ${data.activeAlerts} active alert(s), ${data.severeAlerts} severe or extreme (${data.events}), from ${from}. The task still got done with the primary down.`);
          ctx.log(`LIVE data from ${data.source ?? 'the National Weather Service'}; check it yourself: ${data.sourceUrl ?? 'api.weather.gov'}`);
        } else ctx.log('no source would sell at an acceptable price; nothing bought.');
      },
    };
  },
};

// ── 5. honest but too expensive ──────────────────────────────────────────────────────────────────────
const tooExpensive = {
  id: 'premium-too-expensive',
  title: 'Premium vs summary (the premium report is honestly priced, but outside the mandate)',
  task: 'get the best price report the mandate allows',
  policy: { perCallCeiling: '0.05', missionBudget: '0.08', priceTolerancePct: 25 },
  maxSpend: '0.03', maxQuote: '0.09',
  build(rng) {
    const key = rng.pick(['diesel', 'copper', 'lumber', 'steel']);
    const summaryCents = rng.int(2, 3);
    const summaryOf = (d) => ({ depth: 'summary', series: d.series, label: d.label, units: d.units, latestDate: d.latestDate, latestMilli: d.latestMilli, yoyBp: d.yoyBp, ageDays: d.ageDays, fetchedAt: d.fetchedAt, source: d.source, sourceUrl: d.sourceUrl });
    return {
      sellers: [
        { id: 'premium-report', price: '0.09', listedPrice: '0.09', description: 'full report with the last 24 observations, honestly priced', content: { placeholder: true, depth: 'full', label: key, units: 'units', latestMilli: 1000, yoyBp: 0 }, live: async () => ({ depth: 'full', ...(await fetchFred(key)) }) },
        { id: 'summary-report', price: money(summaryCents), listedPrice: money(summaryCents), description: 'latest reading and year-on-year change', content: { placeholder: true, depth: 'summary', label: key, units: 'units', latestMilli: 1000, yoyBp: 0 }, live: async () => summaryOf(await fetchFred(key)) },
      ],
      async run(ctx) {
        ctx.log(`\n[reason] would prefer the full ${key} report. Trying it first.`);
        const full = await ctx.buy('premium-report', 'best available');
        const got = full ?? await (async () => {
          ctx.log('\n[reason] the premium report is outside the mandate even though the seller is honest. Falling back to the summary.');
          return ctx.buy('summary-report', 'within mandate');
        })();
        ctx.log('\n--- REPORT ---');
        if (got) {
          ctx.log(`${got.label}: ${dollars(got.latestMilli)} ${got.units}, ${pct(got.yoyBp)}% on the year (${got.depth} report). The agent stayed inside its mandate.`);
          ctx.log(`LIVE data from ${got.source ?? 'FRED'}; check it yourself: ${got.sourceUrl ?? 'fred.stlouisfed.org'}`);
        }
      },
    };
  },
};

// ── 6. live weather: the data is real, fetched when the seller starts ────────────────────────────────
const weatherUrl = ([lat, lon]) => 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation`
  + '&daily=precipitation_probability_max&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';

export async function fetchWeather(area) {
  const sourceUrl = weatherUrl(AREAS[area]);
  const r = await fetch(sourceUrl, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Open-Meteo answered HTTP ${r.status}`);
  const j = await r.json();
  const c = j.current, chance = j.daily?.precipitation_probability_max?.[0];
  // The AP4M canonical JSON only allows safe integers, so readings are carried in tenths (451 = 45.1).
  const tenths = (v) => (Number.isFinite(v) ? Math.round(v * 10) : v);
  const reading = { tempTenthsF: tenths(c?.temperature_2m), windTenthsMph: tenths(c?.wind_speed_10m), gustTenthsMph: tenths(c?.wind_gusts_10m), precipTenthsMm: tenths(c?.precipitation), precipChancePercent: chance };
  for (const [k, v] of Object.entries(reading)) if (!Number.isInteger(v)) throw new Error(`Open-Meteo reading has no usable ${k}`);
  return { area, ...reading, observedAt: c.time, fetchedAt: new Date().toISOString(), source: 'Open-Meteo (open-meteo.com)', sourceUrl };
}

// A crew should hold on strong gusts, a likely storm, or hard cold.
export const tenths = (n) => (n / 10).toFixed(1);
export function crewCall(w) {
  const why = [];
  if (w.gustTenthsMph >= 250) why.push(`gusts ${tenths(w.gustTenthsMph)} mph (limit 25)`);
  if (w.precipChancePercent >= 50) why.push(`${w.precipChancePercent}% chance of rain (limit 50)`);
  if (w.tempTenthsF <= 200) why.push(`${tenths(w.tempTenthsF)}°F (limit 20)`);
  return { hold: why.length > 0, why };
}

const liveWeather = {
  id: 'live-weather',
  title: 'Live weather (pays for a current reading, then decides whether a crew should work)',
  task: 'decide whether an outdoor crew should work in a service area today, from a current weather reading',
  policy: { perCallCeiling: '0.05', missionBudget: '0.05', priceTolerancePct: 25 },
  maxSpend: '0.03', maxQuote: '0.04',
  build(rng) {
    const area = rng.pick(Object.keys(AREAS));
    const liar = rng.int(0, 1);
    const honest = rng.pick(['0.02', '0.03']);
    const placeholder = { placeholder: true, area, tempTenthsF: 500, windTenthsMph: 80, gustTenthsMph: 150, precipTenthsMm: 0, precipChancePercent: 10 };
    const sellers = ['a', 'b'].map((k, i) => ({
      id: `weather-feed-${k}`,
      price: i === liar ? '0.04' : honest,
      listedPrice: i === liar ? '0.02' : honest,
      description: i === liar ? 'live weather feed that raised its price after listing' : 'live weather feed',
      content: placeholder,
      live: () => fetchWeather(area),
    }));
    return {
      sellers,
      async run(ctx) {
        ctx.log(`\n[reason] goal: should a crew work in ${area} today? That needs a current reading, which only a feed can give. Trying feed A first.`);
        let data = null, from = null;
        for (const s of ctx.sellers) {
          data = await ctx.buy(s.id, 'current weather reading for the crew decision');
          if (data) { from = s.id; break; }
          ctx.log('\n[reason] that feed was not acceptable. Trying the next one.');
        }
        ctx.log('\n--- REPORT ---');
        if (!data) return ctx.log('no feed would sell at an acceptable price; no reading, so no crew call.');
        const call = crewCall(data);
        ctx.log(`${data.area}: ${tenths(data.tempTenthsF)}°F, wind ${tenths(data.windTenthsMph)} mph (gusts ${tenths(data.gustTenthsMph)}), rain chance ${data.precipChancePercent}%`);
        ctx.log(`LIVE data from ${data.source}, observed ${data.observedAt}, fetched ${data.fetchedAt}, bought from ${from}`);
        ctx.log(`check it yourself: ${data.sourceUrl}`);
        ctx.log(call.hold ? `crew call: HOLD (${call.why.join('; ')})` : 'crew call: GO (gusts under 25 mph, rain chance under 50%, above 20°F)');
      },
    };
  },
};

export const SCENARIOS = [visibilityAudit, comparisonShopper, budgetSqueeze, failover, tooExpensive, liveWeather];
export const byId = (id) => SCENARIOS.find((s) => s.id === id);
