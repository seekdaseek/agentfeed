// tools/questions.js — the one place a route's when-to-use question lives.
//
// This used to sit in tools/discovery.js, which made it SKILL.md's private
// property. payments.js now leads every paid route's 402 challenge description
// with the same sentence, and CDP curates on that description, so the two must
// be the same string by construction rather than by somebody remembering. One
// module, two readers: if this file is the only source, they cannot drift.
//
// Prose, not numbers: nothing here goes stale when a price or a count changes.
'use strict';

// The question a caller actually has, per route. Prose, not numbers: nothing
// here can go stale when a price or a count changes. A route missing from this
// map falls back to its own description, so a new route is never dropped from
// the table -- it just gets a rougher question until someone writes one.
const QUESTIONS = {
  get_exit_quote: 'What can this seized collateral actually be sold for, at size?',
  get_peg_deviation: 'How far is a tokenized stock trading from its underlying?',
  get_peg_sessions: 'When in the trading day does the peg break worst?',
  get_peg_universe: 'Which tokenized stocks carry the worst off-hours peg risk?',
  get_liq_pulse: 'What is being liquidated right now?',
  get_liq_history: 'How much was liquidated, bucketed over time?',
  get_liq_heatmap: 'At which price levels did leverage actually get flushed?',
  get_cascade_history: 'Which liquidation cascades already happened?',
  get_cascade_forecast: 'How likely is a liquidation spike in the next 15 minutes?',
  get_squeeze_score: 'Is this trade crowded and about to hurt someone?',
  get_recent_liquidations: 'Which liquidations just printed?',
  get_cascade_alert: 'Is a cascade running on the majors right now?',
  get_cascade_scan: 'Is a cascade running on any perp right now?',
  get_liquidation_leaders: 'Which symbols are blowing up right now?',
  get_liquidation_stats: 'How much was liquidated in the last 1h and 24h?',
  get_venue_liq_share: 'Which exchange is doing the liquidating?',
  get_perp: 'What is this perp doing right now, in one call?',
  get_funding_pulse: 'Where is funding most extreme right now?',
  get_funding_cross: 'What is funding for this perp across venues?',
  get_funding_extremes: 'Which trades are most crowded by funding?',
  get_funding_history: 'What has the carry on this perp actually been?',
  get_funding_rate: 'What is funding on SOL and BTC?',
  get_open_interest: 'How much open interest sits on this perp?',
  get_oi_spike_scan: 'Where is new leverage piling in?',
  get_long_short: 'How crowded is retail on this perp?',
  get_basis: 'Is this perp trading above or below spot?',
  get_volatility: 'How volatile has this perp been?',
  get_top_movers: 'What moved most in the last 24 hours?',
  get_orderbook_imbalance: 'Which side of the book holds more resting liquidity?',
  get_orderbook_walls: 'Where are the big resting orders?',
  get_whale_trades: 'Are whales buying or selling this perp?',
  get_spread_arb: 'Is there a cross-exchange spread worth arbing?',
  get_spot: 'What is the spot price, without picking a venue?',
  get_sol_price: 'What is SOL worth?',
  get_btc_price: 'What is BTC worth?',
  get_eth_price: 'What is ETH worth?',
  get_market_snapshot: 'What is the market doing, in one call?',
  get_positioning: 'How is the market positioned on SOL and BTC?',
  get_trade_context: 'What do I need to know before placing a trade?',
  get_wallet_holdings: 'What does this Solana wallet hold?',
  get_wallet_activity: 'What has this Solana wallet been doing?',
  get_token_metadata: 'What is this SPL token?',
  get_token_risk: 'Is this SPL token a rug?',
  get_token_holders: 'Who holds this SPL token?',
  get_priority_fees: 'What priority fee will land my Solana transaction?',
  get_jito_tips: 'What tip will land my Jito bundle?',
  get_sol_network: 'Is the Solana network healthy right now?',
  get_dex_quote: 'What will this swap actually execute at?',
  get_base_gas: 'What is gas on Base?',
  get_base_balance: 'What does this EVM address hold?',
  get_tvl: 'How much TVL does this protocol have?',
  get_stablecoin_flows: 'Is stablecoin supply growing or shrinking?',
  get_fear_greed: 'What is the crypto Fear and Greed index?',
  get_last_liquidation: 'What was the last liquidation on each major?',
  get_exit_method: 'How is exit liquidity measured, and on how many rows?',
  get_forecast_record: 'How accurate has the cascade forecast actually been?',
};

/** The question for a route, or one derived from its own description. */
function questionFor(tool, desc) {
  if (QUESTIONS[tool]) return QUESTIONS[tool];
  const d = String(desc || '');
  const m = d.match(/^Use when an agent needs ([^.]+)\./);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + '?';
  return d.split(/[.:(]/)[0].trim() + '?';
}

module.exports = { QUESTIONS, questionFor };
