<!-- mcp-name: io.github.seekdaseek/agentfeed -->
# AgentFeed

**Crypto market + Solana on-chain data for AI agents. Pay per call in USDC. No API keys, no accounts.**

AgentFeed sells live trading and on-chain data through the [x402 payment protocol](https://solana.com/x402) on Solana. An agent hits an endpoint, gets a `402 Payment Required` with the price, pays a fraction of a cent in USDC from its own wallet, and receives the data — all in about two seconds, gas sponsored by the facilitator.

Two ways to consume, same data:

| Rail | Endpoint | For |
|------|----------|-----|
| **MCP** (Streamable HTTP) | `https://x402.ochinimus.app/mcp` | Agents in Claude, Cursor, and MCP-native frameworks |
| **HTTP** (x402) | `https://x402.ochinimus.app/api/*` | Anything that speaks HTTP |

## Tools & pricing

| Tool | Price (USDC) | Data |
|------|-------------|------|
| `get_sol_price` | $0.001 | Live SOL/USD + confidence (Pyth oracle) |
| `get_btc_price` | $0.001 | Live BTC/USD + confidence (Pyth oracle) |
| `get_funding_rate` | $0.002 | SOL + BTC perp funding, mark price, open interest (Hyperliquid) |
| `get_fear_greed` | **free** | Crypto Fear & Greed index |
| `get_market_snapshot` | $0.003 | Everything above in one call |
| `get_wallet_holdings` | $0.008 | Any Solana wallet: SOL, SPL tokens w/ USD values, NFT count |
| `get_token_metadata` | $0.005 | Any SPL mint: name, symbol, decimals, supply, price |
| `pricing` | **free** | This table, machine-readable |

Payments settle as USDC on Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), x402 v2, scheme `exact`.

## Try it free right now

```bash
curl https://x402.ochinimus.app/api/fear-greed
curl https://x402.ochinimus.app/          # full pricing index
```

## MCP quickstart (paying client)

```js
import { createx402MCPClient } from "@x402/mcp";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = createx402MCPClient({
  name: "my-agent", version: "1.0.0",
  schemes: [{ network: "solana:*", client: new ExactSvmScheme(toClientSvmSigner(mySigner)) }],
  autoPayment: true,
});
await client.connect(new StreamableHTTPClientTransport(new URL("https://x402.ochinimus.app/mcp")));
const price = await client.callTool("get_sol_price", {});
```

## HTTP quickstart (paying client)

```js
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "solana:*", client: new ExactSvmScheme(signer) }],
});
const res = await payFetch("https://x402.ochinimus.app/api/market-snapshot");
```

The agent's wallet needs USDC on Solana mainnet. No SOL required — gas is sponsored.

## Notes

- Rate limit: 10 req/min per caller.
- Prices/data are informational, not financial advice; sources: Pyth Hermes, Hyperliquid public API, alternative.me, Solana DAS.
- Built and operated by [seekdaseek](https://github.com/seekdaseek) · [ochinimus.app](https://ochinimus.app)
