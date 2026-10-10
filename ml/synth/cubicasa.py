"""把 CubiCasa5k 訓練集轉成和 synth.generate 相同格式的小塊(圖 JPG、標註 PNG),給「自用版」微調用。

CubiCasa5k 是 CC BY-NC:只能非商業自用。用它訓練出來的模型不進 git、不對外發布(見 ml/README.md)。
評估用的是 CubiCasa 的驗證集(eval/data/cubicasa5k_valid.parquet),這裡只讀訓練集,兩邊不重疊。

  cd ml && .venv/Scripts/python -m synth.cubicasa --out data/cubicasa_tiles --workers 4
"""
import argparse
import random
import time
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np
import pyarrow.parquet as pq

from .generate import TILE
from .render import DOOR, WALL, WINDOW

SRC = Path(__file__).resolve().parent.parent / "data" / "cubicasa"
CAT = {"door": 3, "wall": 7, "window": 8}
# 和 backend/floorplan/ml.py 一樣:長邊縮放到這個範圍,牆的粗細才會和推論時一致
MIN_SIDE, MAX_SIDE = 768, 1600
STEP = 384
VAL_EVERY = 20  # 每 20 張留 1 張當驗證


def polys_of(ann, cat):
    out = []
    for c, seg in zip(ann["category_id"], ann["segmentation"]):
        if c == cat:
            for flat in seg:
                pts = np.array(flat, np.float32).reshape(-1, 2)
                if len(pts) >= 3:
                    out.append(pts)
    return out


def door_gap(wall, poly):
    """CubiCasa 的門框住整個開門範圍;合成資料只標牆上的開口。
    CubiCasa 的牆多半直接穿過門,少數會斷開;把牆沿水平 / 垂直方向閉合補起缺口,門只留下落在牆線上的那段。"""
    h, w = wall.shape
    x0, y0 = np.floor(poly.min(0)).astype(int)
    x1, y1 = np.ceil(poly.max(0)).astype(int)
    L = int(max(x1 - x0, y1 - y0)) + 6
    m = L + 4
    X0, Y0, X1, Y1 = max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m)
    if X1 <= X0 or Y1 <= Y0:
        return None
    sub = wall[Y0:Y1, X0:X1]
    closed = cv2.morphologyEx(sub, cv2.MORPH_CLOSE, np.ones((1, L), np.uint8)) | \
        cv2.morphologyEx(sub, cv2.MORPH_CLOSE, np.ones((L, 1), np.uint8))
    inside = np.zeros_like(sub)
    cv2.fillPoly(inside, [np.round(poly - (X0, Y0)).astype(np.int32)], 1)
    gap = (closed > 0) & (inside > 0)
    return (Y0, X0, gap) if gap.any() else None


def label_of(ann, h, w, scale):
    lab = np.zeros((h, w), np.uint8)
    for p in polys_of(ann, CAT["wall"]):
        cv2.fillPoly(lab, [np.round(p * scale).astype(np.int32)], WALL)
    wall = (lab == WALL).astype(np.uint8)
    for p in polys_of(ann, CAT["door"]):
        g = door_gap(wall, p * scale)
        if g:
            y, x, gap = g
            lab[y:y + gap.shape[0], x:x + gap.shape[1]][gap] = DOOR
    for p in polys_of(ann, CAT["window"]):  # 窗本來就畫在牆線上
        cv2.fillPoly(lab, [np.round(p * scale).astype(np.int32)], WINDOW)
    return lab


def tiles(img, lab):
    h, w = lab.shape
    if h < TILE or w < TILE:
        ph, pw = max(0, TILE - h), max(0, TILE - w)
        img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        lab = cv2.copyMakeBorder(lab, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=0)
        h, w = lab.shape
    ys = sorted(set(list(range(0, h - TILE + 1, STEP)) + [h - TILE]))
    xs = sorted(set(list(range(0, w - TILE + 1, STEP)) + [w - TILE]))
    for y in ys:
        for x in xs:
            l = lab[y:y + TILE, x:x + TILE]
            if (l > 0).mean() > 0.01:
                yield img[y:y + TILE, x:x + TILE], l


def work(args):
    path, group, out_dir = args
    table = pq.ParquetFile(path).read_row_group(group, columns=["image", "annotations"])
    n = 0
    for i in range(table.num_rows):
        key = f"{Path(path).stem}_{group}_{i:03d}"
        split = "val" if random.Random(key).randrange(VAL_EVERY) == 0 else "train"
        try:
            data = table.column("image")[i].as_py()["bytes"]
            ann = table.column("annotations")[i].as_py()
            im = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            h0, w0 = im.shape[:2]
            scale = float(np.clip(max(h0, w0), MIN_SIDE, MAX_SIDE)) / max(h0, w0)
            if scale != 1:
                im = cv2.resize(im, (round(w0 * scale), round(h0 * scale)),
                                interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
            lab = label_of(ann, im.shape[0], im.shape[1], scale)
        except Exception:  # 少數圖壞掉,略過
            continue
        for k, (ti, tl) in enumerate(tiles(im, lab)):
            # 檔名前面加 c,和合成資料混在一起時也不會撞名
            cv2.imwrite(str(out_dir / split / "img" / f"c{key}_{k}.jpg"), ti, [cv2.IMWRITE_JPEG_QUALITY, 95])
            cv2.imwrite(str(out_dir / split / "lab" / f"c{key}_{k}.png"), tl)
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/cubicasa_tiles")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    out = Path(a.out)
    for s in ("train", "val"):
        for d in ("img", "lab"):
            (out / s / d).mkdir(parents=True, exist_ok=True)
    jobs = []
    for path in sorted(SRC.glob("train-*.parquet")):
        # 一個工作讀一個 row group(約 240 張、100 MB),記憶體才不會爆
        jobs += [(str(path), g, out) for g in range(pq.ParquetFile(path).num_row_groups)]
    t0, total = time.time(), 0
    with Pool(a.workers) as pool:
        for k, n in enumerate(pool.imap_unordered(work, jobs)):
            total += n
            print(f"{k + 1}/{len(jobs)} 批,{total} 塊,{time.time() - t0:.0f}s", flush=True)
    print(f"完成:{total} 塊", flush=True)


if __name__ == "__main__":
    main()
