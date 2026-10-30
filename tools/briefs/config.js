// tools/briefs/config.js: the pensio briefs' prices and the signals pass terms, in one place. Accepted by the owner on 30 Oct 2026 as set here; the public text states them plainly.
// The anchors: Agentic.Market's morning briefing sells at $0.03-0.04, and get_market_state ($0.02) is the closest thing AgentFeed already sells.
'use strict';

const BRIEF_PRICES = {
  morning: 0.03,
  move: 0.02,   
  anomaly: 0.02,
  news: 0.03,  // only sold while PENSIO_NEWS=on
};

// the signals pass: the same $25 as the bot pass, 30 days; the day pass is the $1.00 a stock @x402/fetch client pays with its default cap
const PASS_TERMS = {
  usd: 25, days: 30,
  // one call per route per 60 s per key: a brief changes slowly, a signal row is rebuilt every 30 s at most, and a pass key is not an invitation to poll
  paceMs: 60_000,
};
const DAY_PASS_TERMS = { usd: 1, days: 1, paceMs: 60_000 };

// the four brief routes. `news` is registered only while PENSIO_NEWS=on (expansion.js); the pass allows whichever of these the server sells.
const ROUTES = {
  morning: '/api/morning-brief',
  move: '/api/move-alert',
  anomaly: '/api/anomaly-flag',
  news: '/api/news-brief',
};
const ALL_ROUTES = Object.values(ROUTES);
const newsOn = () => process.env.PENSIO_NEWS === 'on';
/** the brief routes sold on this instance, in a fixed order */
const soldRoutes = () => ALL_ROUTES.filter((r) => r !== ROUTES.news || newsOn());

// The perp signal routes the signals pass also covers: priced routes that already exist (expansion.js). Written in the PATTERN form (`:coin`), because that is
// what lib/keys.js compares a request against (priced.pattern) and what is stored in a pass row's `allow`. THE ONE LIST: the pass terms, the pace map, the
// purchase body, the /keys page, the README and the skill package all read it from here.
const SIGNAL_ROUTES = ['/api/market-state', '/api/signal-board', '/api/coin-signal/:coin', '/api/oi-spike-scan', '/api/liq-heatmap'];
/** every route a signals pass may ever cover: stored passes are matched against this set, so switching the news brief on or off later never changes a sold pass's kind */
const PASS_ROUTES_ALL = [...ALL_ROUTES, ...SIGNAL_ROUTES];
/** the routes a signals pass bought on this instance covers: the brief routes it sells (news only while PENSIO_NEWS=on) and the signal routes */
const passRoutes = () => [...soldRoutes(), ...SIGNAL_ROUTES];

// freshness: every part has a maximum age. Where the source tool has its own limit it is imported (sources.js), not copied here; these are the
// parts whose tool has none.
const MAX_AGE_S = {
  fear_greed: 36 * 3600,     // alternative.me publishes the index once a day; its own tool memoises 30 min and states no bound
  news_snapshot: 3 * 3600,   // the news collector runs every 30 minutes; a source not read for 3 hours is stale and its items are left out
  calibration_warn: 30 * 86400,   // from this age the route's method says how old the table is and ops/af-digest.js --alert sends one line a day
  calibration: 45 * 86400,   // the move-alert tails (bin/brief-calibrate.js); older than this the table is refused and the route answers 503
};

module.exports = { BRIEF_PRICES, PASS_TERMS, DAY_PASS_TERMS, ROUTES, ALL_ROUTES, SIGNAL_ROUTES, PASS_ROUTES_ALL, soldRoutes, passRoutes, newsOn, MAX_AGE_S };
