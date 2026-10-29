# 在 NOFX（以及任何能设置请求头的机器人）中使用 AgentFeed

[NOFX](https://github.com/NoFxAiOS/nofx) 是一个开源 AI 交易终端。AgentFeed 为它的策略提供两个专为交易循环设计的接口，
用**预付费密钥**付费：密钥作为普通 HTTP 请求头发送，机器人本身无需支持 x402。

| 接口 | 返回内容 | 密钥价格 | x402 价格 |
|---|---|---|---|
| `GET /api/signal-board` | 按持仓量排序的全部 Hyperliquid 永续合约：标记价格、1 小时/24 小时涨跌、资金费率（每小时与年化）、持仓量（美元）及其 1 小时/24 小时变化、最近一小时多空爆仓额及其相对该币种自身 7 天基线的 z 值、Hyperliquid 前 250 大账户的净持仓与倾向、信号标记 | **$0.005** | $0.01 |
| `GET /api/coin-signal/<币种>` | 单个币种的同一行数据，另加 15 分钟爆仓级联概率、价格上方与下方最近的爆仓密集区（24 小时）、前 3 大巨鲸仓位 | **$0.002** | $0.004 |

建议每 1 至 5 分钟轮询一次；一次调用即可获得整个市场结构。所有数据均来自 AgentFeed 自有采集（每 5 分钟的 Hyperliquid
持仓量采样、自有爆仓数据库、每 5 分钟刷新的巨鲸快照），每个响应都注明数据来源及其 `as_of` 时间。数据源超过时效时返回
**503 并附 Retry-After，不收费**；任何 4xx 同样不收费。

## 请先阅读：NOFX 目前还不会拉取外部数据源

NOFX 会把外部数据源（External Data Sources）保存在策略中，但在提交 `ef476f2`（2026 年 10 月 13 日 `dev` 分支 HEAD）中，
**没有任何代码调用拉取它们的函数**（`kernel/engine.go` 中的 `StrategyEngine.FetchExternalData`：`git grep
FetchExternalData` 只能找到它的定义）。网页界面里也没有对应的表单。因此下面的两条配置会被接受并保存，但目前标准版 NOFX
不会把它们读入提示词。只有在决策循环中调用 `FetchExternalData` 的 NOFX 版本里，它们才会生效。响应格式已按该函数的代码验证，
见下文“验证”。

在此之前，同一个密钥可用于任何能发送请求头的程序：脚本、n8n、Freqtrade、Hummingbot，或 claw402 这样的网关。

## 1. 购买密钥

密钥是一笔余额，通过一次 x402 付款购买，可使用该接口 402 挑战中提供的任意 exact 通道（自 2026 年 10 月 14 日起：Solana、
Base、Polygon、Arbitrum、Arc、Optimism、Monad 与 Avalanche 上的 USDC，另有 11 个网络按需提供；购买密钥不提供高频的 batch 与 Gateway 通道）。套餐：**试用 $0.25**、
**$1**、**$5**、**$20**；充值 $5 与 $20。每次调用扣除该接口 x402 价格的一半（最低 $0.0005）。余额为使用额度：不可退款，
不会过期。密钥是持有即可使用的凭证：任何持有者都能消耗余额，滥用将被吊销。

### (a) 使用任意 x402 客户端，自己生成密钥（推荐）

你在本地生成密钥并保存，付款时只发送它的 sha256。AgentFeed 在你第一次使用之前从未见过密钥，付款后即使连接中断也不会丢失。

```bash
npm i @x402/fetch @x402/evm viem
```

```js
// buy-agentfeed-key.mjs：node buy-agentfeed-key.mjs 0x你的Base私钥
import fs from 'node:fs';
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (b) => { let x = BigInt('0x' + b.toString('hex')), s = ''; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; } return s; };
const key = 'afk_' + b58(crypto.randomBytes(32));
fs.writeFileSync('agentfeed.key', key + '\n', { mode: 0o600 });           // 付款前先保存
const hash = crypto.createHash('sha256').update(key).digest('hex');

const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.argv[2])) }] });
const res = await pay(`https://x402.ochinimus.app/api/keys/buy-trial?key_hash=${hash}&prefix=${key.slice(4, 12)}`);
console.log(res.status, (await res.json()).data);                         // { prefix, credit_usd, balance_usd, status: 'active', ... }
```

把 `buy-trial` 换成 `buy-1`、`buy-5` 或 `buy-20` 即可购买更大的套餐。不带 `key_hash` 时，服务器生成密钥并在 `data.key`
中**只返回一次**；请立即保存，之后不会再显示。

### (b) 使用 NOFX 已在用来支付 claw402 的钱包

NOFX 的新手引导会为 claw402 创建一个 Base USDC 钱包，并显示一次其私钥（“Private key, back it up now”；
`POST /api/onboarding/beginner` 会再次返回它，NOFX 还会把它以 `CLAW402_WALLET_KEY` 写入 `.env`）。如果你持有这个私钥，
把它传给 (a) 中的脚本即可：支付 claw402 的同一笔 USDC 就能购买 AgentFeed 密钥。

## 2. 添加两个外部数据源

NOFX 界面中没有这些配置的表单。它们位于策略 JSON 的 `config.ai_config.indicators.external_data_sources`，通过
`PUT /api/strategies/<id>`（NOFX 会合并你发送的字段）或 `POST /api/strategies` 写入：

```json
[
  {
    "name": "agentfeed_board",
    "type": "api",
    "url": "https://x402.ochinimus.app/api/signal-board?n=30",
    "method": "GET",
    "headers": { "X-AgentFeed-Key": "<你的密钥>" },
    "data_path": "data",
    "refresh_secs": 20
  },
  {
    "name": "agentfeed_btc",
    "type": "api",
    "url": "https://x402.ochinimus.app/api/coin-signal/BTC",
    "method": "GET",
    "headers": { "X-AgentFeed-Key": "<你的密钥>" },
    "data_path": "data",
    "refresh_secs": 20
  }
]
```

- `data_path: "data"` 用于拆开 AgentFeed 的 `{ tool, data, paid }` 外层结构。NOFX 的路径只能遍历对象，因此
  `data.coins` 是以币种为键的对象（按持仓量排序插入），`data.ranked` 是同一顺序的列表，`data.sources` 列出每个数据源及其 `as_of`。
- NOFX 把 `refresh_secs` 用作 HTTP 超时。AgentFeed 从缓存作答，远低于一秒；20 秒绰绰有余。
- `?coins=BTC,ETH,SOL`（最多 20 个）只返回你关注的币种；`?n=` 取 1 至 60（默认 30）。
- 币种使用 Hyperliquid 名称：`BTC`、`ETH`、`SOL`、`HYPE`、`kPEPE`（`1000PEPE` 和 `SOLUSDT` 也能识别）。未知币种返回 400
  并附支持列表，不收费。

### 信号标记的含义

| 标记 | 规则 |
|---|---|
| `crowded_long` | `funding_ann_pct >= 30` 且 `oi_chg_24h_pct >= 5` |
| `crowded_short` | `funding_ann_pct <= -10` 且 `oi_chg_24h_pct >= 5` |
| `squeeze_risk` | `crowded_short` 且（`chg_1h_pct >= 1`，或最近一小时空头爆仓 >= 多头爆仓的 2 倍且 >= $50k） |
| `liq_spike` | `liq_z >= 3` 且最近一小时爆仓 >= $50k |

`liq_z` =（最近 60 分钟爆仓美元额 − 该币种过去 168 个完整小时的每小时爆仓额中位数）/ max(1.4826 × MAD, $5,000)；
爆仓数据库从未记录过的币种为 null。`whale_tilt` =（多头美元 − 空头美元）/（多头 + 空头），基于 Hyperliquid 前 250 大账户，
取值 −1 到 1。Hyperliquid 资金费率按小时结算；`funding_ann_pct` = 费率 × 24 × 365 × 100。以上仅为参考信息，不构成投资建议。

## 3. 查询余额（免费）

```bash
curl -s https://x402.ochinimus.app/api/keys/balance -H "X-AgentFeed-Key: $(cat agentfeed.key)"
```

返回 `{ prefix, balance_usd, calls, spent_usd, last_used, rate_per_min, status }`。未知密钥返回 401。余额不足时调用返回
**402 JSON** `{ error: "key balance too low", balance_usd, price_usd, topup }`（不是 x402 挑战）；用 `/api/keys/topup-5`
或 `/api/keys/topup-20` 充值，付款方式同 (a)，并带上密钥请求头。每个密钥有独立的速率限制（默认每分钟 120 次）。

## 每个交易员的成本

按 NOFX 默认的 15 分钟扫描（每天 96 个周期）：信号表**每天 $0.48**，每个币种**每天 $0.19**。5 分钟扫描时为三倍：$1.44 与
$0.58。每 15 分钟读取信号表加两个币种的交易员每天花费 $0.86；$5 套餐约可用六天。

## 验证

AgentFeed 仓库中的 `ops/nofx-harness.mjs` 完全按 `ef476f2` 中 `fetchSingleExternalSource` 的逻辑（URL 校验、以
`refresh_secs` 作超时、`Header.Set`、不检查状态码、`json.Unmarshal`、只遍历对象的 `extractJSONPath`）用密钥请求线上接口，
并打印 NOFX 对每个数据源实际拿到的内容。

## 请求头

`X-AgentFeed-Key: afk_...` 或 `Authorization: Bearer afk_...`。带密钥请求头的请求永远不会进入 x402 流程：未知、待结算或已吊销的密钥
返回 401，并指向 `/api/keys/buy-5`。
