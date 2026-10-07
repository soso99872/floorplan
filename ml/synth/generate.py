"""產生訓練資料:ResPlan 每份格局隨機畫一張,切成 512×512 的小塊存檔(圖 JPG、標註 PNG)。

  cd ml && .venv/Scripts/python -m synth.generate --out data/synth --plans 17000 --workers 14
最後 VAL_PLANS 份格局留給驗證集,訓練時看不到。每份格局用固定種子,重跑結果一樣。
"""
import argparse
import math
import random
import time
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np

TILE = 512
VAL_PLANS = 600
_DATA = None


def _init():
    global _DATA
    from .plans import load_resplan
    _DATA = load_resplan()


def crops(img, label, rng, max_n=3):
    """切出最多 max_n 塊 TILE×TILE;太小的圖補紙張底色。"""
    h, w = label.shape
    if h < TILE or w < TILE:
        ph, pw = max(0, TILE - h), max(0, TILE - w)
        top, left = rng.randint(0, ph), rng.randint(0, pw)
        paper = tuple(int(c) for c in np.median(img[:4].reshape(-1, 3), axis=0))
        img = cv2.copyMakeBorder(img, top, ph - top, left, pw - left, cv2.BORDER_CONSTANT, value=paper)
        label = cv2.copyMakeBorder(label, top, ph - top, left, pw - left, cv2.BORDER_CONSTANT, value=0)
        h, w = label.shape
    n = min(max_n, math.ceil(h * w / TILE ** 2))
    out = []
    for _ in range(n):
        for _try in range(6):
            y, x = rng.randint(0, h - TILE), rng.randint(0, w - TILE)
            lab = label[y:y + TILE, x:x + TILE]
            if (lab > 0).mean() > 0.01:
                break
        out.append((img[y:y + TILE, x:x + TILE], lab))
    return out


def work(args):
    idx, out_dir = args
    from .plans import from_resplan
    from .render import render
    try:
        plan = from_resplan(_DATA[idx])
        img, label, st = render(plan, seed=idx)
    except Exception as e:  # 少數格局幾何有問題,略過
        return idx, 0, repr(e)[:80]
    split = "val" if idx >= len(_DATA) - VAL_PLANS else "train"
    rng = random.Random(idx)
    n = 0
    for k, (im, lab) in enumerate(crops(img, label, rng)):
        name = f"{idx:05d}_{k}"
        cv2.imwrite(str(out_dir / split / "img" / f"{name}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 95])
        cv2.imwrite(str(out_dir / split / "lab" / f"{name}.png"), lab)
        n += 1
    return idx, n, st["wall"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/synth")
    ap.add_argument("--plans", type=int, default=17000, help="用前 N 份訓練格局(驗證格局一律全用)")
    ap.add_argument("--workers", type=int, default=14)
    a = ap.parse_args()
    out = Path(a.out)
    for split in ("train", "val"):
        for kind in ("img", "lab"):
            (out / split / kind).mkdir(parents=True, exist_ok=True)
    total = 17000
    ids = list(range(min(a.plans, total - VAL_PLANS))) + list(range(total - VAL_PLANS, total))
    t0 = time.time()
    tiles, failed = 0, 0
    with Pool(a.workers, initializer=_init) as pool:
        for i, (idx, n, info) in enumerate(pool.imap_unordered(work, [(i, out) for i in ids], chunksize=8)):
            tiles += n
            failed += n == 0
            if (i + 1) % 1000 == 0:
                print(f"{i + 1}/{len(ids)} 份格局,{tiles} 塊,失敗 {failed},{time.time() - t0:.0f}s", flush=True)
    print(f"完成:{tiles} 塊(失敗 {failed} 份),{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
