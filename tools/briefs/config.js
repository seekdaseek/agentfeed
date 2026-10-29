// tools/briefs/config.js: the pensio briefs' prices and pass terms. EVERY price here is PROPOSED: the owner's decision, one place to change.
// The anchors: Agentic.Market's morning briefing sells at $0.03-0.04, and get_market_state ($0.02) is the closest thing AgentFeed already sells.
'use strict';

const PRICES_PROPOSED = {
  morning: 0.03,   // PROPOSED
  move: 0.02,      // PROPOSED
  anomaly: 0.02,   // PROPOSED
  news: 0.03,      // PROPOSED, only sold while PENSIO_NEWS=on
};

// the brief pass: PROPOSED the same $25 as the bot pass, 30 days; the day pass is the $1.00 a stock @x402/fetch client pays with its default cap
const PASS_PROPOSED = {
  usd: 25, days: 30,
  // one call per route per 60 s per key: a brief changes slowly, and a pass key is not an invitation to poll
  paceMs: 60_000,
};
const DAY_PASS_PROPOSED = { usd: 1, days: 1, paceMs: 60_000 };

// the four brief routes. `news` is registered only while PENSIO_NEWS=on (expansion.js); the pass allows whichever of these the server sells.
const ROUTES = {
  morning: '/api/morning-brief',
  move: '/api/move-alert',
  anomaly: '/api/anomaly-flag',
  news: '/api/news-brief',
};
const ALL_ROUTES = Object.values(ROUTES);
const newsOn = () => process.env.PENSIO_NEWS === 'on';
/** the routes sold on this instance, in a fixed order */
const soldRoutes = () => ALL_ROUTES.filter((r) => r !== ROUTES.news || newsOn());

// freshness: every part has a maximum age. Where the source tool has its own limit it is imported (sources.js), not copied here; these are the
// parts whose tool has none.
const MAX_AGE_S = {
  fear_greed: 36 * 3600,     // alternative.me publishes the index once a day; its own tool memoises 30 min and states no bound
  news_snapshot: 3 * 3600,   // the news collector runs every 30 minutes; a source not read for 3 hours is stale and its items are left out
  calibration: 45 * 86400,   // the move-alert tails (bin/brief-calibrate.js); older than this the table is refused and the route answers 503
};

module.exports = { PRICES_PROPOSED, PASS_PROPOSED, DAY_PASS_PROPOSED, ROUTES, ALL_ROUTES, soldRoutes, newsOn, MAX_AGE_S };
