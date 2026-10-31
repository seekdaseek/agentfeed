"""R23 T1: the reference for the weekly AUC job. ROC AUC of the VALIDATION model's scikit-learn scores per ISO week (Monday UTC) of t0_ts, for the pools that entered after its
training window (from 2026-09-24), against the T3 outcome built exactly as 0b_score.py builds it. Independent of the JavaScript job: sklearn.metrics.roc_auc_score."""
import json
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score
from common import *
ds = pd.read_pickle(OUT / "dataset.pkl")
labels = load_labels(); checks = load_checks()
l1 = labels[labels.horizon_days == 1].copy()
l1["at_ts"] = l1.evidence.map(lambda x: json.loads(x).get("at_ts")); l1 = l1.dropna(subset=["at_ts"]).astype({"at_ts": "int64"})
c = checks.rename(columns={"ts": "at_ts"})[["pool_id", "at_ts", "price_usd"]]
px = l1[["pool_id", "at_ts"]].merge(c, on=["pool_id", "at_ts"]).rename(columns={"pool_id": "id", "price_usd": "price_24h"})
D = ds.merge(px[["id", "price_24h"]], on="id", how="left")
D["ret"] = np.where(D.price_24h.notna() & (D.t0_price_usd > 0), D.price_24h / D.t0_price_usd - 1, np.nan)
D["yt"] = np.where(D.ret.notna(), (D.ret <= -0.8).astype(float), np.nan)
sc = pd.read_csv(OUT / "validation-all-scores.csv").rename(columns={"py": "score"})
D = D.merge(sc, on="id")
import os
CUT = os.environ.get("CUTOFF", "2026-09-24")
D = D[(D.t0_ts >= pd.Timestamp(CUT, tz="UTC").timestamp()) & D.yt.notna()].copy()
dt = pd.to_datetime(D.t0_ts, unit="s", utc=True)
D["week"] = (dt - pd.to_timedelta(dt.dt.day_of_week, unit="D")).dt.strftime("%Y-%m-%d")
rows = [{"week_start": w, "n": int(len(g)), "positives": int(g.yt.sum()), "auc": float(roc_auc_score(g.yt, g.score))} for w, g in D.groupby("week")]
pd.DataFrame(rows).to_csv(OUT / "weekly-reference.csv", index=False, float_format="%.17g")
print(pd.DataFrame(rows).to_string())
