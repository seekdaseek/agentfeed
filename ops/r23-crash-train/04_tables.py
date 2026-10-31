"""R23 T1: the 24 values of hour_sin and hour_cos exactly as numpy computed them in 03_dataset.py. Hours h and 24-h are equal in exact arithmetic but differ in the
last digit under numpy's sin/cos, and the trees split between those values; JavaScript's Math.sin rounds some of them differently, so the table is frozen in the model file."""
import json, numpy as np, pandas as pd
ds = pd.read_pickle("out/dataset.pkl")
h = pd.Series(np.arange(24))
tab = {"hour_sin": np.sin(2 * np.pi * h / 24).tolist(), "hour_cos": np.cos(2 * np.pi * h / 24).tolist()}
for col in ("hour_sin", "hour_cos"):
    per = ds.groupby("hour")[col].nunique()
    assert (per == 1).all(), (col, per[per != 1])
    got = ds.groupby("hour")[col].first().sort_index()
    assert len(got) == 24 and all(float(got.loc[i]) == tab[col][i] for i in range(24)), col
    print(col, "table equals the dataset column for every hour; distinct values:", len(set(tab[col])))
json.dump(tab, open("out/tables.json", "w"))
