"""訓練(CPU 也可以):可中斷,重跑會從 runs/<name>/last.pt 接著練。

  cd ml && .venv/Scripts/python -m train.train --name v1 --epochs 12 --steps 1200
每個 epoch 結束在驗證集算各類 IoU,最好的存成 best.pt。進度寫在 runs/<name>/log.txt。
"""
import argparse
import json
import math
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from .dataset import Tiles
from .model import CLASS_NAMES, NUM_CLASSES, UNet

CLASS_WEIGHTS = torch.tensor([1.0, 2.0, 5.0, 5.0])  # 門窗像素很少,加重


def dice_loss(logits, target):
    prob = logits.softmax(1)
    onehot = F.one_hot(target, NUM_CLASSES).permute(0, 3, 1, 2).float()
    inter = (prob * onehot).sum((0, 2, 3))
    union = prob.sum((0, 2, 3)) + onehot.sum((0, 2, 3))
    dice = (2 * inter + 1) / (union + 1)
    return 1 - dice[1:].mean()  # 背景不算


def confusion(pred, target):
    k = target * NUM_CLASSES + pred
    return torch.bincount(k.flatten(), minlength=NUM_CLASSES ** 2).reshape(NUM_CLASSES, NUM_CLASSES)


def ious(cm):
    cm = cm.double()
    tp = cm.diag()
    return (tp / (cm.sum(0) + cm.sum(1) - tp).clamp(min=1)).tolist()


@torch.no_grad()
def evaluate(model, loader):
    model.eval()
    cm = torch.zeros(NUM_CLASSES, NUM_CLASSES, dtype=torch.long)
    for x, y in loader:
        cm += confusion(model(x).argmax(1), y)
    model.train()
    return ious(cm)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/synth")
    ap.add_argument("--name", default="v1")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--steps", type=int, default=1200, help="每個 epoch 幾步")
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--size", type=int, default=384)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--threads", type=int, default=12)
    ap.add_argument("--val", type=int, default=400, help="驗證用幾塊")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    run = Path("runs") / a.name
    run.mkdir(parents=True, exist_ok=True)
    log = open(run / "log.txt", "a", encoding="utf-8")

    def say(msg):
        print(msg, flush=True)
        log.write(msg + "\n")
        log.flush()

    train = DataLoader(Tiles(a.data, "train", a.size), batch_size=a.batch, shuffle=True, num_workers=a.workers,
                       drop_last=True, persistent_workers=a.workers > 0)
    val = DataLoader(Tiles(a.data, "val", a.size, augment=False, limit=a.val), batch_size=a.batch, num_workers=a.workers)
    model = UNet()
    enc = [p for n, p in model.named_parameters() if n.split(".")[0] in ("stem", "l1", "l2", "l3", "l4")]
    dec = [p for n, p in model.named_parameters() if n.split(".")[0] not in ("stem", "l1", "l2", "l3", "l4")]
    opt = torch.optim.AdamW([{"params": enc, "lr": a.lr * 0.3}, {"params": dec, "lr": a.lr}], weight_decay=1e-4)
    total = a.epochs * a.steps
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / 300) * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))
    start_epoch, best = 0, -1.0
    if (run / "last.pt").exists():
        ck = torch.load(run / "last.pt", map_location="cpu", weights_only=True)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        sched.load_state_dict(ck["sched"])
        start_epoch, best = ck["epoch"] + 1, ck["best"]
        say(f"接續 epoch {start_epoch}(目前最佳 {best:.3f})")
    say(f"訓練 {len(train.dataset)} 塊、驗證 {len(val.dataset)} 塊;{json.dumps(vars(a))}")

    for epoch in range(start_epoch, a.epochs):
        t0, run_loss, step = time.time(), 0.0, 0
        it = iter(train)
        while step < a.steps:
            try:
                x, y = next(it)
            except StopIteration:
                it = iter(train)
                continue
            logits = model(x)
            loss = F.cross_entropy(logits, y, weight=CLASS_WEIGHTS) + dice_loss(logits, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            run_loss += loss.item()
            step += 1
            if step % 50 == 0:
                el = time.time() - t0
                say(f"epoch {epoch + 1}/{a.epochs} step {step}/{a.steps} loss {run_loss / 50:.3f} "
                    f"{el / step:.2f}s/步,這個 epoch 還要約 {(a.steps - step) * el / step / 60:.0f} 分")
                run_loss = 0.0
        iou = evaluate(model, val)
        score = sum(iou[1:]) / 3
        say(f"== epoch {epoch + 1} 驗證 IoU:" + "、".join(f"{n} {v:.3f}" for n, v in zip(CLASS_NAMES, iou))
            + f";平均(不含背景){score:.3f};{(time.time() - t0) / 60:.0f} 分")
        if score > best:
            best = score
            torch.save({"model": model.state_dict(), "iou": iou, "epoch": epoch}, run / "best.pt")
            say(f"   新的最佳,存到 {run / 'best.pt'}")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
                    "epoch": epoch, "best": best}, run / "last.pt")


if __name__ == "__main__":
    main()
