// tools/llm/region-gate.js — the region gate for the language-model routes (R11 B, review fix 1).
//
// WHY: the Gemini API Additional Terms (ai.google.dev/gemini-api/terms): "You may only access the Services (or make API Clients
// available to users) within an available region." AgentFeed's callers are agents anywhere, so the eight language-model routes
// (ocr, summarize, extract, translate, classify, injection-check, transcribe) are closed to callers outside that list.
//
// THE LIST: read live from https://ai.google.dev/gemini-api/docs/available-regions on 2026-10-13. The page says "Last updated
// 2026-04-28 UTC" and lists 230 countries and territories by name; each name below is exactly as the page wrote it, mapped
// to its ISO 3166-1 alpha-2 code (the code Cloudflare's CF-IPCountry header carries). Every name mapped to one code, none left
// over. Some places are NOT on the page and are therefore blocked: among them CN, RU, IR, KP, CU, SY, BY, AF, MM, HK, MO. This is
// a snapshot: re-read the page and rebuild the table when Google changes it.
//
// THE RULE: when CF-IPCountry is present and its value is not in this table the request is refused with HTTP 451 and
// { error, country }, before any payment negotiation, so it is never billed. T1 (Tor exit nodes) and XX (Cloudflare could not tell)
// are not countries, are not in the table, and are blocked. An empty header value is also blocked (present, and not on the list).
// A MISSING header (local runs, tests, a hit that did not come through Cloudflare) is allowed: the gate cannot judge what it
// cannot see. x402.ochinimus.app is served through a Cloudflare tunnel, which sets the header; whether the origin port is also
// open to the internet directly (where a caller could omit it) was not checked.
//
// WIRING (not done): mount regionGate once in server.js ABOVE the payment layer (after compat.stripNetworkSuffix). It also covers
// POST /mcp: that route parses its own JSON body, so for a request that would be blocked anyway the gate parses it first
// (express.json skips a body that is already parsed) and refuses only calls to the eight language-model tools; other MCP calls pass.
'use strict';

const COUNTRIES = {
  AL: "Albania",
  DZ: "Algeria",
  AS: "American Samoa",
  AD: "Andorra",
  AO: "Angola",
  AI: "Anguilla",
  AQ: "Antarctica",
  AG: "Antigua and Barbuda",
  AR: "Argentina",
  AM: "Armenia",
  AW: "Aruba",
  AU: "Australia",
  AT: "Austria",
  AZ: "Azerbaijan",
  BS: "The Bahamas",
  BH: "Bahrain",
  BD: "Bangladesh",
  BB: "Barbados",
  BE: "Belgium",
  BZ: "Belize",
  BJ: "Benin",
  BM: "Bermuda",
  BT: "Bhutan",
  BO: "Bolivia",
  BA: "Bosnia and Herzegovina",
  BW: "Botswana",
  BR: "Brazil",
  IO: "British Indian Ocean Territory",
  VG: "British Virgin Islands",
  BN: "Brunei",
  BG: "Bulgaria",
  BF: "Burkina Faso",
  BI: "Burundi",
  CV: "Cabo Verde",
  KH: "Cambodia",
  CM: "Cameroon",
  CA: "Canada",
  BQ: "Caribbean Netherlands",
  KY: "Cayman Islands",
  CF: "Central African Republic",
  TD: "Chad",
  CL: "Chile",
  CX: "Christmas Island",
  CC: "Cocos (Keeling) Islands",
  CO: "Colombia",
  KM: "Comoros",
  CK: "Cook Islands",
  CR: "Costa Rica",
  CI: "Côte d'Ivoire",
  HR: "Croatia",
  CW: "Curaçao",
  CZ: "Czech Republic",
  CD: "Democratic Republic of the Congo",
  DK: "Denmark",
  DJ: "Djibouti",
  DM: "Dominica",
  DO: "Dominican Republic",
  EC: "Ecuador",
  EG: "Egypt",
  SV: "El Salvador",
  GQ: "Equatorial Guinea",
  ER: "Eritrea",
  EE: "Estonia",
  SZ: "Eswatini",
  ET: "Ethiopia",
  FK: "Falkland Islands (Islas Malvinas)",
  FO: "Faroe Islands",
  FJ: "Fiji",
  FI: "Finland",
  FR: "France",
  GF: "French Guiana",
  GA: "Gabon",
  GM: "The Gambia",
  GE: "Georgia",
  DE: "Germany",
  GH: "Ghana",
  GI: "Gibraltar",
  GR: "Greece",
  GL: "Greenland",
  GD: "Grenada",
  GU: "Guam",
  GT: "Guatemala",
  GG: "Guernsey",
  GN: "Guinea",
  GW: "Guinea-Bissau",
  GY: "Guyana",
  HT: "Haiti",
  HM: "Heard Island and McDonald Islands",
  HN: "Honduras",
  HU: "Hungary",
  IS: "Iceland",
  IN: "India",
  ID: "Indonesia",
  IQ: "Iraq",
  IE: "Ireland",
  IM: "Isle of Man",
  IL: "Israel",
  IT: "Italy",
  JM: "Jamaica",
  JP: "Japan",
  JE: "Jersey",
  JO: "Jordan",
  KZ: "Kazakhstan",
  KE: "Kenya",
  KI: "Kiribati",
  XK: "Kosovo",
  KW: "Kuwait",
  KG: "Kyrgyzstan",
  LA: "Laos",
  LV: "Latvia",
  LB: "Lebanon",
  LS: "Lesotho",
  LR: "Liberia",
  LY: "Libya",
  LI: "Liechtenstein",
  LT: "Lithuania",
  LU: "Luxembourg",
  MG: "Madagascar",
  MW: "Malawi",
  MY: "Malaysia",
  MV: "Maldives",
  ML: "Mali",
  MT: "Malta",
  MH: "Marshall Islands",
  MR: "Mauritania",
  MU: "Mauritius",
  MX: "Mexico",
  FM: "Micronesia",
  MD: "Moldova",
  MC: "Monaco",
  MN: "Mongolia",
  ME: "Montenegro",
  MS: "Montserrat",
  MA: "Morocco",
  MZ: "Mozambique",
  NA: "Namibia",
  NR: "Nauru",
  NP: "Nepal",
  NL: "Netherlands",
  NC: "New Caledonia",
  NZ: "New Zealand",
  NI: "Nicaragua",
  NE: "Niger",
  NG: "Nigeria",
  NU: "Niue",
  NF: "Norfolk Island",
  MK: "North Macedonia",
  MP: "Northern Mariana Islands",
  NO: "Norway",
  OM: "Oman",
  PK: "Pakistan",
  PW: "Palau",
  PS: "Palestine",
  PA: "Panama",
  PG: "Papua New Guinea",
  PY: "Paraguay",
  PE: "Peru",
  PH: "Philippines",
  PN: "Pitcairn Islands",
  PL: "Poland",
  PT: "Portugal",
  PR: "Puerto Rico",
  QA: "Qatar",
  CY: "Republic of Cyprus",
  CG: "Republic of the Congo",
  RO: "Romania",
  RW: "Rwanda",
  RE: "Réunion",
  BL: "Saint Barthélemy",
  SH: "Saint Helena, Ascension and Tristan da Cunha",
  KN: "Saint Kitts and Nevis",
  LC: "Saint Lucia",
  PM: "Saint Pierre and Miquelon",
  VC: "Saint Vincent and the Grenadines",
  WS: "Samoa",
  SM: "San Marino",
  ST: "São Tomé and Príncipe",
  SA: "Saudi Arabia",
  SN: "Senegal",
  RS: "Serbia",
  SC: "Seychelles",
  SL: "Sierra Leone",
  SG: "Singapore",
  SK: "Slovakia",
  SI: "Slovenia",
  SB: "Solomon Islands",
  SO: "Somalia",
  ZA: "South Africa",
  GS: "South Georgia and the South Sandwich Islands",
  KR: "South Korea",
  SS: "South Sudan",
  ES: "Spain",
  LK: "Sri Lanka",
  SD: "Sudan",
  SR: "Suriname",
  SE: "Sweden",
  CH: "Switzerland",
  TW: "Taiwan",
  TJ: "Tajikistan",
  TZ: "Tanzania",
  TH: "Thailand",
  TL: "Timor-Leste",
  TG: "Togo",
  TK: "Tokelau",
  TO: "Tonga",
  TT: "Trinidad and Tobago",
  TN: "Tunisia",
  TM: "Turkmenistan",
  TC: "Turks and Caicos Islands",
  TV: "Tuvalu",
  TR: "Türkiye",
  UG: "Uganda",
  UA: "Ukraine",
  AE: "United Arab Emirates",
  GB: "United Kingdom",
  US: "United States",
  UM: "United States Minor Outlying Islands",
  UY: "Uruguay",
  VI: "U.S. Virgin Islands",
  UZ: "Uzbekistan",
  VU: "Vanuatu",
  VA: "Vatican City",
  VE: "Venezuela",
  VN: "Vietnam",
  WF: "Wallis and Futuna",
  EH: "Western Sahara",
  YE: "Yemen",
  ZM: "Zambia",
  ZW: "Zimbabwe",
  AX: "Åland Islands",
};

// the eight routes and their MCP tool names (the names in the Phase B wiring snippet)
const PHASE_B_PATHS = new Set(['/api/ocr', '/api/summarize', '/api/extract', '/api/translate', '/api/classify', '/api/injection-check', '/api/transcribe', '/api/claim-check']);
const PHASE_B_TOOLS = new Set(['get_ocr', 'get_summarize', 'get_extract', 'get_translate', 'get_classify', 'get_injection_check', 'get_transcribe', 'get_claim_check']);

/** -> { blocked: boolean, country: string|null }. header is the raw CF-IPCountry value (undefined when absent). */
function check(header) {
  if (header === undefined || header === null) return { blocked: false, country: null };
  const country = String(Array.isArray(header) ? header[0] : header).trim().toUpperCase();
  return { blocked: !Object.prototype.hasOwnProperty.call(COUNTRIES, country), country };
}

// R19a: the canonical path (lib/canon-path.js), so /API/OCR, /Api/Ocr/ and /api//ocr from a blocked country are the 451 like /api/ocr (the x402 gate
// routes them all to the same paid handler); the network suffix (|eip155:8453, or its %7C spelling, decoded by canonPath) is stripped after.
const { canonPath } = require('../../lib/canon-path');
const stripSuffix = (p) => { const c = canonPath(p); const i = c.indexOf('|'); return (i < 0 ? c : c.slice(0, i)).replace(/\/+$/, '') || '/'; };
function refuse(res, country) {
  res.status(451).json({ error: 'The language-model routes are not available in your region (Google Gemini API availability)', country: country || null });
}

function mcpCallsPhaseB(body) {
  const list = Array.isArray(body) ? body : [body];
  return list.some((m) => m && typeof m === 'object' && m.method === 'tools/call' && m.params && PHASE_B_TOOLS.has(String(m.params.name)));
}

function regionGate(req, res, next) {
  const verdict = check(req.headers['cf-ipcountry']);
  if (!verdict.blocked) return next();
  const p = stripSuffix(req.path || '');
  if (PHASE_B_PATHS.has(p)) return refuse(res, verdict.country);
  if (req.method === 'POST' && p === '/mcp') {
    const decide = () => (mcpCallsPhaseB(req.body) ? refuse(res, verdict.country) : next());
    if (req.body !== undefined) return decide();
    return require('express').json()(req, res, (err) => (err ? next() : decide()));
  }
  return next();
}

module.exports = { regionGate, check, COUNTRIES, PHASE_B_PATHS, PHASE_B_TOOLS };
