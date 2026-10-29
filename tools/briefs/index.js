// tools/briefs/index.js: the pensio briefs (morning-brief, move-alert, anomaly-flag, and the news brief behind PENSIO_NEWS=on).
'use strict';
const config = require('./config');
module.exports = {
  config,
  get getMorningBrief() { return require('./morning').getMorningBrief; },
  get getMoveAlert() { return require('./move').getMoveAlert; },
  get getAnomalyFlag() { return require('./anomaly').getAnomalyFlag; },
};
