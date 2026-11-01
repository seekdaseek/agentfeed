#!/usr/bin/env node
// ops/r24-company-check-insider-equiv.js: the Form 4 reader of company-check v2 (insider.js) against tools/sec.js getInsiderTrades on LIVE filings (R24 item 5, v2): for each ticker both are run one after the other and the
// counts, the sums and the open-market transactions must be identical. Live: it makes about 27 requests per ticker per side (the declared User-Agent, 8 a second each).
// usage: node ops/r24-company-check-insider-equiv.js [TICKER ...]     (default: the development tickers NVDA AAPL MSFT GOOGL AMZN AVGO META TSLA LLY BRK-B)
'use strict';
const sec = require('../tools/sec');
const E = require('../tools/r24/company-check/edgar');
const INS = require('../tools/r24/company-check/insider');
const R = require('../tools/r24/company-check/resolve');
const CC = require('../tools/r24/company-check');

const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'AVGO', 'META', 'TSLA', 'LLY', 'BRK-B'];
const view = (r) => ({ window_days: r.window_days, form4_filings: r.form4_filings, filings_capped: r.filings_capped, transactions: r.transactions, buys: r.open_market_buys_usd, sales: r.open_market_sales_usd,
  ps: r.trades.filter((x) => x.code === 'P' || x.code === 'S').map((x) => [x.code, x.filed, x.value_usd]) });
(async () => {
  const d = { now: Date.now, fetch: E.defaultEdgarFetch, form4Cache: CC.makeCache() };
  let bad = 0; let filings = 0; let trades = 0;
  for (const t of tickers) {
    const row = (await R.loadList(d)).find(t);
    if (!row) { console.log(t, 'not on the list'); bad++; continue; }
    const a = view(await sec.getInsiderTrades({ ticker: t, days: 90 }));
    const sub = await E.fetchSubmissions(row.cik, d);
    const b = view(await INS.getInsiderTrades({ cik: row.cik, days: 90, rows: sub.form4 }, d));
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) bad++;
    filings += a.form4_filings; trades += a.transactions;
    console.log(`${t.padEnd(6)} ${same ? 'SAME' : 'DIFFERENT'}  filings ${a.form4_filings}${a.filings_capped ? ' (capped)' : ''}, transactions ${a.transactions}, purchases ${a.buys}, sales ${a.sales}${same ? '' : `\n  sec.js ${JSON.stringify(a)}\n  mine   ${JSON.stringify(b)}`}`);
  }
  console.log(`\n${tickers.length - bad} of ${tickers.length} identical; ${filings} Form 4 filings and ${trades} transactions compared`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
