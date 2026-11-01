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
  get_signal_board: 'Perp signal board', get_coin_signal: 'Coin signal',
  get_sol_price: 'SOL spot price', get_btc_price: 'BTC spot price', get_eth_price: 'ETH spot price',
  get_spot: 'Spot price', get_funding_rate: 'Perp funding rate', get_fear_greed: 'Fear and Greed index',
  get_market_snapshot: 'Market snapshot', get_trade_context: 'Trade context', get_positioning: 'SOL and BTC positioning',
  get_perp: 'Perp snapshot', get_liq_pulse: 'Liquidation pulse', get_liq_feed: 'Liquidation pressure feed', get_funding_pulse: 'Funding pulse',
  get_wallet_holdings: 'Solana wallet holdings', get_wallet_activity: 'Solana wallet activity',
  get_token_metadata: 'SPL token metadata', get_token_risk: 'Token rug check', get_token_holders: 'Top token holders',
  get_recent_liquidations: 'Recent liquidations', get_last_liquidation: 'Last liquidation',
  get_liquidation_stats: 'Liquidation stats', get_liquidation_leaders: 'Liquidation leaderboard',
  get_liq_history: 'Liquidation history', get_liq_heatmap: 'Liquidation heatmap',
  get_venue_liq_share: 'Liquidations by venue', get_cascade_alert: 'Liquidation cascade alert',
  get_cascade_scan: 'Full universe cascade scan', get_cascade_history: 'Cascade history',
  get_cascade_forecast: 'Liquidation cascade forecast', get_cascade_forecast_free: 'Free cascade forecast',
  get_forecast_question: 'Forecast question spec', get_forecast_record: 'Forecast track record',
  get_squeeze_score: 'Squeeze score',
  get_funding_extremes: 'Funding extremes', get_funding_radar: 'Funding radar', get_honeypot_check: 'Honeypot check', get_hl_whales: 'Hyperliquid whales', get_web_markdown: 'Web page to markdown', get_pdf_markdown: 'PDF to markdown', get_sec_filings: 'SEC filings', get_insider_trades: 'Insider trades', get_sec_8k: 'SEC 8-K events', get_tradfi_perps: 'Tradfi perps (HIP-3)', get_fx_rates: 'FX reference rates', get_base_launches: 'Base launches',get_market_state: 'Market state', get_macro_calendar: 'Macro calendar', get_tradfi_radar: 'TradFi perps radar', get_equity_24h: 'Equity 24/7 price', get_funding_history: 'Funding history',
  get_open_interest: 'Open interest', get_oi_spike_scan: 'Open interest spikes',
  get_basis: 'Perp basis vs oracle', get_volatility: 'Realized volatility',
  get_top_movers: 'Top movers', get_orderbook_imbalance: 'Orderbook imbalance',
  get_orderbook_walls: 'Orderbook walls',
  get_priority_fees: 'Solana priority fees', get_jito_tips: 'Jito tip floor', get_sol_network: 'Solana network health',
  get_peg_deviation: 'Tokenized stock peg', get_peg_sessions: 'Peg by session', get_peg_universe: 'Tokenized stock rankings',
  get_exit_quote: 'Collateral exit liquidity', get_exit_method: 'Exit liquidity method',
  get_base_gas: 'Base gas price', get_base_balance: 'Base wallet balance',
  pricing: 'Price list',
  // R11 (14 Oct 2026)
  get_sanctions_check: 'OFAC wallet screen', get_email_verify: 'Email verification', get_domain: 'Domain DNS and TLS',
  get_papers: 'Paper search', get_paper: 'Paper by DOI', get_wiki: 'Wikipedia summary', get_qr: 'QR code', get_hash: 'Hash',
  get_time: 'Time zone conversion', get_convert: 'Unit conversion', get_sol_token_check: 'Solana token pre-trade check',
  get_sol_token_flow: 'Solana token trade flow', get_sol_holder_clusters: 'Solana holder clusters',
  get_ocr: 'Image to text (OCR)', get_summarize: 'Page or PDF summary', get_extract: 'Structured extraction', get_translate: 'Translation',
  get_classify: 'Text classification', get_injection_check: 'Prompt injection check', get_transcribe: 'Speech to text',
  // pensio (30 Oct 2026)
  get_morning_brief: 'Morning brief', get_move_alert: 'Move alert', get_anomaly_flag: 'Anomaly flag', get_news_brief: 'Regulatory news brief',
  // R23 (31 Oct 2026)
  get_x402_lint: 'x402 challenge lint', get_x402_test: 'x402 paid test', get_cascade_backtest: 'Cascade backtest', get_claim_check: 'Claim check', get_site_signals: 'Site signals',
  // held (R23_CRASH_ROUTES=off): present so the routes boot if the owner switches them on
  get_crash_risk: 'Crash risk of a new pool', get_launch_radar: 'New launch crash-risk radar', get_crash_risk_record: 'Crash risk track record',
  // R24 (1 Nov 2026)
  get_pkg_check: 'Package check', get_tx_precheck: 'Transaction precheck', get_company_check: 'Company check', get_rwa_yields: 'RWA yields',
};

module.exports = { TOOL_TITLES };
