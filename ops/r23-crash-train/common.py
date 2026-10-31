"""Shared helpers for the LaunchLedger Phase-0 backtest."""
import json
import os
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

# R23 T1 copy of /Volumes/D/launchledger-backtest/common.py: same logic; only the paths differ (outputs go to /Volumes/D/r23/t1/out, the snapshot is read in place, immutable, never written).
HERE = Path(__file__).resolve().parent
SRC = Path("/Volumes/D/launchledger-backtest")
DB = SRC / "ll-snap-20261031.db"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

TOL_SEC = 6 * 3600          # CHECK_TOLERANCE_HOURS=6 (VPS .env)
LP_DROP, LP_FLOOR = 90.0, 1000.0
COLLAPSE_DROP = 70.0
INACTIVE_VOL = 100.0
ACTIVE_VOL, ACTIVE_RETAIN = 1000.0, 50.0
HORIZONS = (1, 7, 30, 90)
RUG = ("lp_removed", "liquidity_collapsed")
OK_NOT_RUG = ("active", "inactive")

SNAPSHOT_TS = int(pd.Timestamp(open(SRC / "snapshot-time.txt").read().strip()).timestamp())


def connect():
    return sqlite3.connect(f"file:{DB}?mode=ro&immutable=1", uri=True)


def load_pools():
    with connect() as c:
        return pd.read_sql_query("select * from pools", c)


def load_checks():
    with connect() as c:
        df = pd.read_sql_query("select * from checks order by pool_id, ts", c)
    return df


def load_labels():
    with connect() as c:
        return pd.read_sql_query("select * from labels", c)


def day(ts):
    return pd.to_datetime(ts, unit="s", utc=True).dt.strftime("%Y-%m-%d")


def label_at_horizon(t0, t0_liq, ts, liq, vol, ok, horizon_days):
    """Faithful port of labelAtHorizon in /opt/launchledger/lib/label.mjs.

    ts/liq/vol/ok are the pool's checks sorted by ts (numpy arrays, NaN = null).
    Returns (label, at_ts, observations).
    """
    cut = t0 + int(round(horizon_days * 86400))
    m = (ts >= t0) & (ts <= cut)
    n_in = int(m.sum())
    if n_in == 0:
        return "unknown", None, 0
    w_ts, w_liq, w_vol, w_ok = ts[m], liq[m], vol[m], ok[m]
    late = w_ts >= cut - TOL_SEC
    if not late.any():
        return "unknown", None, n_in
    li = np.nonzero(late)[0][-1]
    last_ts = int(w_ts[li])
    if not w_ok[li]:
        return "unresolvable", last_ts, n_in
    vals = w_liq[~np.isnan(w_liq)]
    cand = list(vals)
    if t0_liq is not None and not (isinstance(t0_liq, float) and np.isnan(t0_liq)):
        cand.append(float(t0_liq))
    peak = max(cand) if cand else None
    liq_now = None if np.isnan(w_liq[li]) else float(w_liq[li])
    vol_now = None if np.isnan(w_vol[li]) else float(w_vol[li])
    if peak is None or liq_now is None:
        return "unknown", last_ts, n_in
    drop = ((peak - liq_now) / peak) * 100 if peak > 0 else 0.0
    retain = (liq_now / peak) * 100 if peak > 0 else 0.0
    if drop >= LP_DROP and liq_now < LP_FLOOR:
        return "lp_removed", last_ts, n_in
    if drop >= COLLAPSE_DROP:
        return "liquidity_collapsed", last_ts, n_in
    if vol_now is not None and vol_now < INACTIVE_VOL:
        return "inactive", last_ts, n_in
    if retain >= ACTIVE_RETAIN and vol_now is not None and vol_now >= ACTIVE_VOL:
        return "active", last_ts, n_in
    return "unknown", last_ts, n_in


def save_json(name, obj):
    (OUT / name).write_text(json.dumps(obj, indent=1, default=str))


def md_table(df, floatfmt="{:.4f}"):
    cols = list(df.columns)
    lines = ["| " + " | ".join(map(str, cols)) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for _, r in df.iterrows():
        cells = []
        for v in r:
            if isinstance(v, (float, np.floating)):
                cells.append("" if np.isnan(v) else floatfmt.format(v))
            else:
                cells.append(str(v))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)
