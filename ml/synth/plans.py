"""格局來源:把 ResPlan 的一份平面圖轉成統一的 Plan(單位 mm)。

ResPlan(https://github.com/m-agour/ResPlan,CC BY 4.0)存的是 shapely 幾何,座標正規化到約 256 單位寬,
用 net_area(m²)與房間總面積換算回 mm。牆是多邊形,門窗是牆缺口裡的矩形。
資料檔是用 numpy 2 存的 pickle,舊版 numpy 讀之前要先把 numpy._core 指到 numpy.core。
"""
import pickle
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Tuple

import numpy as np
from shapely import affinity
from shapely.geometry import Polygon
from shapely.ops import unary_union

DATA = Path(__file__).resolve().parent.parent / "data" / "resplan" / "ResPlan.pkl"
ROOM_KEYS = ["living", "bedroom", "bathroom", "kitchen", "storage", "stair"]


@dataclass
class Plan:
    walls: object  # shapely(Multi)Polygon,已扣掉門窗開口
    doors: List[Polygon]
    windows: List[Polygon]
    rooms: List[Tuple[str, Polygon]]
    balconies: List[Polygon] = field(default_factory=list)
    front: List[int] = field(default_factory=list)  # doors 裡哪幾個是大門
    wall_mm: float = 200.0

    def bounds(self):
        return unary_union([self.walls] + self.doors + self.windows).bounds


def _parts(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, (Polygon,)):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon) and not p.is_empty]


def load_resplan(path=DATA):
    import numpy.core
    import numpy.core.multiarray
    import numpy.core.numeric
    for name, mod in (("numpy._core", numpy.core), ("numpy._core.multiarray", numpy.core.multiarray),
                      ("numpy._core.numeric", numpy.core.numeric)):
        sys.modules.setdefault(name, mod)
    # ResPlan 官方只提供 pickle;這是從官方 GitHub 下載的公開資料集,只在本機離線讀取,不讀使用者上傳的檔案
    with open(path, "rb") as f:
        return pickle.load(f)


def from_resplan(p) -> Plan:
    rooms = [(k, poly) for k in ROOM_KEYS for poly in _parts(p.get(k))]
    room_area = sum(poly.area for _, poly in rooms) + sum(b.area for b in _parts(p.get("balcony")))
    s = (p["net_area"] * 1e6 / room_area) ** 0.5 if room_area > 0 and p.get("net_area") else 45.0
    if not 25 < s < 120:  # 換算結果不合理的,用常見值
        s = 45.0
    sc = lambda g: affinity.scale(g, s, s, origin=(0, 0))
    doors = [sc(d) for d in _parts(p.get("door"))]
    front = [sc(d) for d in _parts(p.get("front_door"))]
    windows = [sc(w) for w in _parts(p.get("window"))]
    openings = unary_union(doors + front + windows) if (doors or front or windows) else Polygon()
    walls = sc(p["wall"]).buffer(0)
    if not openings.is_empty:
        walls = walls.difference(openings.buffer(1))
    return Plan(
        walls=walls, doors=doors + front, windows=windows,
        rooms=[(k, sc(poly)) for k, poly in rooms],
        balconies=[sc(b) for b in _parts(p.get("balcony"))],
        front=list(range(len(doors), len(doors) + len(front))),
        wall_mm=float(p.get("wall_depth", 4.5) * s),
    )


def opening_frame(rect: Polygon):
    """門窗矩形 → (中心, 沿牆方向單位向量, 長度, 牆厚)。"""
    mrr = rect.minimum_rotated_rectangle
    pts = np.array(mrr.exterior.coords)[:4]
    e1, e2 = pts[1] - pts[0], pts[2] - pts[1]
    l1, l2 = np.linalg.norm(e1), np.linalg.norm(e2)
    u = e1 / (l1 or 1) if l1 >= l2 else e2 / (l2 or 1)
    return pts.mean(axis=0), u, max(l1, l2), min(l1, l2)
