# ops/r23-crash-train: how the crash-risk model files were made (R23 T1, 31 Oct 2026)

Copies of the scripts that were run in `/Volumes/D/r23/t1/` (outputs in `/Volumes/D/r23/t1/out/`). They read the LaunchLedger snapshot `/Volumes/D/launchledger-backtest/ll-snap-20261031.db`
(sha256 `913ef75a1873ff1f044201d1bc433c1ba8d74d758f091ee51bbf094c36a2f879`, the decompressed `ll-snap-20261031.db.gz` whose sha256 is `3ed5f2be...447728d8`) read-only and immutable, and use the
Phase 0b virtual environment `/Volumes/D/launchledger-backtest/.venv/bin/python` (scikit-learn 1.9.1, numpy 2.5.4, pandas 3.1.0). Run from the directory that holds the scripts, in this order:

| script | does | writes (in `out/`) |
|---|---|---|
| `01_dataset.py` | `03_dataset.py` of Phase 0b, unchanged: the 57 features of every cohort pool | `dataset.pkl`, `features.json` (identical to the Phase 0b file), `base_rates.json` |
| `02_validation.py` | the Phase 0b T3 protocol (`0b_score.py T3`: same labels, splits, mint split, tuning grid, seed 20261031) and the export of the validation model | `validation-trees.json`, `validation-summary.json`, `validation-test-scores.csv`, `validation-heldout-2000.csv` |
| `03_production.py` | the same recipe refit on all T3-labelled cohort pools through the last fully labelled day (2026-10-29): the production model, its parity material and the fixture rows | `production-trees.json`, `production-summary.json`, `production-random-2000.csv`, `parity-fixture.json` |
| `04_tables.py` | the 24 values of `hour_sin` and `hour_cos` exactly as numpy computed them | `tables.json` |
| `05_full_scores.py` | refits both models again (asserts the trees are bit-identical to the first export) and writes scikit-learn's score for every cohort pool | `validation-all-scores.csv`, `production-all-scores.csv` |
| `06_weekly_reference.py` | per-ISO-week ROC AUC of the validation model's scores (env `CUTOFF=YYYY-MM-DD`), the reference for the weekly job | `weekly-reference.csv` |

Then, from the repository root:

```
node ops/r23-crash-build-model.js --kind production --trees <out>/production-trees.json --summary <out>/production-summary.json --validation <out>/validation-summary.json --features <out>/features.json --tables <out>/tables.json --out tools/r23/crash-model/model.json --meta tools/r23/crash-model/meta.json
node ops/r23-crash-build-model.js --kind validation ... --out <out>/validation-model.json
node ops/r23-crash-parity.js --model tools/r23/crash-model/model.json --db <copy of the snapshot> --csv <out>/production-all-scores.csv
node ops/r23-crash-e2e-snapshot.js --ledger <copy of the snapshot> --model <out>/validation-model.json --reference <out>/weekly-reference.csv --workdir <empty dir> --clock 2026-10-05T00:00:00Z
```

`common.py` differs from Phase 0b's only in paths (outputs to `./out`, the snapshot read in place with `immutable=1`).
