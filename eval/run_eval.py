"""辨識準確度評估。

資料:CubiCasa5k 驗證集(Hugging Face phungpx/cubicassa5k-coco,原始授權 CC BY-NC 4.0)。
**只做內部評估**:不拿來訓練模型、資料與報告不進 git、不對外發布。

量的是產品實際輸出的 Scene(build_scene 的結果),換回原圖像素座標跟標註比對:
  牆     像素 IoU,以及容許半個牆厚誤差的 precision / recall
  門窗   偵測 precision / recall(不分種類),配對上的再看門/窗種類對不對
  房間   數量,以及 IoU > 0.5 的一對一配對 precision / recall
家具:CubiCasa5k 沒有家具標註,不評。

用法(在專案根目錄):
  .venv/Scripts/python eval/run_eval.py [--n 40] [--seed 0]
報告輸出到 eval/reports/report.html
"""
import argparse
import html
import json
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "backend"))
from floorplan import recognize as rz  # noqa: E402
from floorplan.build import build_scene  # noqa: E402

DATA = ROOT / "data" / "cubicasa5k_valid.parquet"
REPORTS = ROOT / "reports"
CAT = {"bathroom": 1, "bed": 2, "door": 3, "kitchen": 4, "room": 5, "stairs": 6, "wall": 7, "window": 8}
ROOM_CATS = (CAT["bathroom"], CAT["kitchen"], CAT["room"])


# ---------- 讀資料 ----------

def style_of(file_name):
    """CubiCasa5k 的路徑裡有圖面風格:high_quality_architectural / high_quality / colorful。"""
    for s in ("high_quality_architectural", "high_quality", "colorful"):
        if f"/{s}/" in file_name.replace("\\", "/") or file_name.startswith(s):
            return s
    return "other"


def load_samples(n, seed):
    meta = pq.read_table(DATA, columns=["file_name"]).column("file_name").to_pylist()
    by_style = defaultdict(list)
    for i, f in enumerate(meta):
        by_style[style_of(f)].append(i)
    rng = random.Random(seed)
    # 各風格平均抽,才不會全是同一種畫法
    styles = sorted(by_style)
    picks = []
    for k, s in enumerate(styles):
        quota = n // len(styles) + (1 if k < n % len(styles) else 0)
        picks += rng.sample(by_style[s], min(quota, len(by_style[s])))
    table = pq.read_table(DATA, columns=["file_name", "image", "width", "height", "annotations"])
    rows = []
    for i in sorted(picks):
        r = {c: table.column(c)[i].as_py() for c in table.column_names}
        r["style"] = style_of(r["file_name"])
        rows.append(r)
    return rows


# ---------- 標準答案 ----------

def polys_of(ann, cat):
    out = []
    for c, seg in zip(ann["category_id"], ann["segmentation"]):
        if c == cat:
            for flat in seg:
                pts = np.array(flat, np.float32).reshape(-1, 2)
                if len(pts) >= 3:
                    out.append(pts)
    return out


def ground_truth(row):
    W, H = row["width"], row["height"]
    ann = row["annotations"]
    walls = np.zeros((H, W), np.uint8)
    for p in polys_of(ann, CAT["wall"]):
        cv2.fillPoly(walls, [p.round().astype(np.int32)], 1)
    openings = []
    for kind in ("door", "window"):
        for p in polys_of(ann, CAT[kind]):
            x0, y0 = p.min(axis=0)
            x1, y1 = p.max(axis=0)
            openings.append({"kind": kind, "c": ((x0 + x1) / 2, (y0 + y1) / 2), "size": max(x1 - x0, y1 - y0)})
    rooms = [p for c in ROOM_CATS for p in polys_of(ann, c)]
    dist = cv2.distanceTransform(walls, cv2.DIST_L2, 3)
    thick = 2 * float(np.percentile(dist[walls > 0], 90)) if walls.any() else 10.0
    return {"walls": walls, "openings": openings, "rooms": rooms, "thickness": thick}


# ---------- 預測(Scene → 原圖像素) ----------

def prediction(row, engine="rules"):
    data = row["image"]["bytes"]
    t0 = time.time()
    result = build_scene(data, None, 3000, with_background=False, engine=engine)
    elapsed = time.time() - t0
    scene = result.scene
    W, H = row["width"], row["height"]
    f = 1200 / max(W, H) if max(W, H) < 1200 else 1.0  # load_image 會把小圖放大
    proc_h = int(round(H * f))
    mpp = scene.meta.mm_per_px

    def to_px(p):
        return ((p[0] / mpp) / f, (proc_h - p[1] / mpp) / f)

    walls = np.zeros((H, W), np.uint8)
    wall_px = {}
    for w in scene.walls:
        a, b = np.array(to_px(w.a)), np.array(to_px(w.b))
        d = b - a
        L = np.linalg.norm(d)
        if L < 1e-6:
            continue
        u = d / L
        n = np.array([-u[1], u[0]]) * (w.thickness / mpp / f) / 2
        cv2.fillPoly(walls, [np.array([a - n, b - n, b + n, a + n]).round().astype(np.int32)], 1)
        wall_px[w.id] = (a, u)
    openings = []
    for o in scene.openings:
        a, u = wall_px[o.wall]
        c = a + u * (o.offset / mpp / f)
        openings.append({"kind": "window" if o.kind == "window" else "door", "c": tuple(c)})
    rooms = [np.array([to_px(p) for p in r.polygon], np.float32) for r in scene.rooms]
    return {"walls": walls, "openings": openings, "rooms": rooms, "seconds": elapsed}


# ---------- 指標 ----------

def wall_scores(gt, pred, tol):
    g, p = gt > 0, pred > 0
    inter, union = (g & p).sum(), (g | p).sum()
    k = np.ones((2 * tol + 1, 2 * tol + 1), np.uint8)
    g_tol = cv2.dilate(gt, k) > 0
    p_tol = cv2.dilate(pred, k) > 0
    return {
        "iou": inter / union if union else 0.0,
        "precision": (p & g_tol).sum() / p.sum() if p.sum() else 0.0,
        "recall": (g & p_tol).sum() / g.sum() if g.sum() else 0.0,
    }


def opening_scores(gt, pred, thick):
    """貪婪配對:距離最近、在容許範圍內的配成一對。CubiCasa 的門標註含開門弧線,中心會偏,所以容許距離放寬。"""
    pairs = []
    for i, g in enumerate(gt):
        for j, p in enumerate(pred):
            d = np.hypot(g["c"][0] - p["c"][0], g["c"][1] - p["c"][1])
            if d <= max(0.75 * g["size"], 2 * thick):
                pairs.append((d, i, j))
    used_g, used_p, kind_ok = set(), set(), 0
    for d, i, j in sorted(pairs):
        if i in used_g or j in used_p:
            continue
        used_g.add(i)
        used_p.add(j)
        kind_ok += gt[i]["kind"] == pred[j]["kind"]
    m = len(used_g)
    return {
        "precision": m / len(pred) if pred else (1.0 if not gt else 0.0),
        "recall": m / len(gt) if gt else 1.0,
        "kind_acc": kind_ok / m if m else None,
        "gt": len(gt), "pred": len(pred), "matched": m,
    }


def room_scores(gt, pred, shape):
    def mask(p):
        m = np.zeros(shape, np.uint8)
        cv2.fillPoly(m, [p.round().astype(np.int32)], 1)
        return m > 0
    gm, pm = [mask(p) for p in gt], [mask(p) for p in pred]
    pairs = []
    for i, g in enumerate(gm):
        for j, p in enumerate(pm):
            inter = (g & p).sum()
            if inter:
                iou = inter / (g | p).sum()
                if iou > 0.5:
                    pairs.append((-iou, i, j))
    used_g, used_p = set(), set()
    for _, i, j in sorted(pairs):
        if i not in used_g and j not in used_p:
            used_g.add(i)
            used_p.add(j)
    m = len(used_g)
    return {"precision": m / len(pred) if pred else 0.0, "recall": m / len(gt) if gt else 1.0,
            "gt": len(gt), "pred": len(pred)}


# ---------- 報告 ----------

def thumbnail(row, gt, pred, path):
    img = cv2.imdecode(np.frombuffer(row["image"]["bytes"], np.uint8), cv2.IMREAD_COLOR)
    over = img.copy()
    over[gt["walls"] > 0] = (60, 180, 60)  # 綠:標準答案的牆
    over[pred["walls"] > 0] = (40, 40, 220)  # 紅:辨識出的牆
    over[(gt["walls"] > 0) & (pred["walls"] > 0)] = (40, 160, 220)  # 黃:兩者重疊
    out = cv2.addWeighted(img, 0.4, over, 0.6, 0)
    r = max(3, int(gt["thickness"]))
    for o in gt["openings"]:
        cv2.circle(out, tuple(int(v) for v in o["c"]), r, (60, 180, 60), 2)
    for o in pred["openings"]:
        c = tuple(int(v) for v in o["c"])
        cv2.drawMarker(out, c, (40, 40, 220), cv2.MARKER_TILTED_CROSS, 2 * r, 2)
    s = 480 / max(out.shape[:2])
    cv2.imwrite(str(path), cv2.resize(out, None, fx=s, fy=s, interpolation=cv2.INTER_AREA))


def pct(v):
    return "—" if v is None else f"{100 * v:.0f}%"


def write_report(results, args):
    ok = [r for r in results if "error" not in r]
    def mean(key, sub, rows=ok):
        vals = [r[key][sub] for r in rows if r[key][sub] is not None]
        return sum(vals) / len(vals) if vals else None
    styles = sorted({r["style"] for r in results})
    summary_rows = []
    for label, rows in [("全部", ok)] + [(s, [r for r in ok if r["style"] == s]) for s in styles]:
        summary_rows.append(f"<tr><td>{label}</td><td>{len(rows)}</td>"
                            f"<td>{pct(mean('wall', 'iou', rows))}</td><td>{pct(mean('wall', 'precision', rows))}</td>"
                            f"<td>{pct(mean('wall', 'recall', rows))}</td>"
                            f"<td>{pct(mean('open', 'precision', rows))}</td><td>{pct(mean('open', 'recall', rows))}</td>"
                            f"<td>{pct(mean('open', 'kind_acc', rows))}</td>"
                            f"<td>{pct(mean('room', 'precision', rows))}</td><td>{pct(mean('room', 'recall', rows))}</td></tr>")
    detail = []
    for r in results:
        if "error" in r:
            detail.append(f"<tr><td>{html.escape(r['name'])}</td><td>{r['style']}</td><td colspan=8 class=bad>失敗:"
                          f"{html.escape(r['error'])}</td></tr>")
            continue
        detail.append(
            f"<tr><td><a href='img/{r['id']}.png'><img src='img/{r['id']}.png'></a><br>{html.escape(r['name'])}</td>"
            f"<td>{r['style']}</td><td>{pct(r['wall']['iou'])}</td><td>{pct(r['wall']['precision'])}</td>"
            f"<td>{pct(r['wall']['recall'])}</td>"
            f"<td>{r['open']['matched']}/{r['open']['pred']} 預測<br>{r['open']['matched']}/{r['open']['gt']} 標註</td>"
            f"<td>{pct(r['open']['kind_acc'])}</td><td>{r['room']['pred']} / {r['room']['gt']}</td>"
            f"<td>{pct(r['room']['recall'])}</td><td>{r['seconds']:.1f} s</td></tr>")
    failures = len(results) - len(ok)
    page = f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>辨識準確度報告</title>
<style>
body{{font:14px/1.5 "Microsoft JhengHei",system-ui,sans-serif;margin:24px;color:#1d2433;background:#fff}}
table{{border-collapse:collapse;margin:12px 0}} td,th{{border:1px solid #dfe3ea;padding:4px 8px;text-align:right;vertical-align:top}}
th{{background:#f4f5f7}} td:first-child,th:first-child{{text-align:left}} img{{width:240px}} .bad{{color:#d64545;text-align:left}}
.note{{color:#6b7385;max-width:900px}}
</style></head><body>
<h1>平面圖辨識準確度報告</h1>
<p class=note>資料:CubiCasa5k 驗證集隨機抽 {len(results)} 張(seed {args.seed},各風格平均抽樣),原始授權 CC BY-NC 4.0,僅供內部評估。
沒有提供比例尺,一律用「牆厚 ≈ 150 mm」自動估算。失敗(辨識直接出錯){failures} 張不計入平均。</p>
<h2>總覽</h2>
<table><tr><th>風格</th><th>張數</th><th>牆 IoU</th><th>牆 precision</th><th>牆 recall</th>
<th>門窗 precision</th><th>門窗 recall</th><th>門/窗種類正確</th><th>房間 precision</th><th>房間 recall</th></tr>
{''.join(summary_rows)}</table>
<p class=note>牆的 precision / recall 容許半個牆厚的位置誤差;門窗依中心距離配對(容許距離寬鬆,因為 CubiCasa 的門標註包含開門弧線);
房間要求面積 IoU &gt; 0.5 才算對到。縮圖:<span style="color:#3cb43c">綠 = 標準答案</span>、
<span style="color:#dc2828">紅 = 辨識結果</span>、黃 = 兩者重疊;圓圈 = 標註的門窗,× = 辨識到的門窗。</p>
<h2>每張圖</h2>
<table><tr><th>圖</th><th>風格</th><th>牆 IoU</th><th>牆 P</th><th>牆 R</th><th>門窗(配對數)</th><th>種類正確</th>
<th>房間 預測/標註</th><th>房間 recall</th><th>耗時</th></tr>
{''.join(detail)}</table></body></html>"""
    (REPORTS / "report.html").write_text(page, encoding="utf-8")
    (REPORTS / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1, default=float), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--engine", default="rules", choices=["rules", "ml"], help="辨識方式")
    args = ap.parse_args()
    global REPORTS
    REPORTS = REPORTS / args.engine  # 規則和機器學習的報告分開放,方便並排比較
    if not DATA.exists():
        sys.exit(f"找不到資料 {DATA}。請先下載:\n  curl -L -o {DATA} "
                 "https://huggingface.co/datasets/phungpx/cubicassa5k-coco/resolve/main/data/valid-00000-of-00001.parquet")
    (REPORTS / "img").mkdir(parents=True, exist_ok=True)
    rows = load_samples(args.n, args.seed)
    results = []
    for k, row in enumerate(rows):
        name = row["file_name"]
        item = {"id": k, "name": name, "style": row["style"]}
        gt = ground_truth(row)
        try:
            pred = prediction(row, args.engine)
        except (rz.PlanError, Exception) as e:  # 任何錯誤都記下來,繼續評下一張
            item["error"] = f"{type(e).__name__}: {e}"
            results.append(item)
            print(f"[{k + 1}/{len(rows)}] {name}: 失敗 {item['error']}")
            continue
        tol = max(2, int(round(gt["thickness"] / 2)))
        item["wall"] = wall_scores(gt["walls"], pred["walls"], tol)
        item["open"] = opening_scores(gt["openings"], pred["openings"], gt["thickness"])
        item["room"] = room_scores(gt["rooms"], pred["rooms"], gt["walls"].shape)
        item["seconds"] = pred["seconds"]
        thumbnail(row, gt, pred, REPORTS / "img" / f"{k}.png")
        results.append(item)
        print(f"[{k + 1}/{len(rows)}] {item['style']:28s} 牆 IoU {pct(item['wall']['iou'])}  "
              f"門窗 P/R {pct(item['open']['precision'])}/{pct(item['open']['recall'])}  "
              f"房間 {item['room']['pred']}/{item['room']['gt']}  {pred['seconds']:.1f}s")
    write_report(results, args)
    print(f"報告:{REPORTS / 'report.html'}")


if __name__ == "__main__":
    main()
