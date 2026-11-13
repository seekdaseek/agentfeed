// lib/avm-network.js: the Algorand network id at the @x402/avm boundary (R27, 13 Nov 2026).
//
// Our Algorand rail advertises algorand:<full genesis hash> (lib/rails.js ALGORAND_MAINNET, 44 characters with a trailing "="). That is the id agentfeed-algo (algo.ochinimus.app) serves live and the one it has
// settled with through the GoPlausible facilitator since September; the facilitator's /supported lists it AND the 32-character CAIP-2 form (checked live 13 Nov 2026, algorand-live-ids.txt). @x402/avm 2.28.0 normalised the
// full genesis hash to its CAIP-2 form internally; 2.31.0 dropped that and throws "Unsupported Algorand network" for anything but the two 32-character ids, which broke every price parse on the rail.
// The adapter restores the 2.28 behaviour at the one place it matters: the network handed to avm's parsePrice and getAssetDecimals is mapped to the CAIP-2 id; the advertised id, the requirements and the
// facilitator kinds are untouched. (Only mainnet is on the rail; the testnet row is the same alias avm 2.28 had.)
'use strict';
const { ExactAvmScheme } = require('@x402/avm/exact/server');

const FULL_TO_CAIP2 = {
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=': 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe',
};
const toAvmNetwork = (network) => FULL_TO_CAIP2[network] || network;

class ExactAvmSchemeFullId extends ExactAvmScheme {
  parsePrice(price, network) { return super.parsePrice(price, toAvmNetwork(network)); }
  getAssetDecimals(asset, network) { return super.getAssetDecimals(asset, toAvmNetwork(network)); }
}

module.exports = { ExactAvmSchemeFullId, toAvmNetwork, FULL_TO_CAIP2 };
