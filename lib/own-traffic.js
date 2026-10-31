// lib/own-traffic.js: the ONE list of our own payer wallets (R22, 30 Oct 2026). A payment from one of these is QA or the owner's own money: it is tagged "own" in the daily digest,
// never alerted on, and left out of every count of outside payers (ops/af-digest.js, ops/funnel.js through af-digest's isOwn, and /opt/afwatch/afwatch.js, which loads this file).
// Before this file the list was copied into af-digest.js and afwatch.js; the copy in afwatch.js is now only the fallback it uses if this file cannot be read.
// An EVM address is one wallet however its case arrives (normPayer, the same rule as lib/audit.js: lower-case for 0x addresses, anything else untouched).
'use strict';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const normPayer = (w) => (w === undefined || w === null || w === '' ? null : EVM_ADDRESS.test(String(w)) ? String(w).toLowerCase() : String(w));

const OWN_WALLET_LIST = [
  'EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1',
  'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu',
  'TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw',
  '0xFEfF369D5048b2Cf817d87467E48404b3ADfE4Ee',
  '0x05b38ff795a2d750788157f1119e5d403d8ef47a', // the Circle Gateway proof payer (Arc, 13 Oct 2026)
  '0xcc1177889ff3fb19ed851c1dd9bf4b1871ee3736', // the owner's own Base wallet: bought the $1 prepaid balance key 3k9h2bvv on /keys, 30 Oct 2026 11:14Z (own money, not outside revenue)
  '0xB96c536A2b01584c5Dd8967AF0d8Ba97eBC2417F', // dreamdex-signal-bot payer (Base), own money, QA not revenue, 31 Oct 2026
  '0x4e64ad598a70D47D33Aa1C6D7FC07d723dd3476e', // the x402-test route's dedicated wallet (Base), own money, QA not revenue, 31 Oct 2026 (tools/r23/x402/test-wallet.json)
  '8Do88KPvpoMd65PXiP25VJcMAodHvihhu471HaCxvAs3', // the x402-test route's dedicated wallet (Solana), same
];
const OWN_WALLETS = new Set(OWN_WALLET_LIST.map(normPayer));
const isOwnWallet = (w) => OWN_WALLETS.has(normPayer(w));

module.exports = { OWN_WALLET_LIST, OWN_WALLETS, isOwnWallet, normPayer };
