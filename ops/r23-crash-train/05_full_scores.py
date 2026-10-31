"""R23 T1: refit the validation and production models again (same code path as 02/03), check the exported trees are bit-identical to the files already written
(the recipe is reproducible), and write sklearn predict_proba for EVERY cohort pool of the snapshot, for the JavaScript parity check on the whole population."""
import json, warnings
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from common import *
warnings.filterwarnings("ignore")
SEED = 20261031
ds = pd.read_pickle(OUT / "dataset.pkl"); feat = json.loads((OUT / "features.json").read_text())["feature_cols"]
labels = load_labels(); checks = load_checks()
l1 = labels[labels.horizon_days == 1].copy()
l1["at_ts"] = l1.evidence.map(lambda x: json.loads(x).get("at_ts")); l1 = l1.dropna(subset=["at_ts"]).astype({"at_ts": "int64"})
c = checks.rename(columns={"ts": "at_ts"})[["pool_id", "at_ts", "price_usd"]]
px = l1[["pool_id", "at_ts"]].merge(c, on=["pool_id", "at_ts"]).rename(columns={"pool_id": "id", "price_usd": "price_24h"})
D = ds.merge(px[["id", "price_24h"]], on="id", how="left")
D["ret"] = np.where(D.price_24h.notna() & (D.t0_price_usd > 0), D.price_24h / D.t0_price_usd - 1, np.nan)
D["yt"] = np.where(D.ret.notna(), (D.ret <= -0.8).astype(float), np.nan)
Dd = D[D.yt.notna()]
p = json.loads((OUT / "validation-summary.json").read_text())["params"]
mk = lambda: HistGradientBoostingClassifier(learning_rate=p["lr"], max_leaf_nodes=p["leaves"], min_samples_leaf=p["msl"], max_iter=p["iters"], l2_regularization=1.0, early_stopping=False, random_state=SEED)
def export(model):
    out = []
    for it in model._predictors:
        n = it[0].nodes; leaf = n["is_leaf"].astype(bool)
        out.append({"f": np.where(leaf, -1, n["feature_idx"]).astype(int).tolist(), "t": np.where(leaf, 0.0, n["num_threshold"]).tolist(), "l": np.where(leaf, 0, n["left"]).astype(int).tolist(),
                    "r": np.where(leaf, 0, n["right"]).astype(int).tolist(), "v": n["value"].tolist(), "m": n["missing_go_to_left"].astype(int).tolist()})
    return out
TRAIN = ("2026-07-22", "2026-09-23"); TEST = ("2026-10-01", "2026-10-29")
train_all = Dd[(Dd.day >= TRAIN[0]) & (Dd.day <= TRAIN[1])]; test_all = D[(D.day >= TEST[0]) & (D.day <= TEST[1])]
val_train = train_all[~train_all.base_mint.isin(set(test_all.base_mint))]
prod_train = Dd[(Dd.day >= "2026-07-22") & (Dd.day <= "2026-10-29")]
res = {}
for name, tr in (("validation", val_train), ("production", prod_train)):
    m = mk().fit(tr[feat], tr.yt)
    old = json.loads((OUT / f"{name}-trees.json").read_text())
    same = export(m) == old["trees"] and float(np.asarray(m._baseline_prediction).ravel()[0]) == old["baseline"]
    res[name] = {"n_train": int(len(tr)), "trees_bit_identical_to_first_export": bool(same)}
    pd.DataFrame({"id": ds.id.to_numpy(), "py": m.predict_proba(ds[feat])[:, 1]}).to_csv(OUT / f"{name}-all-scores.csv", index=False, float_format="%.17g")
print(json.dumps(res, indent=1)); json.dump(res, open(OUT / "05_full_scores.json", "w"), indent=1)
