"""Step 3: build the cohort dataset. Features come only from the pools table (t0_* columns, dex, quote_mint,
name, pool_created_ts, t0_ts, cohort_reason). Labels are attached only as targets."""
import re
import numpy as np
import pandas as pd
from common import *

pools = load_pools(); labels = load_labels()
p = pools[pools.cohort == 1].copy()
for h in (1, 7):
    l = labels[labels.horizon_days == h].set_index("pool_id").label
    p[f"label{h}"] = p.id.map(l)
    p[f"y{h}"] = np.where(p[f"label{h}"].isin(RUG), 1.0, np.where(p[f"label{h}"].isin(OK_NOT_RUG), 0.0, np.nan))
p["dt"] = pd.to_datetime(p.t0_ts, unit="s", utc=True)
p["day"] = p.dt.dt.strftime("%Y-%m-%d")

# ---- numeric features
f = pd.DataFrame(index=p.index)
liq, vol, price, fdv, tx = p.t0_liquidity_usd, p.t0_volume24h_usd, p.t0_price_usd, p.t0_fdv_usd, p.t0_txns24h.astype(float)
f["log_liq"] = np.log1p(liq.clip(lower=0)); f["log_vol"] = np.log1p(vol.clip(lower=0))
f["log10_price"] = np.log10(price.where(price > 0)); f["log_fdv"] = np.log1p(fdv.clip(lower=0))
f["log_txns"] = np.log1p(tx.clip(lower=0))
f["liq_na"] = liq.isna().astype(float); f["fdv_na"] = fdv.isna().astype(float)
age_h = (p.t0_ts - p.pool_created_ts) / 3600.0
f["age_h_clip"] = age_h.clip(-1, 24 * 30); f["log_age"] = np.log1p(age_h.clip(lower=0))
f["hour"] = p.dt.dt.hour; f["wday"] = p.dt.dt.day_of_week
f["hour_sin"] = np.sin(2 * np.pi * f.hour / 24); f["hour_cos"] = np.cos(2 * np.pi * f.hour / 24)
for k in range(7): f[f"wd{k}"] = (f.wday == k).astype(float)
def lr(num, den):
    r = num / den.where(den > 0)
    return np.log1p(r.clip(0, 1e4))
f["liq_over_fdv"] = lr(liq, fdv); f["vol_over_liq"] = lr(vol, liq); f["txns_over_liq"] = lr(tx, liq)
# ---- name features (symbol is NULL on every cohort pool; use the base part of "BASE / QUOTE")
base = p.name.fillna("").str.split(" / ").str[0]
f["name_len"] = base.str.len(); f["name_digits"] = base.str.count(r"\d"); f["name_upper"] = base.str.count(r"[A-Z]")
f["name_lower"] = base.str.count(r"[a-z]"); f["name_nonascii"] = base.map(lambda s: sum(ord(c) > 127 for c in s))
f["name_space"] = base.str.count(r"\s"); f["name_punct"] = base.map(lambda s: sum((not c.isalnum()) and (not c.isspace()) and ord(c) < 128 for c in s))
f["name_allcaps"] = (base.str.len() > 0) & (base == base.str.upper()) & base.str.contains("[A-Z]"); f["name_allcaps"] = f.name_allcaps.astype(float)
f["name_startdigit"] = base.str.match(r"^\d").astype(float)
f["pair_name_len"] = p.name.fillna("").str.len()
# ---- categoricals; category lists come from the TRAIN window only
tr_mask = (p.day >= "2026-07-22") & (p.day <= "2026-09-23")
dex_cats = [d for d, n in p[tr_mask].dex.value_counts().items() if n >= 300]
quote_cats = {"So11111111111111111111111111111111111111112": "SOL", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC"}
q = p.quote_mint.map(quote_cats)
qother = p.quote_mint.where(q.isna())
top_q = [m for m, n in p[tr_mask & q.isna()].quote_mint.value_counts().items() if n >= 300]
for d in dex_cats: f[f"dex_{d}"] = (p.dex == d).astype(float)
f["dex_other"] = (~p.dex.isin(dex_cats)).astype(float)
for nm in ("SOL", "USDC"): f[f"q_{nm}"] = (q == nm).astype(float)
for m in top_q: f[f"q_{m[:6]}"] = (p.quote_mint == m).astype(float)
f["q_other"] = (q.isna() & ~p.quote_mint.isin(top_q)).astype(float)
reasons = ["liquidity>=5000", "volume>=1000", "late:liquidity>=5000", "late:volume>=1000"]
for r in reasons: f[f"reason_{r}"] = (p.cohort_reason == r).astype(float)
f["reason_other"] = (~p.cohort_reason.isin(reasons)).astype(float)

feat_cols = list(f.columns)
meta = p[["id", "base_mint", "t0_ts", "day", "dex", "label1", "label7", "y1", "y7", "t0_price_usd", "cohort_reason"]].copy()
ds = pd.concat([meta, f.astype(float)], axis=1)
ds.to_pickle(OUT / "dataset.pkl")
save_json("features.json", {"feature_cols": feat_cols, "dex_cats": dex_cats, "top_quote_other": top_q,
                            "forbidden_check": [c for c in feat_cols if any(k in c for k in ("label", "check", "authority", "supply"))]})

rates = {}
for h, y in ((1, "y1"), (7, "y7")):
    d = ds[ds[y].notna()]
    rates[h] = {"cohort_pools": int(len(ds)), "decided": int(len(d)), "dropped_unknown": int(len(ds) - len(d)),
                "base_rate_all": float(d[y].mean()),
                "base_rate_train": float(d[(d.day <= "2026-09-23")][y].mean()),
                "base_rate_test": float(d[(d.day >= "2026-10-01")][y].mean())}
save_json("base_rates.json", rates)
bydex = ds[ds.y1.notna()].groupby("dex").agg(n=("id", "size"), rug1d=("y1", "mean")).sort_values("n", ascending=False).head(8)
print(pd.DataFrame(rates).T); print(bydex); print(len(feat_cols), "features; forbidden hits:", [c for c in feat_cols if any(k in c for k in ("label", "check", "authority", "supply"))])
print("nulls per feature (top):"); print(f.isna().sum().sort_values(ascending=False).head(6))
