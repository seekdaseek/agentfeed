// tools/titles.js — each tool's short human name, its own noun phrase.
//
// Lived in mcp.js, where it titles the MCP tools. payments.js now needs it too:
// the four entry routes' challenge descriptions open "Use when an agent needs X.
// Returns Y.", and Y alone lacks the route's key noun ("the price, the venue that
// served it..."), so their challenge opens with the title instead. mcp.js already
// requires payments.js, so payments.js cannot require mcp.js back; both read it
// from here, the same arrangement as tools/questions.js.
'use strict';

const TOOL_TITLES = {
  get_sol_price: 'SOL spot price', get_btc_price: 'BTC spot price', get_eth_price: 'ETH spot price',
  get_spot: 'Spot price', get_funding_rate: 'Perp funding rate', get_fear_greed: 'Fear and Greed index',
  get_market_snapshot: 'Market snapshot', get_trade_context: 'Trade context', get_positioning: 'SOL and BTC positioning',
  get_perp: 'Perp snapshot', get_liq_pulse: 'Liquidation pulse', get_funding_pulse: 'Funding pulse',
  get_wallet_holdings: 'Solana wallet holdings', get_wallet_activity: 'Solana wallet activity',
  get_token_metadata: 'SPL token metadata', get_token_risk: 'Token rug check', get_token_holders: 'Top token holders',
  get_recent_liquidations: 'Recent liquidations', get_last_liquidation: 'Last liquidation',
  get_liquidation_stats: 'Liquidation stats', get_liquidation_leaders: 'Liquidation leaderboard',
  get_liq_history: 'Liquidation history', get_liq_heatmap: 'Liquidation heatmap',
  get_venue_liq_share: 'Liquidations by venue', get_cascade_alert: 'Liquidation cascade alert',
  get_cascade_scan: 'Full universe cascade scan', get_cascade_history: 'Cascade history',
  get_cascade_forecast: 'Liquidation cascade forecast', get_cascade_forecast_free: 'Free cascade forecast',
  get_forecast_question: 'Forecast question spec', get_forecast_record: 'Forecast track record',
  get_squeeze_score: 'Squeeze score', get_funding_cross: 'Cross venue funding',
  get_funding_extremes: 'Funding extremes', get_funding_history: 'Funding history',
  get_open_interest: 'Open interest', get_oi_spike_scan: 'Open interest spikes',
  get_long_short: 'Long short ratio', get_basis: 'Perp spot basis', get_volatility: 'Realized volatility',
  get_top_movers: 'Top movers', get_orderbook_imbalance: 'Orderbook imbalance',
  get_orderbook_walls: 'Orderbook walls', get_whale_trades: 'Whale trades', get_spread_arb: 'Cross exchange spread',
  get_priority_fees: 'Solana priority fees', get_jito_tips: 'Jito tip floor', get_sol_network: 'Solana network health',
  get_tvl: 'Protocol TVL', get_stablecoin_flows: 'Stablecoin flows', get_dex_quote: 'Jupiter DEX quote',
  get_peg_deviation: 'Tokenized stock peg', get_peg_sessions: 'Peg by session', get_peg_universe: 'Tokenized stock rankings',
  get_exit_quote: 'Collateral exit liquidity', get_exit_method: 'Exit liquidity method',
  get_base_gas: 'Base gas price', get_base_balance: 'Base wallet balance',
  pricing: 'Price list',
};

module.exports = { TOOL_TITLES };
