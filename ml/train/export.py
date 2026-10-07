"""best.pt → ONNX(後端用 onnxruntime 推論,不需要裝 PyTorch)。

  cd ml && .venv/Scripts/python -m train.export --run runs/v1 --out ../backend/models/floorplan-seg.onnx
輸入:1×3×H×W(RGB,ImageNet 正規化,H、W 是 32 的倍數);輸出:1×4×H×W 的分數(背景 / 牆 / 門 / 窗)。
"""
import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from .model import CLASS_NAMES, UNet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="runs/v1")
    ap.add_argument("--ckpt", default="best.pt")
    ap.add_argument("--out", default="../backend/models/floorplan-seg.onnx")
    a = ap.parse_args()
    ck = torch.load(Path(a.run) / a.ckpt, map_location="cpu", weights_only=True)
    model = UNet(pretrained=False)
    model.load_state_dict(ck["model"])
    model.eval()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    x = torch.randn(1, 3, 512, 512)
    torch.onnx.export(model, x, str(out), input_names=["image"], output_names=["logits"], opset_version=17,
                      dynamic_axes={"image": {2: "h", 3: "w"}, "logits": {2: "h", 3: "w"}})
    # 檢查 ONNX 跟 PyTorch 結果一致
    with torch.no_grad():
        ref = model(x).numpy()
    got = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"]).run(None, {"image": x.numpy()})[0]
    diff = float(np.abs(ref - got).max())
    meta = {"classes": CLASS_NAMES, "epoch": ck.get("epoch"), "val_iou": ck.get("iou"), "max_diff": diff}
    out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已輸出 {out}({out.stat().st_size / 1e6:.1f} MB),與 PyTorch 最大差異 {diff:.2e}")


if __name__ == "__main__":
    main()
