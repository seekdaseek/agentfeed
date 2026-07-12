'use strict';
// Single source of truth for the PRODUCT universe.
//
// The collector records EVERY liquidation it can see — that data is unbackfillable, so we
// take all of it. But what we SERVE stays curated: widening collection must never silently
// change what an existing paying customer receives.
//
// scope=all opts into the full recorded universe.
const CORE = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT'];
const CORE_MAP = { SOL: 'SOLUSDT', BTC: 'BTCUSDT', ETH: 'ETHUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' };
const isAll = (q) => String((q && q.scope) || 'core').toLowerCase() === 'all';
const inClause = (list) => list.map(() => '?').join(',');
module.exports = { CORE, CORE_MAP, isAll, inClause };
