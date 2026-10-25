// Real, keyless public data sources for the sellers. Every function here fetches live and throws on any failure
// (network, HTTP status, unparseable body), so a seller whose source is down goes OFFLINE; nothing is substituted.
// The AP4M canonical JSON only allows safe integers, so numbers are carried scaled (milli-units, basis points, 0/1 flags).

const UA = 'dispatch-hackathon/1.0 (public-data demo)';
const get = async (url, { accept } = {}) => {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(15_000) });
  return r;
};
const ok = async (url, opts) => {
  const r = await get(url, opts);
  if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`);
  return r;
};

// ── service areas (shared by the weather and alert sellers) ──────────────────────────────────────────
export const AREAS = {
  'Ashtabula OH': [41.865, -80.79],
  'Erie PA': [42.129, -80.085],
  'Tulsa OK': [36.154, -95.993],
  'Oklahoma City OK': [35.468, -97.516],
};

// ── FRED price series (public CSV, no key) ───────────────────────────────────────────────────────────
export const FRED = {
  diesel: { id: 'GASDESW', label: 'US diesel retail price', units: 'USD per gallon', cadence: 'weekly' },
  copper: { id: 'PCOPPUSDM', label: 'Global price of copper', units: 'USD per metric ton', cadence: 'monthly' },
  lumber: { id: 'WPU081', label: 'Producer price index: lumber and wood products', units: 'index', cadence: 'monthly' },
  steel: { id: 'WPU101', label: 'Producer price index: iron and steel', units: 'index', cadence: 'monthly' },
};
const milli = (v) => Math.round(v * 1000);
const DAY = 86_400_000;

/** Parse FRED's `observation_date,VALUE` CSV into [{date, value}], skipping missing ('.') values. Throws if nothing usable. */
export function parseFredCsv(text) {
  const rows = [];
  for (const line of String(text).trim().split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(',');
    const value = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && raw !== '.' && raw !== '' && Number.isFinite(value)) rows.push({ date, value });
  }
  if (rows.length < 14) throw new Error('FRED CSV had too few usable observations');
  return rows;
}

/** Latest observation, the observation about a year earlier, and the last-24 range, all as safe integers. */
export function summariseSeries(key, rows, now = Date.now()) {
  const s = FRED[key];
  const last = rows[rows.length - 1];
  const target = new Date(last.date).getTime() - 365 * DAY;
  const yearAgo = [...rows].reverse().find((r) => new Date(r.date).getTime() <= target + 7 * DAY) ?? rows[0];
  const recent = rows.slice(-24).map((r) => r.value);
  return {
    series: s.id, label: s.label, units: s.units, cadence: s.cadence,
    latestDate: last.date, latestMilli: milli(last.value),
    yearAgoDate: yearAgo.date, yearAgoMilli: milli(yearAgo.value),
    yoyBp: Math.round((last.value / yearAgo.value - 1) * 10_000),
    ageDays: Math.max(0, Math.floor((now - new Date(last.date).getTime()) / DAY)),
    last24MinMilli: milli(Math.min(...recent)), last24MaxMilli: milli(Math.max(...recent)),
    last24AvgMilli: milli(recent.reduce((a, b) => a + b, 0) / recent.length), observations: rows.length,
  };
}

export async function fetchFred(key) {
  const s = FRED[key];
  if (!s) throw new Error(`unknown FRED key ${key}`);
  const sourceUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.id}`;
  const rows = parseFredCsv(await (await ok(sourceUrl)).text());
  return { ...summariseSeries(key, rows), fetchedAt: new Date().toISOString(), source: 'FRED, Federal Reserve Bank of St. Louis', sourceUrl };
}

// ── AI-crawler access: what a site's robots.txt says to the main AI crawlers ─────────────────────────
export const CRAWLERS = { gptbot: 'GPTBot', claudebot: 'ClaudeBot', perplexitybot: 'PerplexityBot', googleExtended: 'Google-Extended' };

/** Group a robots.txt into [{agents:[lowercase], rules:[{type,path}]}]. */
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase()); lastWasAgent = true;
    } else if (field === 'disallow' || field === 'allow') {
      if (cur) cur.rules.push({ type: field, path: value });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  return groups;
}

/** 1 if the named crawler may fetch the site root, 0 if it is blocked from it. A specific group beats `*`; no group means allowed. */
export function crawlerAllowed(groups, agent) {
  const name = agent.toLowerCase();
  const group = groups.find((g) => g.agents.includes(name)) ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return 1;
  const blocks = group.rules.some((r) => r.type === 'disallow' && r.path === '/');
  const opens = group.rules.some((r) => r.type === 'allow' && r.path === '/');
  return blocks && !opens ? 0 : 1;
}

export async function fetchCrawlerAccess(domain) {
  const base = `https://${domain}`;
  const robotsUrl = `${base}/robots.txt`;
  const r = await get(robotsUrl, { accept: 'text/plain' });
  let text = '';
  if (r.status === 404) text = ''; // no robots.txt means nothing is blocked
  else if (!r.ok) throw new Error(`${domain} robots.txt answered HTTP ${r.status}`);
  else {
    text = await r.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error(`${domain} robots.txt is an HTML page, not a robots file`);
  }
  const groups = parseRobots(text);
  const out = { domain, robotsStatus: r.status };
  for (const [k, agent] of Object.entries(CRAWLERS)) out[`${k}Allowed`] = crawlerAllowed(groups, agent);
  const llms = await get(`${base}/llms.txt`, { accept: 'text/plain' }).catch(() => null);
  out.llmsTxt = llms && llms.ok && /^text\//.test(llms.headers.get('content-type') ?? '') && !/^\s*<(!doctype|html)/i.test(await llms.text()) ? 1 : 0;
  return { ...out, fetchedAt: new Date().toISOString(), source: `${domain}/robots.txt and /llms.txt`, sourceUrl: robotsUrl };
}

/** Everything the snapshot has, plus structured data on the homepage and a sitemap line in robots.txt. */
export async function fetchDeepAudit(domain) {
  const snap = await fetchCrawlerAccess(domain);
  const home = await ok(`https://${domain}/`, { accept: 'text/html' });
  const html = await home.text();
  const robots = await (await get(`https://${domain}/robots.txt`)).text().catch(() => '');
  return {
    ...snap,
    jsonLdBlocks: (html.match(/<script[^>]+application\/ld\+json/gi) ?? []).length,
    sitemapListed: /^\s*sitemap\s*:/im.test(robots) ? 1 : 0,
  };
}

/** Same crawler questions across a fixed peer set: how many of the peers allow each crawler. Needs most peers to answer. */
export async function fetchPeerBenchmark(domains) {
  const settled = await Promise.allSettled(domains.map(fetchCrawlerAccess));
  const good = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (good.length < Math.ceil(domains.length * 0.6)) throw new Error(`only ${good.length} of ${domains.length} peers answered`);
  const out = { peerCount: good.length };
  for (const k of Object.keys(CRAWLERS)) out[`${k}PeersAllowing`] = good.filter((g) => g[`${k}Allowed`] === 1).length;
  out.llmsTxtPeers = good.filter((g) => g.llmsTxt === 1).length;
  return { ...out, fetchedAt: new Date().toISOString(), source: 'robots.txt and /llms.txt of the peer set', sourceUrl: `https://${domains[0]}/robots.txt` };
}

// ── National Weather Service active alerts for a point ───────────────────────────────────────────────
export async function fetchNwsAlerts(area) {
  const [lat, lon] = AREAS[area];
  const sourceUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  const j = await (await ok(sourceUrl, { accept: 'application/geo+json' })).json();
  if (!Array.isArray(j.features)) throw new Error('NWS answered without a features list');
  const sev = j.features.map((f) => f.properties?.severity);
  const events = [...new Set(j.features.map((f) => String(f.properties?.event ?? '').replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean))];
  return {
    area, activeAlerts: j.features.length,
    severeAlerts: sev.filter((s) => s === 'Severe' || s === 'Extreme').length,
    events: events.slice(0, 4).join('; ') || 'none',
    updated: String(j.updated ?? ''), fetchedAt: new Date().toISOString(), source: 'National Weather Service (api.weather.gov)', sourceUrl,
  };
}
