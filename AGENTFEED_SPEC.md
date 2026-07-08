# AGENTFEED — x402 + MCP Paid Data API
**Spec v1 — July 8, 2026**
Working name: agentfeed (rename whenever). One backend, two rails: raw HTTP x402 + MCP server. Sells SOL/BTC market data and Solana on-chain lookups to AI agents, paid per-call in USDC on Solana, settling to treasury cj7.

---

## 0. Ground rules (from portfolio lessons)
- Verify external deps are LIVE before building on them (Drift lesson). Verification status per dependency in §8.
- Single hook: paid data for agents. No dashboard, no accounts, no UI in v1.
- Don't ship until a real end-to-end paid call on mainnet lands USDC in cj7's ATA and returns data.
- Payment layer must be swappable — no x402 SDK has won yet. Isolate it behind one module (`payments.js`), same discipline as drift.js in Drift Watch.

## 1. Architecture
```
/opt/agentfeed          (VPS 167.233.69.154)
├── server.js           Express, port 3006, PM2 name: agentfeed
├── payments.js         x402 middleware — 402 envelope, X-PAYMENT verify, settle
├── mcp.js              MCP server (Streamable HTTP) exposing same tools
├── tools/
│   ├── prices.js       Pyth Hermes: SOL (ef0d8b6f), BTC (e62df6c8)
│   ├── funding.js      funding rate source (reuse skrly market strip source)
│   ├── feargreed.js    alternative.me
│   └── onchain.js      Helius DAS: wallet holdings, token metadata
├── ratelimit.js        per-payer-wallet limits + free tier ledger (SQLite)
└── agentfeed.db        SQLite: payments log, free-tier usage, audit trail
```
- nginx: new server block `x402.ochinimus.app` (or path under existing API domain) → 3006. TLS via existing certbot flow.
- No Firebase needed. No frontend. SQLite only.

## 2. Endpoints / MCP tools
| Tool / route              | Source        | Price (USDC) | Notes |
|---------------------------|---------------|--------------|-------|
| get_sol_price             | Pyth Hermes   | 0.001        | spot + confidence |
| get_btc_price             | Pyth Hermes   | 0.001        | |
| get_funding_rate          | existing src  | 0.002        | SOL + BTC perp funding |
| get_fear_greed            | alternative.me| 0.001        | cache 30 min |
| get_market_snapshot       | all above     | 0.003        | one call, everything — agents prefer fewer calls |
| get_wallet_holdings       | Helius DAS    | 0.008        | the differentiated one |
| get_token_metadata        | Helius DAS    | 0.005        | |

Pricing logic: commodity data at floor ($0.001), Helius-backed on-chain data at premium ($0.005–0.008, under Ref's $0.009 benchmark). Every price > unit cost (Helius credit fraction). Adjust after real traffic.

## 3. Payment flow (x402 rail)
1. `GET /api/sol-price` with no `X-PAYMENT` header → respond `402` + PaymentRequirements JSON: amount, USDC SPL mint, recipient = cj7 USDC ATA (HqbmBbnEQVN1xhjXM3uqBbJQf1zTrLnTp5dG9teBaz5z), network = solana-mainnet, nonce.
2. Client signs USDC transfer, retries with base64 `X-PAYMENT` header.
3. `payments.js` verifies + settles via facilitator (see §8 — pick at build time: Coinbase CDP facilitator / Corbits / PayAI). Facilitator is optional per spec — fallback is ~50 lines of self-verify against Helius RPC if facilitators disappoint.
4. On confirmed settlement → 200 + data + optional `X-PAYMENT-RESPONSE` receipt.

### Billing pitfalls to build in from day one (from field reports)
- **Idempotent retries**: request IDs; never bill twice for one failed 5xx + retry.
- **Charge only when response ships**: verify settlement BEFORE doing the Helius call, but log charge-failure-rate; alert if >2%.
- **Audit trail**: every payment → SQLite row (tx sig, payer, tool, amount, ts). Needed for disputes and for knowing what's actually selling.
- **Async metering**: no synchronous logging in the hot path; batch writes.

## 4. MCP rail
- MCP server over Streamable HTTP at `/mcp`, same process.
- `tools/list` returns each tool WITH price annotation so agents can budget before calling.
- Unpaid `tools/call` on paid tool → same 402 envelope → pay → result.
- Reference: Coinbase x402 MCP example + Cloudflare Agents SDK reference implementations. Copy, don't invent.

## 5. Free tier (required for directory ranking)
- 50 free calls per payer wallet, lifetime, tracked in SQLite by wallet pubkey (NOT IP — agent loops share IPs, wallets are the identity).
- Small on purpose: one agent loop can burn a human-sized free tier in minutes.
- Rate limit: 10 req/min per wallet regardless of paid/free.

## 6. Distribution (no hackathon — it ended Nov 2025)
Priority order:
1. Official MCP Registry (registry.modelcontextprotocol.io) — GitHub OAuth namespace verification, server.json manifest.
2. PulseMCP, Glama, Smithery — free listings; free tier boosts ranking.
3. solana.com/x402 ecosystem listing — submit once live on mainnet.
4. Pay.sh community API provider application (50+ providers listed; being in that catalog = agents on Google Cloud gateway can discover and pay you).
5. x402scan / any x402 service indexes found at build time.
6. One 369modus post: "I put a paid API in front of AI agents — here's what happened." Content flywheel, costs nothing.

## 7. Build order
1. **Session 1**: tools/*.js (mostly ports from existing skrly-alerts/riskguard code) + Express skeleton + SQLite. Everything works FREE first.
2. **Session 2**: payments.js — x402 on devnet end-to-end (guide's minimal server/client), then mainnet with real USDC. Test payer: npr7 wallet. Confirm USDC lands in cj7 ATA. THIS IS THE GATE.
3. **Session 3**: mcp.js rail + price annotations + test from Claude Desktop/Cursor as a real MCP client.
4. **Session 4**: rate limiting, free tier, audit logging, PM2 + nginx + TLS, then directory submissions (§6).

## 8. VERIFY AT BUILD TIME (do not skip)
- [ ] Which facilitator actually supports Solana mainnet today with zero fees: Coinbase CDP vs Corbits vs PayAI. Pick one, keep swappable.
- [ ] Corbits SDK (solana-first) vs Coinbase reference TS libs — try Corbits first, fall back to Coinbase's (6 SVM scenarios tested).
- [ ] MCP Registry submission requirements current state (server.json schema).
- [ ] Pay.sh provider onboarding process — how community APIs get listed.
- [ ] Helius free-tier rate limits vs expected traffic; upgrade only when revenue justifies (profitable problem).
- [ ] Funding rate source used in skrly market strip — confirm it permits resale/redistribution, or switch to a source that does.

## 9. Success criteria / kill criteria
- Ship gate: 1 real paid mainnet call, end to end, USDC confirmed in cj7.
- 90-day check: if < $5 total revenue AND < 3 distinct paying wallets → leave it running (costs nothing) but stop investing time. It's a call option, not a project.
- If any single integration starts calling steadily → that's the hockey-stick signal; revisit pricing and add tools.

## 10. Explicitly out of scope v1
- No dashboard, no user accounts, no API keys, no subscriptions.
- No Seeker app. (Agent-spend watchdog is a separate idea, parked.)
- No custom facilitator, no marketplace, no SDK. Sell data, nothing else.
