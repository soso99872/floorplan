"""讀 synth.generate 產生的小塊:隨機裁切、旋轉 90° / 翻轉、色彩擾動。"""
import random
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

from .model import MEAN, STD


def to_tensor(img_bgr):
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    rgb = (rgb - MEAN) / STD
    return torch.from_numpy(rgb.transpose(2, 0, 1).copy()).float()


class Tiles(Dataset):
    def __init__(self, root, split, size=384, augment=True, limit=None):
        # root 可以用逗號串多個資料夾(例如 CubiCasa + 合成資料一起訓練)
        self.imgs = [p for r in str(root).split(",") for p in sorted((Path(r) / split / "img").glob("*.jpg"))]
        if limit:
            self.imgs = self.imgs[:limit]
        self.size, self.augment = size, augment

    def __len__(self):
        return len(self.imgs)

    def __getitem__(self, i):
        p = self.imgs[i]
        img = cv2.imread(str(p), cv2.IMREAD_COLOR)
        lab = cv2.imread(str(p.parent.parent / "lab" / (p.stem + ".png")), cv2.IMREAD_GRAYSCALE)
        h, w = lab.shape
        s = self.size
        if self.augment:
            y, x = random.randint(0, h - s), random.randint(0, w - s)
        else:
            y, x = (h - s) // 2, (w - s) // 2
        img, lab = img[y:y + s, x:x + s], lab[y:y + s, x:x + s]
        if self.augment:
            k = random.randint(0, 3)
            img, lab = np.rot90(img, k), np.rot90(lab, k)
            if random.random() < 0.5:
                img, lab = img[:, ::-1], lab[:, ::-1]
            img = np.ascontiguousarray(img)
            if random.random() < 0.3:  # 色相 / 亮度擾動
                hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.int16)
                hsv[..., 0] = (hsv[..., 0] + random.randint(0, 179)) % 180
                hsv[..., 2] = np.clip(hsv[..., 2] + random.randint(-25, 15), 0, 255)
                img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
            if random.random() < 0.15:
                img = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
        return to_tensor(img), torch.from_numpy(np.ascontiguousarray(lab).astype(np.int64))
