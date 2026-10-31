"""R23 T1, step 3: the PRODUCTION model. Same recipe as the validation model (HistGradientBoostingClassifier, the hyperparameters Phase 0b selected on its
validation window, seed 20261031), refit on ALL T3-labelled cohort pools up to the last fully labelled day. No mint split, no embargo, no held-out set:
this model has no out-of-time test; the accuracy claim rests on the validation model (02_validation.py).
Writes out/production-trees.json, out/production-summary.json, out/production-random-2000.csv and the parity fixture rows."""
import json, sqlite3, sys, warnings
import numpy as np, pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from common import *
warnings.filterwarnings("ignore")
SEED = 20261031
ds = pd.read_pickle(OUT / "dataset.pkl"); F = json.loads((OUT / "features.json").read_text()); feat = F["feature_cols"]
labels = load_labels(); checks = load_checks()
l1 = labels[labels.horizon_days == 1].copy()
l1["at_ts"] = l1.evidence.map(lambda x: json.loads(x).get("at_ts")); l1 = l1.dropna(subset=["at_ts"]).astype({"at_ts": "int64"})
c = checks.rename(columns={"ts": "at_ts"})[["pool_id", "at_ts", "price_usd"]]
px = l1[["pool_id", "at_ts"]].merge(c, on=["pool_id", "at_ts"]).rename(columns={"pool_id": "id", "price_usd": "price_24h"})
D = ds.merge(px[["id", "price_24h"]], on="id", how="left")
D["ret"] = np.where(D.price_24h.notna() & (D.t0_price_usd > 0), D.price_24h / D.t0_price_usd - 1, np.nan)
D["yt"] = np.where(D.ret.notna(), (D.ret <= -0.8).astype(float), np.nan)

# ---- the last fully labelled day: every pool of day d has had its 24h window and the 6h tolerance closed before the snapshot, i.e. d + 2 days <= snapshot
snap_day = pd.to_datetime(SNAPSHOT_TS, unit="s", utc=True)
days = sorted(D.day.unique())
cov = D.groupby("day").agg(pools=("id", "size"), labelled=("yt", lambda s: int(s.notna().sum())))
cov["frac"] = cov.labelled / cov.pools
med = float(cov.loc["2026-10-01":"2026-10-29"].frac.median())
print("labelled fraction, last 5 days:"); print(cov.tail(5)); print("median Oct 1-29:", round(med, 4))
last_full = max(d for d in days if pd.Timestamp(d, tz="UTC") + pd.Timedelta(days=2) <= snap_day)
print("last fully labelled day:", last_full, "snapshot", snap_day)
assert last_full == "2026-10-29", last_full
first_day = "2026-07-22"
Dd = D[D.yt.notna()]
prod = Dd[(Dd.day >= first_day) & (Dd.day <= last_full)]
print("n_train", len(prod), "positives", int(prod.yt.sum()), "base", round(float(prod.yt.mean()), 5), "days", prod.day.min(), prod.day.max())

val = json.loads((OUT / "validation-summary.json").read_text()); p = val["params"]
m = HistGradientBoostingClassifier(learning_rate=p["lr"], max_leaf_nodes=p["leaves"], min_samples_leaf=p["msl"], max_iter=p["iters"], l2_regularization=1.0, early_stopping=False, random_state=SEED).fit(prod[feat], prod.yt)

def export_trees(model):
    out = []
    for it in model._predictors:
        n = it[0].nodes; leaf = n["is_leaf"].astype(bool); assert not n["is_categorical"].any()
        out.append({"f": np.where(leaf, -1, n["feature_idx"]).astype(int).tolist(), "t": np.where(leaf, 0.0, n["num_threshold"]).tolist(),
                    "l": np.where(leaf, 0, n["left"]).astype(int).tolist(), "r": np.where(leaf, 0, n["right"]).astype(int).tolist(),
                    "v": n["value"].tolist(), "m": n["missing_go_to_left"].astype(int).tolist()})
    return out
assert m.n_trees_per_iteration_ == 1 and list(m.classes_) == [0.0, 1.0]
base_raw = float(np.asarray(m._baseline_prediction).ravel()[0])
json.dump({"baseline": base_raw, "trees": export_trees(m), "sklearn": sklearn.__version__, "n_trees": len(m._predictors), "feature_names": feat}, open(OUT / "production-trees.json", "w"), separators=(",", ":"))

# ---- in-sample decile cuts on the last 14 training days (recorded for comparison only; the frozen cuts of the model are the validation model's out-of-sample cuts)
last14 = prod[prod.day >= (pd.Timestamp(last_full) - pd.Timedelta(days=13)).strftime("%Y-%m-%d")]
s14 = m.predict_proba(last14[feat])[:, 1]
cuts_insample = [float(x) for x in np.quantile(s14, [i / 10 for i in range(1, 10)])]

# ---- which raw columns were never NULL on any cohort pool of the training window (the service refuses to score a pool where one is missing)
db = sqlite3.connect(f"file:{DB}?mode=ro&immutable=1", uri=True)
cand = ["t0_ts", "pool_created_ts", "t0_liquidity_usd", "t0_volume24h_usd", "t0_price_usd", "t0_fdv_usd", "t0_txns24h", "name", "dex", "quote_mint", "cohort_reason", "base_mint", "pool_address"]
ids = set(prod.id.astype(int))
nulls = {k: int(db.execute(f"select count(*) from pools where cohort=1 and t0_ts>=? and t0_ts<? and {k} is null", (int(pd.Timestamp(first_day, tz='UTC').timestamp()), int((pd.Timestamp(last_full, tz='UTC') + pd.Timedelta(days=1)).timestamp()))).fetchone()[0]) for k in cand}
nonpos_price = int(db.execute("select count(*) from pools where cohort=1 and (t0_price_usd is null or t0_price_usd<=0)").fetchone()[0])
print("null counts in the training window:", nulls, "| cohort pools with price null or <= 0:", nonpos_price)

# dex venues outside the frozen category list that already have >= 300 pools in the production window (information for the notes, the list is not changed)
cats = F["dex_cats"]
other = prod.assign(dex=prod.dex).loc[~prod.dex.isin(cats)].dex.value_counts()
print("venues outside the frozen dex list, production window:", other.head(6).to_dict())

# ---- parity material: 2,000 random cohort pools (any day, any label) for G1c, and the committed fixture
rng = np.random.default_rng(SEED + 2)
r2000 = np.sort(rng.choice(ds.id.to_numpy(), size=2000, replace=False))
sc = ds.set_index("id").loc[r2000]
pd.DataFrame({"id": r2000, "py": m.predict_proba(sc[feat])[:, 1]}).to_csv(OUT / "production-random-2000.csv", index=False, float_format="%.17g")

# fixture: 240 random pools plus 60 chosen for odd inputs (NULL liquidity, NULL fdv, non-ASCII or digit-led names, every dex of the frozen list, other quote mints, late reasons)
raw = pd.read_sql_query("select id,pool_address,base_mint,quote_mint,name,dex,pool_created_ts,t0_liquidity_usd,t0_volume24h_usd,t0_price_usd,t0_fdv_usd,t0_txns24h,t0_ts,cohort_reason from pools where cohort=1", db)
rng2 = np.random.default_rng(SEED + 3)
pick = set(rng2.choice(raw.id.to_numpy(), size=240, replace=False).tolist())
odd = []
def take(mask, k):
    ids_ = raw[mask].id.to_numpy(); odd.extend(rng2.choice(ids_, size=min(k, len(ids_)), replace=False).tolist())
take(raw.t0_liquidity_usd.isna(), 8); take(raw.t0_fdv_usd.isna(), 8); take(raw.name.map(lambda s: any(ord(ch) > 127 for ch in (s or ""))), 12)
take(raw.name.map(lambda s: bool(s) and s.split(" / ")[0][:1].isdigit()), 6); take(raw.name.map(lambda s: bool(s) and s.split(" / ")[0] == s.split(" / ")[0].upper() and any("A" <= ch <= "Z" for ch in s)), 4)
take(~raw.quote_mint.isin(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]), 8)
take(raw.cohort_reason.str.startswith("late:"), 6); take(raw.t0_liquidity_usd <= 0, 4)
for d in cats: take(raw.dex == d, 1)
take(~raw.dex.isin(cats), 4)
fx_ids = sorted(pick | set(int(i) for i in odd))
fx = raw[raw.id.isin(fx_ids)].sort_values("id")
sc_fx = ds.set_index("id").loc[fx.id]
fx_py = m.predict_proba(sc_fx[feat])[:, 1]
fixture = {"note": "constructed from rows of the LaunchLedger snapshot of 2026-10-31 (the t0 columns of cohort pools); py is sklearn predict_proba of the production model on features built by 03_dataset.py; feature_row is that builder's output for the row",
           "rows": [{**{k: (None if (isinstance(v, float) and np.isnan(v)) else v) for k, v in r.items()}} for r in fx.to_dict(orient="records")],
           "py": [float(x) for x in fx_py],
           "py_features": [[None if np.isnan(x) else float(x) for x in row] for row in sc_fx[feat].to_numpy()]}
for r in fixture["rows"]:
    for k in ("id", "pool_created_ts", "t0_txns24h", "t0_ts"):
        if r[k] is not None: r[k] = int(r[k])
json.dump(fixture, open(OUT / "parity-fixture.json", "w"), separators=(",", ":"), allow_nan=False)

json.dump({"n_train": int(len(prod)), "positives": int(prod.yt.sum()), "base_rate": float(prod.yt.mean()), "first_day": str(prod.day.min()), "trained_through_day": last_full,
           "params": p, "baseline_raw": base_raw, "n_trees": len(m._predictors), "sklearn": sklearn.__version__, "seed": SEED,
           "coverage_last5": cov.tail(5).reset_index().to_dict(orient="records"), "coverage_median_oct": med,
           "null_counts_training_window": nulls, "cohort_pools_price_null_or_nonpositive": nonpos_price,
           "venues_outside_frozen_list": {k: int(v) for k, v in other.head(8).items()},
           "decile_cuts_insample_last14d": cuts_insample, "n_last14d": int(len(last14)),
           "fixture_rows": int(len(fx)), "feature_names": feat}, open(OUT / "production-summary.json", "w"), indent=1)
print("production done")
