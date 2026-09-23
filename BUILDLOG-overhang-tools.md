# AgentFeed — overhang exit-liquidity tools

**Date:** 2026-09-02 · **Tree:** `/opt/agentfeed` (CommonJS, pm2 `agentfeed`)

## What was added

| tool | route | price | rail |
|---|---|---|---|
| `get_exit_quote` | `GET /api/exit-quote` | $0.02 | REST + MCP |
| `get_exit_method` | `GET /api/exit-method` | **free** | REST + MCP |

## Exact paths touched

| path | change |
|---|---|
| `tools/overhang.js` | **NEW.** Both handlers. Opens `/opt/overhang/overhang.db` `{ readonly: true, fileMustExist: true }`, exactly as `tools/liquidations.js` opens the liquidation tape. |
| `expansion.js` | `require('./tools/overhang')` + one `EXP` entry for the paid tool. |
| `mcp.js` | `require` + one `TOOL_DEFS` entry for the free tool (`usd: 0`). |
| `server.js` | free REST route `/api/exit-method`. |

Backups: `expansion.js.bak-20260902T134118Z`, `mcp.js.bak-20260902T134118Z`,
`server.js.bak-20260902T134118Z`.

## Where a tool must be registered — the answer

`expansion.js` is the single registration point for a **paid** tool. Its `EXP` array
derives `PRICES_ADD`, `TAGS_ADD`, `MCP_DEFS_ADD` and the express route, and
`payments.js` merges the first two (`Object.assign(PRICES, require('./expansion').PRICES_ADD)`),
`mcp.js` pushes the third, `server.js` calls `register(app, tool)`. So `/`, the landing
page and `/.well-known/x402.json` all pick it up automatically — they render from `PRICES`.

**Free tools follow a different path, and it matters.** Every existing `EXP` entry is
paid; there are no `usd: 0` entries. Free tools are deliberately kept **out of `PRICES`**
so the x402 middleware never sees a `$0` route — `/api/last-liquidation` is the precedent.
`get_exit_method` therefore goes into `mcp.js` `TOOL_DEFS` and `server.js` directly.
Verified: `PRICES['GET /api/exit-method']` is absent, `PRICES['GET /api/exit-quote']` is
present at 0.02.

## Data handling

- **Readonly.** Proven, not assumed — see below.
- **Gate.** `GATE_TS = 1786406400` is applied in every single query in the file.
- **Schema read off the live DB**, not from the brief. `reserves` carries the three
  columns added today (`mark_generated_at`, `floor_observation`, `corroboration`) and one
  view exists, `reserves_adjudicated`.
- The view **omits** `protocol`, `market`, `oracle_*`, `mark_generated_at`,
  `max_exitable_cons_usd` and the bonus band, and filters out rows carrying no observation
  (`measurement_failed`, `no_ladder`). So the handler `LEFT JOIN`s the view to `reserves`
  rather than reading the view alone — a plain join would silently drop answerable rows.
- The retroactive `not_tradable` / `no_route` split is taken **from the view**, not
  reimplemented.

## Response policy, as implemented

- `max_exitable_usd` is never a bare null.
- `*_unconfirmed` → falls back to the most recent corroborated row, returns
  `confidence: "last_corroborated"`, `measurement_age_sec`, and a
  `current_sample_withheld` block explaining why the current verdict was withheld.
- `not_tradable_any_size` → `max_exitable_usd: 0` with
  `exit_blocked.mechanism = "router_refusal"` and `is_liquidity_finding: false`, plus the
  wire reason. Explicitly distinct from `no_route_found`, which is flagged
  `is_liquidity_finding: true`.
- No corroborated measurement at all → `answer_available: false` with a reason string.
- `nearest_measured_clip` returns the clip the bisection **actually probed**, with
  `is_exact_match`, the full list of measured clips, and a note naming the measured clip.
  Never interpolated.

## Verified, and how

- **Readonly proven.** Four write verbs against the exact handle:
  `INSERT` / `UPDATE` / `DELETE` / `DROP VIEW` → all `attempt to write a readonly database`;
  `db.readonly === true`.
- **Both tools called live against the running service.** `get_exit_method` free over
  HTTP; `get_exit_quote` paid twice with real mainnet USDC via `test-client.mjs`'s scheme
  (settled txs recorded), for a `partial` symbol (SPYx, `size_usd=400000`) and a
  `not_tradable` symbol (FWDI).
- **Restart done correctly:** `pm2 delete agentfeed && pm2 start server.js --name agentfeed && pm2 save`
  from `/opt/agentfeed`. Never `pm2 restart` (dotenv). Start command derived from
  `pm2 jlist` (script `/opt/agentfeed/server.js`, cwd `/opt/agentfeed`, fork, no args) —
  there is no ecosystem file.
- **No regression:** boot line reports `45 paid + 6 free`; pre-existing free tool
  (`get_last_liquidation`) and pre-existing **paid** tool (`get_sol_price`, settled on
  mainnet) both returned 200.
- **No secret printed.** The payer keypair was only length-checked (64 bytes).

## The one thing that could not be demonstrated live

**The live tape contains ZERO `*_unconfirmed` rows** (`SELECT COUNT(*) ... WHERE status
LIKE '%unconfirmed'` → 0), and zero NULL `max_exitable_usd` in the gated window. So the
fallback branch could not be shown against real data, and none was manufactured in the
tape.

To avoid shipping an entirely untested branch, `DB_PATH` was made overridable
(`OVERHANG_DB_PATH`, default unchanged, still `readonly` + `fileMustExist` so an override
cannot grant writes) and the **real handler** was run against a throwaway `/tmp` copy with
one synthetic `no_route_unconfirmed` row injected. It returned
`confidence: "last_corroborated"`, `max_exitable_usd: 553514`, `measurement_age_sec: 663`
and the `current_sample_withheld` block. The live tape was not touched and still reports 0.

That is a code-path test on a copy, **not** evidence from the tape. What would test it for
real: wait for the collector to produce an `*_unconfirmed` row (none in 26,016 rows so far,
so this may be rare) and re-call `get_exit_quote` for that symbol.
