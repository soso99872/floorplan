"""機器學習辨識:ONNX 分割模型把平面圖每個像素分成 背景 / 牆 / 門 / 窗。

模型在 ml/ 用合成資料訓練(見 ml/README.md),輸出到 backend/models/floorplan-seg.onnx。
大圖切成 512 的小塊、彼此重疊,拼回整張分數圖再取最大。沒有模型檔或沒裝 onnxruntime 時 available() 回 False。
"""
from pathlib import Path

import cv2
import numpy as np

_MODELS = Path(__file__).resolve().parent.parent / "models"
# models/local/ 放只能自用的模型(例如用 CubiCasa 微調的版本,授權不允許公開),不進 git;有的話優先用
MODEL = next((m for m in (_MODELS / "local" / "floorplan-seg.onnx", _MODELS / "floorplan-seg.onnx") if m.exists()),
             _MODELS / "floorplan-seg.onnx")
BG, WALL, DOOR, WINDOW = 0, 1, 2, 3
TILE, OVERLAP = 512, 96
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
# 模型訓練時牆厚大多在 3~24 px;推論前把圖縮放到長邊在這個範圍,牆才會落在學過的粗細
MIN_SIDE, MAX_SIDE = 768, 1600

_session = None


def available():
    if not MODEL.exists():
        return False
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def session():
    global _session
    if _session is None:
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _session = ort.InferenceSession(str(MODEL), opts, providers=["CPUExecutionProvider"])
    return _session


def _weights(n):
    """拼接用的權重:小塊中間大、邊緣小,接縫才不會有痕跡。"""
    r = np.minimum(np.arange(n) + 1, np.arange(n)[::-1] + 1).astype(np.float32)
    w = np.minimum(1.0, r / OVERLAP)
    return np.outer(w, w)


def segment(im_bgr):
    """整張圖 → (類別圖, 縮放比例)。類別圖跟縮放後的圖一樣大;縮放比例 = 縮放後 / 原圖。"""
    h0, w0 = im_bgr.shape[:2]
    scale = float(np.clip(max(h0, w0), MIN_SIDE, MAX_SIDE)) / max(h0, w0)
    im = cv2.resize(im_bgr, (round(w0 * scale), round(h0 * scale)),
                    interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC) if scale != 1 else im_bgr
    h, w = im.shape[:2]
    H, W = max(TILE, h), max(TILE, w)
    pad = np.full((H, W, 3), 255, np.uint8)
    pad[:h, :w] = im
    x = (cv2.cvtColor(pad, cv2.COLOR_BGR2RGB).astype(np.float32) / 255 - MEAN) / STD
    x = x.transpose(2, 0, 1)
    acc = np.zeros((4, H, W), np.float32)
    wsum = np.zeros((H, W), np.float32)
    wt = _weights(TILE)
    step = TILE - OVERLAP
    ys = list(range(0, H - TILE + 1, step)) + ([H - TILE] if (H - TILE) % step else [])
    xs = list(range(0, W - TILE + 1, step)) + ([W - TILE] if (W - TILE) % step else [])
    sess = session()
    for y in ys:
        for xx in xs:
            tile = x[None, :, y:y + TILE, xx:xx + TILE]
            logits = sess.run(None, {"image": np.ascontiguousarray(tile)})[0][0]
            e = np.exp(logits - logits.max(0, keepdims=True))
            acc[:, y:y + TILE, xx:xx + TILE] += e / e.sum(0, keepdims=True) * wt
            wsum[y:y + TILE, xx:xx + TILE] += wt
    prob = acc[:, :h, :w] / wsum[None, :h, :w]
    return prob.argmax(0).astype(np.uint8), scale


def opening_rects(labels, kind_value, t):
    """門 / 窗像素的連通區塊 → 開口矩形 (x, y, w, h);太小的(雜點)略過。"""
    m = (labels == kind_value).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(m)
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if max(w, h) < 2.5 * t or area < t * t:
            continue
        # 開口的厚度方向撐到牆厚,掛到牆上時才對得到
        if w >= h:
            cy = y + h / 2
            out.append((int(x), int(round(cy - t / 2)), int(w), int(t)))
        else:
            cx = x + w / 2
            out.append((int(round(cx - t / 2)), int(y), int(t), int(h)))
    return out
