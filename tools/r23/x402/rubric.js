// tools/r23/x402/rubric.js: the x402 lint rubric as DATA (R23 T3, 31 Oct 2026). lint.js only ever reports a check that is listed here, with the severity and weight listed here;
// the notes and the tests read this same table, so what the route grades, what the tests cover and what the documents say cannot drift apart.
//
//   severity  error: the challenge cannot be paid as served, or the paywall can be walked around. warn: payable, but a client or a catalogue may stumble. info: reported, never graded.
//   weight    points taken off the 100-point score when an error or warn check FAILS (info checks never score). A check counts once however many offers fail it.
//   verdict   no-402: the unpaid request got no x402 challenge at all (an answer other than 402, or a 402 that carries only a WWW-Authenticate: Payment challenge).
//             invalid: at least one error check failed. warnings: only warn checks failed. valid: no error or warn check failed.
//   A check that could not be run (a probe that timed out) is reported as severity info, pass false, detail "not tested: ...", and never moves the verdict or the score.
'use strict';

const CHECKS = [
  // ---- transport
  { id: 'http_402', group: 'transport', severity: 'error', weight: 100, title: 'The unpaid request is answered with HTTP 402', tests: 'status of the first request' },
  { id: 'no_redirect', group: 'transport', severity: 'warn', weight: 3, title: 'The unpaid request is answered at the URL given, without a redirect', tests: 'final URL of the first request against the URL given' },
  { id: 'challenge_size', group: 'transport', severity: 'warn', weight: 3, title: 'The PAYMENT-REQUIRED header stays under 8 KB', tests: 'header length; proxies commonly buffer 4 to 8 KB of response headers' },
  { id: 'challenge_not_cached', group: 'transport', severity: 'warn', weight: 3, title: 'The 402 is not marked cacheable', tests: 'Cache-Control public, max-age or s-maxage above 0 on the 402' },
  // ---- where the requirements are
  { id: 'challenge_found', group: 'location', severity: 'error', weight: 100, title: 'An x402 payment requirement can be read from the header or the body', tests: 'PAYMENT-REQUIRED header (base64 JSON) or a JSON body with accepts[]' },
  { id: 'header_decodes', group: 'location', severity: 'error', weight: 30, title: 'A PAYMENT-REQUIRED header, when sent, is base64 of a JSON object', tests: 'base64 or base64url text that parses as a JSON object' },
  { id: 'version_known', group: 'location', severity: 'error', weight: 30, title: 'x402Version is 1 or 2', tests: 'x402Version of the challenge' },
  { id: 'version_location', group: 'location', severity: 'warn', weight: 5, title: 'A v2 challenge is in the PAYMENT-REQUIRED header, a v1 challenge in the JSON body', tests: 'where the challenge was found against its version' },
  { id: 'versions_agree', group: 'location', severity: 'warn', weight: 4, title: 'A header and a body challenge of the same version carry the same offers', tests: 'accepts[] of the header against accepts[] of the body when both are the same version' },
  { id: 'mpp_detected', group: 'location', severity: 'info', weight: 0, title: 'A WWW-Authenticate: Payment challenge (MPP) is reported, not graded', tests: 'WWW-Authenticate scheme Payment' },
  // ---- the offers (accepts[])
  { id: 'accepts_present', group: 'offers', severity: 'error', weight: 100, title: 'accepts is a non-empty array of objects', tests: 'accepts[]' },
  { id: 'entry_scheme', group: 'offers', severity: 'error', weight: 15, title: 'Every offer names a scheme', tests: 'scheme is a non-empty string' },
  { id: 'scheme_known', group: 'offers', severity: 'warn', weight: 3, title: 'Schemes are ones this lint recognises', tests: 'scheme in exact, upto, batch-settlement, deferred, aggr_deferred' },
  { id: 'entry_network', group: 'offers', severity: 'error', weight: 20, title: 'Every network is written as the version requires', tests: 'v2: CAIP-2 namespace:reference. v1: a lower-case network name' },
  { id: 'network_known', group: 'offers', severity: 'warn', weight: 6, title: 'Every network is one clients and facilitators know', tests: 'v1 names in the x402 v1 list; CAIP-2 eip155 with a numeric chain id; solana with a known genesis reference; a v1 challenge written with CAIP-2 names' },
  { id: 'entry_amount', group: 'offers', severity: 'error', weight: 25, title: 'The amount is a positive integer string in the field the version uses', tests: 'v2: amount. v1: maxAmountRequired. Digits only, above 0, below 2^256, sent as a string' },
  { id: 'amount_range', group: 'offers', severity: 'warn', weight: 4, title: 'A known USD stablecoin is priced between 0.0001 and 100 USD', tests: 'amount against 6 decimals for USDC on a network this lint knows' },
  { id: 'entry_asset', group: 'offers', severity: 'error', weight: 20, title: 'The asset is written in the format of its network', tests: 'EVM: 0x and 40 hex. Solana: base58 that decodes to 32 bytes. Other networks: unchecked' },
  { id: 'entry_payto', group: 'offers', severity: 'error', weight: 25, title: 'The payTo is written in the format of its network', tests: 'EVM: 0x and 40 hex. Solana: base58 that decodes to 32 bytes. Other networks: unchecked' },
  { id: 'entry_timeout', group: 'offers', severity: 'error', weight: 10, title: 'maxTimeoutSeconds is a positive integer', tests: 'maxTimeoutSeconds; a missing value breaks the signing step of the common clients' },
  { id: 'timeout_range', group: 'offers', severity: 'warn', weight: 2, title: 'maxTimeoutSeconds is between 10 and 3600', tests: 'a window under 10 s is rarely met, one over an hour widens the time a signed payment stays usable' },
  { id: 'exact_extra', group: 'offers', severity: 'error', weight: 20, title: 'An exact offer carries the extra fields its network needs to sign', tests: 'EVM exact: extra.name and extra.version. Solana exact: extra.feePayer as a base58 address' },
  { id: 'entry_duplicate', group: 'offers', severity: 'warn', weight: 3, title: 'No offer is listed twice', tests: 'identical scheme, network, asset, payTo, amount and extra' },
  { id: 'mainnet_offered', group: 'offers', severity: 'warn', weight: 3, title: 'At least one offer is on a mainnet', tests: 'every known network being a testnet is reported; unknown networks are not counted as testnets' },
  // ---- the resource
  { id: 'resource_url', group: 'resource', severity: 'warn', weight: 5, title: 'The resource URL is public and is the URL that was requested', tests: 'v2: resource.url. v1: accepts[].resource. Absolute http or https, no local host, same host and path as the request' },
  { id: 'description_present', group: 'resource', severity: 'warn', weight: 3, title: 'A description tells an agent what the call returns', tests: 'v2: resource.description. v1: accepts[].description' },
  { id: 'mime_type_present', group: 'resource', severity: 'warn', weight: 2, title: 'mimeType names the type of the paid response', tests: 'v2: resource.mimeType. v1: accepts[].mimeType, written type/subtype' },
  { id: 'extensions_shape', group: 'resource', severity: 'warn', weight: 2, title: 'extensions, when present, is an object', tests: 'extensions of a v2 challenge' },
  { id: 'discovery_metadata', group: 'resource', severity: 'info', weight: 0, title: 'Discovery metadata a catalogue can index is listed', tests: 'v1 outputSchema; v2 extensions: bazaar, sign-in-with-x, payment-identifier, offer-receipt, eip2612GasSponsoring, erc20ApprovalGasSponsoring, builder-code' },
  // ---- the paywall itself
  { id: 'head_unpaid', group: 'paywall', severity: 'error', weight: 25, title: 'A HEAD request without payment is not served', tests: 'HEAD to the same URL answering 2xx with content (a Content-Length above 0, or none given)' },
  { id: 'case_variant_unpaid', group: 'paywall', severity: 'error', weight: 25, title: 'The upper-case spelling of the path is not served without payment', tests: 'the same request with the path in capitals answering 2xx with a body' },
  { id: 'slash_variant_unpaid', group: 'paywall', severity: 'error', weight: 25, title: 'The trailing-slash spelling of the path is not served without payment', tests: 'the same request with a trailing slash added or removed answering 2xx with a body' },
];

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));
if (BY_ID.size !== CHECKS.length) throw new Error('x402 rubric: duplicate check id');

const SCHEMES = ['exact', 'upto', 'batch-settlement', 'deferred', 'aggr_deferred'];

// ---- networks. v1 names are the closed list of @x402/evm v1 plus Solana (drift-checked in test/r23-x402-lint.test.js against the installed packages)
const V1_SOLANA = ['solana', 'solana-devnet', 'solana-testnet'];
const V1_CHAIN_IDS = { ethereum: 1, sepolia: 11155111, abstract: 2741, 'abstract-testnet': 11124, 'base-sepolia': 84532, base: 8453, 'avalanche-fuji': 43113, avalanche: 43114, iotex: 4689, sei: 1329, 'sei-testnet': 1328,
  polygon: 137, 'polygon-amoy': 80002, peaq: 3338, story: 1514, educhain: 41923, 'skale-base-sepolia': 324705682, megaeth: 4326, monad: 143, 'monad-testnet': 10143, stable: 988, 'stable-testnet': 2201, celo: 42220, flare: 14 };
const V1_EVM = Object.keys(V1_CHAIN_IDS);
const V1_TESTNETS = new Set(['sepolia', 'abstract-testnet', 'base-sepolia', 'avalanche-fuji', 'sei-testnet', 'polygon-amoy', 'skale-base-sepolia', 'monad-testnet', 'stable-testnet', 'solana-devnet', 'solana-testnet']);
const SOLANA_REFS = { mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' };
const EVM_TESTNET_IDS = new Set([11155111, 84532, 43113, 80002, 1328, 11124, 10143, 2201, 324705682, 421614, 11155420, 5042002]);
const OTHER_NAMESPACES = new Set(['algorand', 'aptos', 'stellar', 'near', 'hedera']);   // recognised families whose payTo and asset formats are not checked here

// USDC by network (CAIP-2 key, address in its canonical spelling). EVM addresses are compared case-insensitively, a Solana mint exactly. Each EVM row is also a default asset of @x402/evm
// and the two Solana rows are exported by @x402/svm (drift-checked in the tests).
const USDC = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'eip155:1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'eip155:43114': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  'eip155:137': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  [`solana:${SOLANA_REFS.mainnet}`]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  [`solana:${SOLANA_REFS.devnet}`]: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const isUsdc = (caip2, asset) => { const u = USDC[caip2]; return Boolean(u) && typeof asset === 'string' && (caip2.startsWith('eip155:') ? u.toLowerCase() === asset.toLowerCase() : u === asset); };
// the two assets x402-test will pay, written in full (a Solana mint is case-sensitive)
const PAYABLE = {
  base: { v2: 'eip155:8453', v1: 'base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', family: 'evm' },
  solana: { v2: `solana:${SOLANA_REFS.mainnet}`, v1: 'solana', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', family: 'solana' },
};

const RANGE_USD = { min: 0.0001, max: 100 };
const EXTENSIONS = ['bazaar', 'sign-in-with-x', 'payment-identifier', 'offer-receipt', 'eip2612GasSponsoring', 'erc20ApprovalGasSponsoring', 'builder-code'];
const LIMITS = { headerBytes: 8192, challengeJsonBytes: 16000, timeoutMin: 10, timeoutMax: 3600, maxBytes: 5 * 1024 * 1024, probeMaxBytes: 512 * 1024, mainTimeoutMs: 10000, probeTimeoutMs: 6000 };
// response headers shown in raw.headers (everything else is dropped)
const HEADER_ALLOW = ['content-type', 'content-length', 'cache-control', 'www-authenticate', 'retry-after', 'location', 'payment-required', 'access-control-expose-headers', 'access-control-allow-origin'];

module.exports = { CHECKS, BY_ID, SCHEMES, V1_EVM, V1_CHAIN_IDS, V1_SOLANA, V1_TESTNETS, SOLANA_REFS, EVM_TESTNET_IDS, OTHER_NAMESPACES, USDC, PAYABLE, isUsdc, RANGE_USD, EXTENSIONS, LIMITS, HEADER_ALLOW };
