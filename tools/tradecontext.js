// Trade context: full market state in one call (composite of existing tools)
const { getPrice } = require('./prices');
const { getFunding } = require('./funding');
const { getFearGreed } = require('./feargreed');
const { getPositioning } = require('./positioning');
const { getLiquidationStats } = require('./liquidations');

async function getTradeContext() {
  const [sol, btc, fundingSol, fundingBtc, fearGreed, positioning, liquidations] =
    await Promise.all([
      getPrice('SOL'), getPrice('BTC'),
      getFunding('SOL'), getFunding('BTC'),
      getFearGreed(), getPositioning(), getLiquidationStats(),
    ]);
  return {
    ts: Date.now(),
    prices: { sol, btc },
    funding: { sol: fundingSol, btc: fundingBtc },
    fear_greed: fearGreed,
    positioning,
    liquidations,
  };
}

module.exports = { getTradeContext };
