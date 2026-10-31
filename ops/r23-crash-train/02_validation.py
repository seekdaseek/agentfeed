"""R23 T1, step 2: re-run the Phase 0b T3 protocol (0b_score.py T3) in /Volumes/D/r23/t1 and export the VALIDATION model.

The protocol lines (24h price label, T3 target, splits, mint split, tuning grid, family choice, refit, test scoring) are copied from
/Volumes/D/launchledger-backtest/0b_score.py unchanged. Dropped because the export does not need them: the T4 branch, the baselines, the
permutation importance. Added: the export of the trees, of the October test scores, of the 2,000 held-out pools and of the decile cuts.
Refuses to run if GATES-0b.md changed (same check as the original)."""
import hashlib, itertools, json, math, sys, warnings
import numpy as np, pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from common import *
warnings.filterwarnings("ignore")
TARGET = "T3"
if hashlib.sha256((SRC / "GATES-0b.md").read_bytes()).hexdigest() != (SRC / "GATES-0b.sha256").read_text().strip():
    sys.exit("GATES-0b.md changed after registration - refusing to score")
SEED = 20261031
ds = pd.read_pickle(OUT / "dataset.pkl"); feat = json.loads((OUT / "features.json").read_text())["feature_cols"]
pools = load_pools(); labels = load_labels(); checks = load_checks()

# ---- 24h check behind the 1d label, price return
l1 = labels[labels.horizon_days == 1].copy()
l1["at_ts"] = l1.evidence.map(lambda x: json.loads(x).get("at_ts")); l1 = l1.dropna(subset=["at_ts"]).astype({"at_ts": "int64"})
c = checks.rename(columns={"ts": "at_ts"})[["pool_id", "at_ts", "price_usd"]]
px = l1[["pool_id", "at_ts"]].merge(c, on=["pool_id", "at_ts"]).rename(columns={"pool_id": "id", "price_usd": "price_24h"})
D = ds.merge(px[["id", "price_24h"]], on="id", how="left")
D["ret"] = np.where(D.price_24h.notna() & (D.t0_price_usd > 0), D.price_24h / D.t0_price_usd - 1, np.nan)
D["yt"] = np.where(D.ret.notna(), (D.ret <= -0.8).astype(float), np.nan)
TRAIN = ("2026-07-22", "2026-09-23"); TUNE_SPLIT = "2026-09-10"; TEST = ("2026-10-01", "2026-10-29")
WEEKS = [("W1", "2026-10-01", "2026-10-07"), ("W2", "2026-10-08", "2026-10-14"), ("W3", "2026-10-15", "2026-10-21"), ("W4", "2026-10-22", "2026-10-29")]
Dd = D[D.yt.notna()]
train_all = Dd[(Dd.day >= TRAIN[0]) & (Dd.day <= TRAIN[1])]
test = Dd[(Dd.day >= TEST[0]) & (Dd.day <= TEST[1])].copy()
test["week"] = [next((w for w, a, b in WEEKS if a <= d <= b), None) for d in test.day]
test_all = D[(D.day >= TEST[0]) & (D.day <= TEST[1])]
val_all = D[(D.day >= TUNE_SPLIT) & (D.day <= TRAIN[1])]

def split_mint(tr, win): return tr[~tr.base_mint.isin(set(win.base_mint))]
def mk_lr(C): return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=C, max_iter=3000))
def mk_hgb(lr, lv, msl, it): return HistGradientBoostingClassifier(learning_rate=lr, max_leaf_nodes=lv, min_samples_leaf=msl, max_iter=it, l2_regularization=1.0, early_stopping=False, random_state=SEED)
def metrics(y, s): return {"n": int(len(y)), "base": float(np.mean(y)), "roc_auc": float(roc_auc_score(y, s)), "pr_auc": float(average_precision_score(y, s)), "brier": float(brier_score_loss(y, np.clip(s, 0, 1)))}

# ---- tuning (same grid, same order)
fit0 = split_mint(train_all[train_all.day < TUNE_SPLIT], val_all); val = train_all[train_all.day >= TUNE_SPLIT]
tune = []
for C in (0.01, 0.1, 1.0, 10.0):
    tune.append(("lr", {"C": C}, roc_auc_score(val.yt, mk_lr(C).fit(fit0[feat], fit0.yt).predict_proba(val[feat])[:, 1])))
for lr_, lv, msl, it in itertools.product((0.05, 0.1), (15, 63), (50, 300), (150, 400)):
    tune.append(("hgb", {"lr": lr_, "leaves": lv, "msl": msl, "iters": it}, roc_auc_score(val.yt, mk_hgb(lr_, lv, msl, it).fit(fit0[feat], fit0.yt).predict_proba(val[feat])[:, 1])))
best = {f: max((t for t in tune if t[0] == f), key=lambda t: t[2]) for f in ("lr", "hgb")}
selected = max(best, key=lambda f: best[f][2])
assert selected == "hgb", selected
train = split_mint(train_all, test_all)
p = best["hgb"][1]
m = mk_hgb(p["lr"], p["leaves"], p["msl"], p["iters"]).fit(train[feat], train.yt)
s_test = m.predict_proba(test[feat])[:, 1]

# ---- compare with the original Phase 0b result file
orig = json.loads((SRC / "out" / "0b-results-T3.json").read_text())
yv = test.yt.to_numpy(); pos = np.arange(len(test))
groups = [("pooled", pos)] + [(w, pos[(test.week == w).to_numpy()]) for w, _, _ in WEEKS]
auc = {g: float(roc_auc_score(yv[ix], s_test[ix])) for g, ix in groups}
cmp = {"best_hgb_params_equal": orig["best"]["hgb"]["params"] == p,
       "val_auc_hgb_orig": orig["best"]["hgb"]["val_auc"], "val_auc_hgb_rerun": float(best["hgb"][2]),
       "n_train_equal": orig["n_train"] == int(len(train)), "n_test_equal": orig["n_test"] == int(len(test)), "n_train": int(len(train)), "n_test": int(len(test)),
       "auc_orig": orig["week_auc_selected"], "auc_rerun": auc,
       "max_abs_auc_diff": max(abs(auc[g] - orig["week_auc_selected"][g]) for g in auc),
       "tuning_max_abs_diff": max(abs(a["val_auc"] - float(t[2])) for a, t in zip(orig["tuning"], tune)),
       "tuning_params_equal": all(a["params"] == t[1] and a["family"] == t[0] for a, t in zip(orig["tuning"], tune))}
# the original script saved its own test predictions: compare score by score
try:
    op = pd.read_pickle(SRC / "out" / "0b-test-preds-T3.pkl")
    mm = test[["id"]].reset_index(drop=True).assign(py=s_test).merge(op[["id", "s_selected"]], on="id")
    cmp["pred_rows_matched"] = int(len(mm)); cmp["pred_max_abs_diff_vs_original"] = float(np.abs(mm.py - mm.s_selected).max())
except Exception as e:
    cmp["pred_compare_error"] = str(e)
print(json.dumps(cmp, indent=1))

# ---- export the validation model
def export_trees(model):
    out = []
    for it in model._predictors:
        assert len(it) == 1
        n = it[0].nodes
        leaf = n["is_leaf"].astype(bool)
        assert not n["is_categorical"].any()
        out.append({"f": np.where(leaf, -1, n["feature_idx"]).astype(int).tolist(), "t": np.where(leaf, 0.0, n["num_threshold"]).tolist(),
                    "l": np.where(leaf, 0, n["left"]).astype(int).tolist(), "r": np.where(leaf, 0, n["right"]).astype(int).tolist(),
                    "v": n["value"].tolist(), "m": n["missing_go_to_left"].astype(int).tolist()})
    return out
trees = export_trees(m)
assert m.n_trees_per_iteration_ == 1 and list(m.classes_) == [0.0, 1.0]
base_raw = float(np.asarray(m._baseline_prediction).ravel()[0])
json.dump({"baseline": base_raw, "trees": trees, "sklearn": sklearn.__version__, "n_trees": len(trees), "feature_names": feat}, open(OUT / "validation-trees.json", "w"), separators=(",", ":"))

# the October test scores (python predict_proba) with labels, for the JS AUC check
tt = test[["id", "day", "week", "yt"]].copy(); tt["py"] = s_test
tt.to_csv(OUT / "validation-test-scores.csv", index=False, float_format="%.17g")
# 2,000 held-out pools: fixed seed, drawn from the October test window (none of them is in the training set: mint split + time split)
rng = np.random.default_rng(SEED + 1)
ho = np.sort(rng.choice(tt.id.to_numpy(), size=2000, replace=False))
assert not set(ho) & set(train.id), "held-out pool inside the training set"
assert not set(test.base_mint[test.id.isin(ho)]) & set(train.base_mint), "held-out pool shares a mint with the training set"
tt[tt.id.isin(ho)].to_csv(OUT / "validation-heldout-2000.csv", index=False, float_format="%.17g")

# ---- deciles from the OUT-OF-SAMPLE October scores (pooled)
qs = [i / 10 for i in range(1, 10)]
cuts = [float(x) for x in np.quantile(s_test, qs)]
dec = 1 + (s_test[:, None] >= np.array(cuts)[None, :]).sum(axis=1)
dtab = pd.DataFrame({"d": dec, "y": yv, "p": s_test}).groupby("d").agg(n=("y", "size"), positives=("y", "sum"), rate=("y", "mean"), mean_pred=("p", "mean")).reset_index()
print(dtab.to_string())
json.dump({"auc": auc, "n_train": int(len(train)), "n_test": int(len(test)), "train_base": float(train.yt.mean()), "test_base": float(yv.mean()), "params": p,
           "decile_cuts": cuts, "decile_table": dtab.to_dict(orient="records"), "weekly_n": {g: int(len(ix)) for g, ix in groups},
           "weekly_base": {g: float(yv[ix].mean()) for g, ix in groups}, "compare_with_original": cmp, "baseline_raw": base_raw,
           "train_first_day": str(train.day.min()), "train_last_day": str(train.day.max())}, open(OUT / "validation-summary.json", "w"), indent=1)
print("validation done: pooled AUC", round(auc["pooled"], 5), {k: round(v, 5) for k, v in auc.items()})
