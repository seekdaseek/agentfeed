# ledger-score

Scores each new LaunchLedger cohort pool once, at entry, from its frozen `t0_*` columns, and keeps the score in its own SQLite file.
A plain Node process; the one dependency is `better-sqlite3` (same major version as `/opt/launchledger`).

The score is a gradient-boosted decision-tree model's estimate of the chance that the pool's price at its 24 hour check is at least 80 percent below its price at entry. It ranks new pools; it is not a recommendation.

**Where its output may go.** The scores are derived from LaunchLedger data, which is GeckoTerminal data. The service runs on the box and writes only its own file. Nothing outside the box serves that file unless the owner decides so (the three HTTP routes in `tools/r23/crash-risk.js` are switched off unless `R23_CRASH_ROUTES=on`).

## What it reads and writes

| | |
|---|---|
| reads `LEDGER_DB` (default `/opt/launchledger/launchledger.db`) | opened `{ readonly: true, fileMustExist: true }` with `PRAGMA query_only = ON`, `busy_timeout 5000`. Never written (tested: sha256 before and after, and a write through the handle throws). Columns are named, so extra columns and tables are harmless. |
| writes `LEDGER_SCORE_DB` (default `/opt/launchledger-score/scores.db`) | `scores`, `auc_weekly`, `meta`, `skipped` (`tools/r23/crash-model/schema.js`). Nothing else on disk. |

`pools` columns read: `id, pool_address, base_mint, quote_mint, name, dex, pool_created_ts, t0_liquidity_usd, t0_volume24h_usd, t0_price_usd, t0_fdv_usd, t0_txns24h, t0_ts, cohort_reason` (and `cohort`, `retired` in the WHERE). The on-chain enrichment columns and `holders_t0` are not used.

## Why scoring at any time gives the same number

LaunchLedger writes the `t0_*` columns once, at discovery (`INSERT OR IGNORE`, `lib/db.mjs upsertPool`), and never updates them. `promoteToCohort` changes only `cohort`, `cohort_ts`, `cohort_reason` and `t0_ts`, once (`WHERE cohort=0`). The score is a function of those columns, so a pool scored a minute after entry and a pool scored after downtime get the number they would have had at entry. What differs is whether it was *scored at entry*: `scored_ts - t0_ts` is stored, and only pools scored within `SCORE_ENTRY_LAG_SEC` (1800) of entry count in the weekly track record.
For a pool promoted late (`cohort_reason` starts `late:`), `t0_ts` is the promotion time while the `t0_*` numbers are the discovery-time ones, up to 48 hours older; the model was trained on exactly that.

## Behaviour

- **Tick** every 60 s (`SCORE_INTERVAL_MS`), 1 s while a backlog is draining (`SCORE_CATCHUP_MS`). One tick scores at most 500 pools (`SCORE_BATCH`, hard cap 500), newest first, in one transaction. `scores.pool_id` is the primary key: a pool is never scored twice, a crash loses nothing (the batch rolls back whole) and a restart picks up the rest.
- **What a tick reads.** The pools of the last 6 hours always (about 650 rows), then, only while a backlog exists, the older part of the 7-day window from a saved position. An idle tick reads about 650 rows. A gap of more than 3 hours since the last tick, or a different `SCORE_BACKFILL_DAYS`, starts again from the top.
- **Window.** Pools whose `t0_ts` is within `SCORE_BACKFILL_DAYS` (7) of now. Older pools are never scored.
- **A pool is skipped, counted and never scored with an invented value** when `t0_price_usd` is missing or not positive, or one of `model.required_columns` is NULL (the columns that were never NULL on any training pool). Skips are in table `skipped` and `meta.skipped_total`. A NULL `t0_liquidity_usd` or `t0_fdv_usd` is not a skip: the model has flags for it and was trained with such pools.
- **Daily job** (at the first tick after a start if the last run is older than 24 hours, then every 24 hours): the live decile boundaries, then the weekly AUC and decile hit rates per ISO week of `t0_ts` and per model version, for the last `SCORE_AUC_WEEKS` (8) weeks. Outcome = `price at the 24 hour check / t0_price_usd - 1 <= -0.8`, found as `0b_score.py` finds it: `labels` row `horizon_days = 1` -> `evidence.at_ts` -> the `checks` row at that ts. A pool counts only if it was scored at entry, entered after its model's training window, and its outcome check came after it was scored. A week with fewer than 200 resolved pools (`SCORE_AUC_MIN_RESOLVED`), no positive or no negative has `auc` NULL (`n` and `positives` are still written).
- **Decile.** 1 lowest, 10 highest. `meta.frozen:<model_version>` holds the boundaries frozen in the model file (out-of-sample scores). Once the service has 2,000 scores of its own from the last 14 days (at entry, after the training window) it writes `meta.live:<model_version>` daily and the routes use those (`decile_basis: "live-14d"`), else `"frozen"`.
- **Heartbeat for the routes.** `meta.last_tick_ts` (written every successful tick), `meta.ledger_last_cycle` (a copy of launchledger's `meta.last_cycle`), `meta.current_model`, `meta.model:<version>`. A failed tick writes `meta.last_error` and `meta.last_error_ts`, drops the launchledger handle and retries on the next tick.

## Deploy (the box)

```
mkdir -p /opt/launchledger-score
rsync -a ledger-score/ /opt/launchledger-score/
rsync -a tools/r23/crash-model/ /opt/launchledger-score/crash-model/
cd /opt/launchledger-score && npm install --omit=dev      # better-sqlite3 ^11.10.0, no lock file
pm2 start score.js --name ledger-score --cwd /opt/launchledger-score
pm2 save
```

Environment (all optional): `LEDGER_DB`, `LEDGER_SCORE_DB`, `SCORE_INTERVAL_MS`, `SCORE_CATCHUP_MS`, `SCORE_BATCH`, `SCORE_BACKFILL_DAYS`, `SCORE_ENTRY_LAG_SEC`, `SCORE_AUC_MIN_RESOLVED`, `SCORE_AUC_WEEKS`, `SCORE_LIVE_CUTS_MIN`, `SCORE_LIVE_CUTS_DAYS`, `CRASH_MODEL_DIR` (default `./crash-model`, else `../tools/r23/crash-model`), `CRASH_MODEL_FILE`. PM2 freezes the environment at the first start: after changing one, `pm2 delete ledger-score && pm2 start ... && pm2 save`.

The service needs `crash-model/` next to `score.js`: `evaluator.js`, `features.js`, `metrics.js`, `schema.js`, `constants.js`, `model.json`. `model.json` carries its own version (the hash of its trees); a file that was edited does not load.

## Operations

- **A new model**: replace `crash-model/model.json` and restart. New pools get the new `model_version`; old rows keep theirs; the weekly job keeps one row per (week, model version).
- **Score the skipped pools again** after fixing their data: `DELETE FROM skipped; DELETE FROM meta WHERE k = 'scan';` in `scores.db`, then wait one tick.
- **Reset everything**: stop the process, delete `scores.db*`, start it. The first run scores the last 7 days again; those rows are not "scored at entry" and do not count in the track record.

## Known limits

- A pool written to launchledger more than 6 hours after its `t0_ts` while no backlog is draining and no restart happened is not found (launchledger writes `t0_ts` at the start of its cycle and the row minutes later; promoted pools get `t0_ts` = the promotion cycle).
- If launchledger changes a column the model reads (rename, drop), ticks fail loudly (`meta.last_error`), nothing is written, and scoring resumes when the column is back.
- The model ages. The validation model's AUC on later weeks fell from 0.97 to 0.92 over six weeks (notes-T1.md); the daily job is the monitor.
