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
  get_signal_board: 'Which Hyperliquid perps are crowded, squeezing or being liquidated right now?',
  get_coin_signal: 'What is the positioning, liquidation and cascade picture for one coin right now?',
  buy_key_trial: 'How can a bot that cannot pay x402 try AgentFeed for $0.25?',
  buy_key_1: 'How can a bot that cannot pay x402 buy $1 of AgentFeed credit?',
  buy_key_5: 'How can a bot that cannot pay x402 buy $5 of AgentFeed credit?',
  buy_key_20: 'How can a bot that cannot pay x402 buy $20 of AgentFeed credit?',
  buy_key_pass: 'How can a bot that cannot pay x402 get 30 days of the AgentFeed liquidation feed for $25?',
  buy_key_signals_pass: 'How can an agent that runs on a schedule get 30 days of the AgentFeed briefs and perp signals with one flat key and no payment prompt?',
  buy_key_signals_day_pass: 'How can an agent buy 24 hours of the AgentFeed briefs and perp signals for $1 with a default x402 client?',
  buy_key_day_pass: 'How can a bot buy 24 hours of the AgentFeed liquidation feed and recent liquidations for $1?',
  topup_key_5: 'How do I add $5 to an AgentFeed prepaid key?',
  topup_key_20: 'How do I add $20 to an AgentFeed prepaid key?',
  get_peg_deviation: 'How far is a tokenized stock trading from its underlying?',
  get_peg_sessions: 'When in the trading day does the peg break worst?',
  get_peg_universe: 'Which tokenized stocks carry the worst off-hours peg risk?',
  get_liq_pulse: 'What is being liquidated right now?',
  get_liq_feed: 'Which side is being liquidated across venues right now, and how hard compared with normal?',
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
  get_funding_extremes: 'Which trades are most crowded by funding?',
  get_funding_radar: 'Which Hyperliquid perps have unusual funding right now?',
  get_hl_whales: 'How are the biggest Hyperliquid traders positioned, and where are their liquidations?',
  get_web_markdown: 'What does this web page say, as clean markdown?',
  get_pdf_markdown: 'What does this PDF say, as markdown?',
  get_sec_filings: 'What has this company filed with the SEC lately?',
  get_insider_trades: 'Are this company\'s insiders buying or selling?',
  get_sec_8k: 'Which US companies disclosed material events in the last hours?',
  get_tradfi_perps: 'Where is this stock, index or commodity trading right now, 24/7?',
  get_fx_rates: 'What are today\'s official euro exchange rates?',
  get_honeypot_check: 'Can this token be sold on Base, BNB Chain or Ethereum, and what are its taxes?',
  get_base_launches: 'Which tokens just launched on Base, with liquidity and honeypot flags?',

  get_market_state: 'What is the full pre-trade picture for this coin right now?',
  get_morning_brief: 'What changed overnight in BTC, ETH, SOL and HYPE, and what is the one level to watch?',
  get_move_alert: 'Which Hyperliquid perps moved unusually, and was it the calendar or unexplained flow?',
  get_anomaly_flag: 'Is anything abnormal in funding, liquidations or open interest across the perps right now?',
  get_news_brief: 'What did the SEC, the CFTC and the Federal Reserve Board publish in the last 24 hours, and which of it matters?',
  get_macro_calendar: 'When are the next FOMC decision and CPI, NFP and PCE releases?',
  get_tradfi_radar: 'Which stock, index, gold or oil perps have extreme funding right now?',
  get_equity_24h: 'What is this stock trading at right now, even on the weekend?',
  get_funding_history: 'What has the carry on this perp actually been?',
  get_funding_rate: 'What is the funding rate on this perp?',
  get_open_interest: 'How much open interest sits on this perp?',
  get_oi_spike_scan: 'Where is new leverage piling in?',
  get_basis: 'Is this perp trading above or below spot?',
  get_volatility: 'How volatile has this perp been?',
  get_top_movers: 'What moved most in the last 24 hours?',
  get_orderbook_imbalance: 'Which side of the book holds more resting liquidity?',
  get_orderbook_walls: 'Where are the big resting orders?',

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
  get_base_gas: 'What is gas on Base?',
  get_base_balance: 'What does this EVM address hold?',
  get_fear_greed: 'What is the crypto Fear and Greed index?',
  get_last_liquidation: 'What was the last liquidation on each major?',
  get_exit_method: 'How is exit liquidity measured, and on how many rows?',
  get_forecast_record: 'How accurate has the cascade forecast actually been?',
  // R11 (14 Oct 2026)
  get_sanctions_check: 'Is this crypto address on the OFAC sanctions list?',
  get_email_verify: 'Can this email address plausibly receive mail?',
  get_domain: 'What DNS records and TLS certificate does this domain have?',
  get_papers: 'Which scholarly papers cover this topic?',
  get_paper: 'What is the paper behind this DOI?',
  get_wiki: 'What does Wikipedia say about this topic?',
  get_qr: 'How do I turn this text into a QR code?',
  get_hash: 'What is the SHA-256, Keccak-256 or BLAKE2b hash of this input?',
  get_time: 'What time is it, or was it, in this time zone?',
  get_convert: 'What is this quantity in another unit?',
  get_sol_token_check: 'What on-chain risks and how much liquidity does this Solana token have before I buy?',
  get_sol_token_flow: 'Who is actually trading this Solana token: many wallets or a few?',
  get_sol_holder_clusters: 'Do the top holders of this Solana token share a funder?',
  get_ocr: 'What text is in this image?',
  get_summarize: 'What does this page or PDF say, in short?',
  get_extract: 'What are these fields on this page or PDF, as JSON?',
  get_translate: 'What does this text say in another language?',
  get_classify: 'Which of my labels fits this text best?',
  get_injection_check: 'Does this text contain a prompt-injection attempt?',
  get_transcribe: 'What is said in this audio file?',
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
