"""找瓶頸:同一批 CubiCasa 圖,分三個階段量牆的分數。

  A 模型原始輸出(牆像素)
  B 去雜點 + 規整成直牆之後(regularize_walls 的 clean)
  C 最後的 Scene(牆段中心線 + 厚度,畫回像素)
另外算「預測牆像素總量 / 標註牆像素總量」,看是不是厚度系統性偏粗或偏細。

  .venv\\Scripts\\python eval\\diagnose_ml.py --n 40
"""
import argparse
import statistics as st
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "backend"))
import run_eval as ev  # noqa: E402
from floorplan import recognize as rz  # noqa: E402
from floorplan.build import ml_walls  # noqa: E402


def to_orig(mask, W, H):
    return cv2.resize(mask.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40)
    a = ap.parse_args()
    rows = ev.load_samples(a.n, 0)
    stages = {"A 模型原始": [], "B 規整後": [], "C 最後 Scene": []}
    ratio = {k: [] for k in stages}
    for k, row in enumerate(rows):
        gt = ev.ground_truth(row)
        W, H = row["width"], row["height"]
        tol = max(2, int(round(gt["thickness"] / 2)))
        im = rz.load_image(row["image"]["bytes"])
        try:
            raw, t, seg, t_max = ml_walls(im)
            _, _, clean = rz.regularize_walls(raw, t, t_max)
            final = ev.prediction(row, "ml")["walls"]
        except Exception as e:
            print(f"[{k + 1}] 失敗 {e}")
            continue
        masks = {"A 模型原始": to_orig(seg == 1, W, H), "B 規整後": to_orig(clean > 0, W, H), "C 最後 Scene": final}
        line = []
        for name, m in masks.items():
            s = ev.wall_scores(gt["walls"], m, tol)
            stages[name].append(s)
            ratio[name].append(m.sum() / max(1, gt["walls"].sum()))
            line.append(f"{name[0]} IoU {s['iou']:.0%}")
        print(f"[{k + 1}/{len(rows)}] {row['style'][:22]:22s} " + "  ".join(line), flush=True)
    print()
    for name, ss in stages.items():
        print(f"{name:10s} IoU {st.mean(s['iou'] for s in ss):.1%}  P {st.mean(s['precision'] for s in ss):.1%}  "
              f"R {st.mean(s['recall'] for s in ss):.1%}  牆像素量 / 標註 {st.median(ratio[name]):.2f}")


if __name__ == "__main__":
    main()
