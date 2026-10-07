"""把 Plan 用隨機的畫法畫成平面圖圖片,同時輸出逐像素標註。

標註類別:0 背景(含家具、文字、地板等一切非結構)、1 牆、2 門(牆上的門洞)、3 窗。
門窗只標牆上開口那一段,門弧、門片不算門 —— 模型要學的是「牆在哪、哪裡開了洞、洞是門還是窗」。

畫法(每張圖隨機組合):
  牆:實心(黑 / 灰 / 有色)、雙線空心、雙線 + 斜線、雙線 + 交叉線、雙線 + 灰填、外牆加粗
  門:單開弧、雙開弧、推拉門、只有門片、只有缺口;門框短線
  窗:三線、雙線、填色、只有外框
  干擾:地板顏色 / 木紋 / 磁磚格線、家具符號(線稿或色塊)、房名與面積文字、尺寸線、軸線、
       指北針、標題、浮水印、陽台欄杆
  畫質:手繪抖動、模糊、雜點、JPEG、紙張底色、低解析度、輕微旋轉
"""
import math
import random
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import Polygon, box

from .plans import Plan, opening_frame

BG, WALL, DOOR, WINDOW = 0, 1, 2, 3
FONT_DIR = Path("C:/Windows/Fonts")
FONTS_ZH = [f for f in ("msjh.ttc", "msjhbd.ttc", "mingliu.ttc", "kaiu.ttf") if (FONT_DIR / f).exists()]
FONTS_EN = [f for f in ("arial.ttf", "arialbd.ttf", "calibri.ttf", "consola.ttf", "times.ttf", "segoeui.ttf")
            if (FONT_DIR / f).exists()]
ROOM_NAMES = {
    "living": ["客廳", "起居室", "客餐廳", "LIVING", "Living Room", "LIVING/DINING"],
    "bedroom": ["臥室", "主臥", "次臥", "小孩房", "臥房", "BEDROOM", "Bedroom", "MASTER BED"],
    "bathroom": ["浴室", "衛浴", "廁所", "主浴", "BATH", "WC", "Toilet"],
    "kitchen": ["廚房", "KITCHEN", "Kitchen"],
    "storage": ["儲藏室", "STORE", "Storage"],
    "stair": ["樓梯", "STAIR", "UP"],
    "balcony": ["陽台", "BALCONY", "Terrace", "工作陽台"],
}


# ---------- 小工具 ----------

def rnd_gray(lo, hi):
    v = random.randint(lo, hi)
    return (v, v, v)


def tint(color, k=18):
    return tuple(int(np.clip(c + random.randint(-k, k), 0, 255)) for c in color)


def pastel():
    h = random.randint(0, 179)
    c = cv2.cvtColor(np.uint8([[[h, random.randint(25, 90), random.randint(205, 245)]]]), cv2.COLOR_HSV2BGR)[0, 0]
    return tuple(int(x) for x in c)


class Canvas:
    """Plan(mm)→ 像素:x' = (x - x0) * s + margin,y 依 flip 決定是否翻轉。"""

    def __init__(self, plan: Plan, px_per_mm: float, margin: int, flip_y: bool):
        x0, y0, x1, y1 = plan.bounds()
        self.x0, self.y0, self.y1 = x0, y0, y1
        self.s, self.m, self.flip = px_per_mm, margin, flip_y
        self.w = int((x1 - x0) * px_per_mm) + 2 * margin
        self.h = int((y1 - y0) * px_per_mm) + 2 * margin

    def pt(self, x, y):
        yy = (self.y1 - y) if self.flip else (y - self.y0)
        return ((x - self.x0) * self.s + self.m, yy * self.s + self.m)

    def arr(self, coords):
        return np.array([self.pt(x, y) for x, y in coords], np.float64)

    def rings(self, geom):
        """幾何 → 像素座標的環(外框 + 洞)列表,給 fillPoly / polylines 用(固定小數 4 位)。"""
        out = []
        for poly in getattr(geom, "geoms", [geom]):
            if not isinstance(poly, Polygon) or poly.is_empty:
                continue
            for ring in [poly.exterior, *poly.interiors]:
                out.append(np.round(self.arr(ring.coords) * 16).astype(np.int32))
        return out


def fill(img, cv, geom, color):
    r = cv.rings(geom)
    if r:
        cv2.fillPoly(img, r, color, cv2.LINE_AA, 4)


def outline(img, cv, geom, color, t):
    r = cv.rings(geom)
    if r:
        cv2.polylines(img, r, True, color, max(1, int(round(t))), cv2.LINE_AA, 4)


def line(img, a, b, color, t=1):
    cv2.line(img, (int(a[0] * 16), int(a[1] * 16)), (int(b[0] * 16), int(b[1] * 16)), color,
             max(1, int(round(t))), cv2.LINE_AA, 4)


def hatch(img, mask, color, spacing, angle, t=1, cross=False):
    """在 mask 範圍裡畫斜線(或交叉線)。"""
    h, w = mask.shape
    pat = np.zeros((h, w), np.uint8)
    d = int(math.hypot(h, w))
    for ang in ([angle, angle + 90] if cross else [angle]):
        ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        for k in range(-d, d, max(2, int(spacing))):
            p0 = (int(w / 2 + k * -sa - d * ca), int(h / 2 + k * ca - d * sa))
            p1 = (int(w / 2 + k * -sa + d * ca), int(h / 2 + k * ca + d * sa))
            cv2.line(pat, p0, p1, 255, max(1, int(t)), cv2.LINE_AA)
    a = (pat.astype(np.float32) / 255 * (mask > 0))[..., None]
    img[:] = (img * (1 - a) + np.array(color, np.float32) * a).astype(np.uint8)


# ---------- 風格 ----------

def sample_style(plan: Plan):
    wall_px = random.choice([random.uniform(3, 8), random.uniform(6, 14), random.uniform(10, 24)])
    s = {
        "px_per_mm": wall_px / max(plan.wall_mm, 80),
        "paper": random.choice([(255, 255, 255)] * 4 + [(248, 250, 252), (236, 244, 248), (235, 238, 240), (240, 245, 250)]),
        "ink": rnd_gray(0, 70) if random.random() < 0.85 else tint(random.choice([(90, 60, 30), (110, 40, 40), (40, 40, 110)])),
        "wall": random.choices(
            ["solid", "solid_gray", "solid_color", "double", "hatch", "cross", "gray_fill", "double_thick_outer"],
            weights=[4, 2, 1, 2, 3, 1, 2, 1])[0],
        "line_t": random.choice([1, 1, 1, 2, 2, 3]),
        "floor": random.choices(["none", "pastel", "single", "wood", "tile"], weights=[5, 2, 2, 1.5, 1.5])[0],
        "door": random.choices(["arc", "arc", "arc", "leaf", "sliding", "gap"], k=1)[0],
        "door_mix": random.random() < 0.3,  # 同一張圖混不同畫法
        "window": random.choice(["three", "two", "filled", "box", "three"]),
        "jamb": random.random() < 0.5,
        "furniture": random.choices(["none", "lines", "blocks"], weights=[2, 5, 3])[0],
        "text": random.random() < 0.75,
        "dims": random.random() < 0.55,
        "grid": random.random() < 0.15,
        "extras": random.random() < 0.4,
        "hand": random.random() < 0.12,
        "scan": random.random() < 0.3,
        "blur": random.random() < 0.3,
        "jpeg": random.random() < 0.5,
        "rotate": random.random() < 0.2,
        "lowres": random.random() < 0.2,
    }
    if s["wall"] == "solid_color":
        s["wall_color"] = tint(random.choice([(60, 60, 140), (40, 80, 120), (90, 70, 50), (50, 50, 50), (30, 30, 30)]))
    return s


# ---------- 各元件 ----------

def draw_floor(img, cv, plan, st):
    mode = st["floor"]
    if mode == "none":
        return
    base = pastel()
    for kind, poly in plan.rooms + [("balcony", b) for b in plan.balconies]:
        if mode == "pastel":
            c = pastel()
        elif mode == "single":
            c = tint(base, 6)
        elif mode in ("wood", "tile"):
            c = tint((200, 220, 235) if mode == "wood" else (225, 225, 220), 12)
        fill(img, cv, poly, c)
        if mode in ("wood", "tile") and random.random() < 0.8:
            mask = np.zeros(img.shape[:2], np.uint8)
            fill(mask, cv, poly, 255)
            step = max(4, int((random.uniform(150, 300) if mode == "wood" else random.uniform(300, 800)) * cv.s))
            hatch(img, mask, tuple(max(0, x - 35) for x in c), step,
                  random.choice([0, 90]), 1, cross=(mode == "tile"))


def draw_walls(img, cv, plan, st):
    walls = plan.walls
    ink = st["ink"]
    t = st["line_t"]
    kind = st["wall"]
    if kind == "solid":
        fill(img, cv, walls, ink)
    elif kind == "solid_gray":
        fill(img, cv, walls, rnd_gray(70, 150))
        if random.random() < 0.5:
            outline(img, cv, walls, ink, t)
    elif kind == "solid_color":
        fill(img, cv, walls, st["wall_color"])
    elif kind == "gray_fill":
        fill(img, cv, walls, rnd_gray(150, 215))
        outline(img, cv, walls, ink, t)
    elif kind in ("hatch", "cross"):
        mask = np.zeros(img.shape[:2], np.uint8)
        fill(mask, cv, walls, 255)
        sp = max(3, int(plan.wall_mm * cv.s / random.uniform(1.5, 4)))
        hatch(img, mask, tint(ink, 30), sp, random.choice([45, 135, 30, 60]), 1, cross=(kind == "cross"))
        outline(img, cv, walls, ink, t)
    elif kind == "double":
        outline(img, cv, walls, ink, t)
    elif kind == "double_thick_outer":
        fill(img, cv, walls, ink)
        # 內牆畫細一點:把比較薄的牆段改成空心
        thin = walls.buffer(-plan.wall_mm * 0.3).buffer(plan.wall_mm * 0.3)
        inner = walls.difference(thin)
        if not inner.is_empty:
            fill(img, cv, inner.buffer(-1), st["paper"])


def door_arc(img, cv, hinge, closed_dir, open_dir, r, ink, t, quarter=True):
    pts = []
    n = 18
    for i in range(n + 1):
        a = (i / n) * (math.pi / 2)
        p = hinge + closed_dir * r * math.cos(a) + open_dir * r * math.sin(a)
        pts.append(cv.pt(*p))
    cv2.polylines(img, [np.round(np.array(pts) * 16).astype(np.int32)], False, ink, max(1, int(t)), cv2.LINE_AA, 4)


def draw_doors(img, cv, plan, st):
    ink, t = st["ink"], max(1, st["line_t"] - (1 if random.random() < 0.5 else 0))
    for i, d in enumerate(plan.doors):
        c, u, L, T = opening_frame(d)
        n = np.array([-u[1], u[0]])
        side = 1 if random.random() < 0.5 else -1
        style = random.choice(["arc", "leaf", "sliding", "gap", "arc", "arc"]) if st["door_mix"] else st["door"]
        if st["jamb"]:
            for k in (-1, 1):
                p = c + u * k * L / 2
                line(img, cv.pt(*(p - n * T / 2)), cv.pt(*(p + n * T / 2)), ink, t)
        face = c + n * side * T / 2
        if style == "arc":
            double = L > 1150 and random.random() < 0.7
            leaves = [(-1, L / 2), (1, L / 2)] if double else [(random.choice([-1, 1]), L)]
            for hs, leaf in leaves:
                h = face + u * hs * L / 2
                tip = h + n * side * leaf
                line(img, cv.pt(*h), cv.pt(*tip), ink, t + (1 if i in plan.front else 0))
                door_arc(img, cv, h, -u * hs, n * side, leaf, ink, 1)
        elif style == "leaf":
            h = face + u * random.choice([-1, 1]) * L / 2
            tip = h + n * side * L * 0.95
            cv2.fillPoly(img, [np.round(np.array([cv.pt(*h), cv.pt(*tip), cv.pt(*(tip + u * 40)), cv.pt(*(h + u * 40))]) * 16).astype(np.int32)],
                         ink, cv2.LINE_AA, 4)
        elif style == "sliding":
            for k, off in ((-1, -T * 0.15), (1, T * 0.15)):
                a = c + u * (k * L / 4 - L * 0.28) + n * off
                b = c + u * (k * L / 4 + L * 0.28) + n * off
                line(img, cv.pt(*a), cv.pt(*b), ink, max(1, t))
        # gap:什麼都不畫


def draw_windows(img, cv, plan, st):
    ink = st["ink"]
    style = st["window"]
    fillc = random.choice([(240, 225, 200), (255, 255, 255), (230, 230, 230), (250, 235, 215)])
    for w in plan.windows:
        c, u, L, T = opening_frame(w)
        n = np.array([-u[1], u[0]])
        if style in ("filled", "box"):
            if style == "filled":
                fill(img, cv, w, fillc)
            outline(img, cv, w, ink, 1)
        ks = {"three": (-0.5, 0, 0.5), "two": (-0.18, 0.18)}.get(style, ())
        for k in ks:
            a, b = c - u * L / 2 + n * k * T, c + u * L / 2 + n * k * T
            line(img, cv.pt(*a), cv.pt(*b), ink, 1)
        if style in ("three", "two"):
            for k in (-1, 1):
                p = c + u * k * L / 2
                line(img, cv.pt(*(p - n * T / 2)), cv.pt(*(p + n * T / 2)), ink, 1)


# ---------- 家具符號(干擾項,標註是背景) ----------

def place_rect(poly: Polygon, w, d, tries=12):
    minx, miny, maxx, maxy = poly.bounds
    if maxx - minx < w or maxy - miny < d:
        return None
    for _ in range(tries):
        x = random.uniform(minx, maxx - w)
        y = random.uniform(miny, maxy - d)
        r = box(x, y, x + w, y + d)
        if poly.buffer(-60).contains(r):
            return r
    return None


def draw_furniture(img, cv, plan, st):
    mode = st["furniture"]
    if mode == "none":
        return
    ink = tint(st["ink"], 40) if random.random() < 0.5 else rnd_gray(60, 140)
    sizes = {
        "bedroom": [("bed", 1500, 2000), ("bed", 1800, 2000), ("wardrobe", 1800, 600), ("desk", 1200, 600)],
        "living": [("sofa", 2200, 900), ("table", 1000, 600), ("tv", 1800, 450), ("dining", 1600, 900), ("round", 1100, 1100)],
        "kitchen": [("counter", 2400, 600), ("counter", 600, 2000), ("dining", 1200, 800)],
        "bathroom": [("toilet", 450, 700), ("sink", 600, 450), ("tub", 1600, 750), ("shower", 900, 900)],
        "storage": [("shelf", 1200, 450)],
    }
    for kind, poly in plan.rooms:
        for name, w, d in random.sample(sizes.get(kind, []), k=min(len(sizes.get(kind, [])), random.randint(0, 3))):
            if random.random() < 0.5:
                w, d = d, w
            r = place_rect(poly, w, d)
            if r is None:
                continue
            x0, y0, x1, y1 = r.bounds
            if mode == "blocks":
                fill(img, cv, r, random.choice([pastel(), rnd_gray(110, 200), tint((70, 110, 160), 30)]))
                if random.random() < 0.5:
                    outline(img, cv, r, ink, 1)
            else:
                if name in ("round", "toilet", "sink") and random.random() < 0.7:
                    cx, cy = cv.pt((x0 + x1) / 2, (y0 + y1) / 2)
                    cv2.ellipse(img, (int(cx), int(cy)), (max(1, int((x1 - x0) * cv.s / 2)), max(1, int((y1 - y0) * cv.s / 2))),
                                0, 0, 360, ink, 1, cv2.LINE_AA)
                else:
                    outline(img, cv, r, ink, 1)
                if name == "bed":
                    pw = (x1 - x0) * 0.4
                    for k in range(2 if x1 - x0 > 1200 else 1):
                        outline(img, cv, box(x0 + 80 + k * (pw + 80), y0 + 60, x0 + 80 + k * (pw + 80) + pw, y0 + 400), ink, 1)
                    line(img, cv.pt(x0, y0 + 600), cv.pt(x1, y0 + 600), ink, 1)
                elif name in ("dining", "round"):
                    for k in range(random.randint(2, 6)):
                        a = 2 * math.pi * k / 6
                        cx, cy = (x0 + x1) / 2 + math.cos(a) * (x1 - x0) * 0.65, (y0 + y1) / 2 + math.sin(a) * (y1 - y0) * 0.65
                        outline(img, cv, box(cx - 200, cy - 200, cx + 200, cy + 200), ink, 1)
                elif name == "wardrobe":
                    line(img, cv.pt(x0, y0), cv.pt(x1, y1), ink, 1)
                elif name == "sofa":
                    outline(img, cv, box(x0 + 150, y0 + 200, x1 - 150, y1), ink, 1)
                elif name == "tub":
                    outline(img, cv, box(x0 + 80, y0 + 80, x1 - 80, y1 - 80), ink, 1)


# ---------- 文字、尺寸、其他 ----------

def font(size, zh=True):
    names = FONTS_ZH if zh and FONTS_ZH else FONTS_EN
    try:
        return ImageFont.truetype(str(FONT_DIR / random.choice(names)), max(8, int(size)))
    except OSError:
        return ImageFont.load_default()


def draw_texts(img, cv, plan, st):
    pil = Image.fromarray(img[..., ::-1])
    dr = ImageDraw.Draw(pil)
    color = tuple(int(c) for c in st["ink"][::-1])
    size = float(np.clip(random.uniform(250, 450) * cv.s, 8, 26))  # 字高約 25~45 cm(圖面比例),但不小於 8 px
    for kind, poly in plan.rooms + [("balcony", b) for b in plan.balconies]:
        if random.random() < 0.15:
            continue
        name = random.choice(ROOM_NAMES.get(kind, ["ROOM"]))
        zh = any("\u4e00" <= ch <= "\u9fff" for ch in name)
        p = poly.representative_point()
        x, y = cv.pt(p.x, p.y)
        f = font(size, zh)
        lines = [name]
        if random.random() < 0.6:
            a = poly.area / 1e6
            lines.append(random.choice([f"{a:.1f} m²", f"{a / 3.3058:.1f}坪", f"{a:.2f}m2",
                                        f"{(poly.bounds[2] - poly.bounds[0]) / 1000:.1f} x {(poly.bounds[3] - poly.bounds[1]) / 1000:.1f}"]))
        for i, s in enumerate(lines):
            dr.text((x, y + i * size * 1.2), s, fill=color, font=f if i == 0 else font(size * 0.8, "坪" in s), anchor="mm")
    if st["extras"]:
        f = font(size * random.uniform(1.5, 2.5))
        dr.text((cv.m * 0.5, cv.h - cv.m * 0.4), random.choice(["一樓平面圖", "PLAN", "FLOOR PLAN 1:100", "平面配置圖", "2F"]),
                fill=color, font=f, anchor="lm")
        if random.random() < 0.5:  # 浮水印
            wm = Image.new("L", pil.size, 0)
            ImageDraw.Draw(wm).text((pil.size[0] / 2, pil.size[1] / 2), random.choice(["SAMPLE", "Floorplanner", "預覽", "DRAFT"]),
                                    fill=random.randint(25, 60), font=font(pil.size[0] / 8), anchor="mm")
            wm = wm.rotate(random.uniform(-30, 30))
            pil.paste((150, 150, 150), (0, 0), wm)
    img[:] = np.array(pil)[..., ::-1]


def draw_dims(img, cv, plan, st):
    ink = tint(st["ink"], 20) if random.random() < 0.6 else (60, 60, 200)
    x0, y0, x1, y1 = plan.walls.bounds
    gap = cv.m * random.uniform(0.3, 0.6)
    pil = None
    for horizontal in (True, False):
        if random.random() < 0.15:
            continue
        if horizontal:
            a, b = cv.pt(x0, y1 if cv.flip else y0), cv.pt(x1, y1 if cv.flip else y0)
            a, b = (a[0], a[1] - gap), (b[0], b[1] - gap)
        else:
            a, b = cv.pt(x0, y0), cv.pt(x0, y1)
            a, b = (a[0] - gap, a[1]), (b[0] - gap, b[1])
        line(img, a, b, ink, 1)
        n_seg = random.randint(1, 5)
        ticks = [a] + [(a[0] + (b[0] - a[0]) * k / n_seg, a[1] + (b[1] - a[1]) * k / n_seg) for k in range(1, n_seg)] + [b]
        for p in ticks:
            d = 6
            line(img, (p[0] - d, p[1] + d), (p[0] + d, p[1] - d), ink, 1)
        pil = pil or Image.fromarray(img[..., ::-1])
        dr = ImageDraw.Draw(pil)
        f = font(random.uniform(9, 16), False)
        for p, q in zip(ticks, ticks[1:]):
            mm = math.hypot(q[0] - p[0], q[1] - p[1]) / cv.s
            mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2 - (8 if horizontal else 0))
            dr.text(mid if horizontal else (mid[0] - 10, mid[1]), f"{mm:.0f}", fill=tuple(int(c) for c in ink[::-1]), font=f, anchor="mm")
    if pil is not None:
        img[:] = np.array(pil)[..., ::-1]


def draw_grid(img, cv, plan):
    c = (random.randint(100, 200),) * 3
    x0, y0, x1, y1 = plan.walls.bounds
    for x in np.linspace(x0, x1, random.randint(2, 5)):
        a, b = cv.pt(x, y0), cv.pt(x, y1)
        for t in np.arange(0, 1, 0.04):
            if int(t * 25) % 2 == 0:
                line(img, (a[0], a[1] + (b[1] - a[1]) * t - cv.m * 0.3), (a[0], a[1] + (b[1] - a[1]) * (t + 0.03) - cv.m * 0.3), c, 1)
        cv2.circle(img, (int(a[0]), int(min(a[1], b[1]) - cv.m * 0.6)), 10, c, 1, cv2.LINE_AA)


def draw_balcony_rail(img, cv, plan, st):
    for b in plan.balconies:
        if random.random() < 0.6:
            edge = b.buffer(-30)
            outline(img, cv, edge, tint(st["ink"], 40), 1)


# ---------- 畫質 ----------

def degrade(img, label, st):
    h, w = img.shape[:2]
    if st["hand"]:  # 手繪 / 不規則:平滑的位移場,圖和標註一起扭
        amp = random.uniform(1, 4)
        dx = cv2.GaussianBlur((np.random.rand(h, w).astype(np.float32) - 0.5) * 2, (0, 0), 25) * amp * 25
        dy = cv2.GaussianBlur((np.random.rand(h, w).astype(np.float32) - 0.5) * 2, (0, 0), 25) * amp * 25
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        img = cv2.remap(img, gx + dx, gy + dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        label = cv2.remap(label, gx + dx, gy + dy, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if st["rotate"]:
        ang = random.uniform(-3, 3)
        M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1)
        img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        label = cv2.warpAffine(label, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    if st["lowres"]:
        k = random.uniform(0.4, 0.75)
        small = cv2.resize(img, (max(8, int(w * k)), max(8, int(h * k))), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    if st["blur"]:
        img = cv2.GaussianBlur(img, (0, 0), random.uniform(0.5, 1.4))
    if st["scan"]:
        f = img.astype(np.float32)
        f += np.random.normal(0, random.uniform(3, 12), f.shape)
        shade = cv2.resize(np.random.rand(4, 4).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        f *= (1 - random.uniform(0, 0.12) * shade)[..., None]
        if random.random() < 0.5:
            f = (f - 128) * random.uniform(0.75, 1.15) + 128 + random.uniform(-20, 15)
        img = np.clip(f, 0, 255).astype(np.uint8)
        if random.random() < 0.3:
            img = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    if st["jpeg"]:
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, random.randint(30, 92)])
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return img, label


# ---------- 主程式 ----------

def render(plan: Plan, seed=None, style=None):
    """回傳 (BGR 圖, 標註, style)。"""
    if seed is not None:
        random.seed(seed)
        np.random.seed(seed % (2 ** 32))
    st = style or sample_style(plan)
    cv = Canvas(plan, st["px_per_mm"], random.randint(30, 120), random.random() < 0.5)
    img = np.full((cv.h, cv.w, 3), st["paper"], np.uint8)
    label = np.zeros((cv.h, cv.w), np.uint8)

    draw_floor(img, cv, plan, st)
    if st["grid"]:
        draw_grid(img, cv, plan)
    draw_furniture(img, cv, plan, st)
    draw_balcony_rail(img, cv, plan, st)
    draw_walls(img, cv, plan, st)
    draw_windows(img, cv, plan, st)
    draw_doors(img, cv, plan, st)
    if st["text"]:
        draw_texts(img, cv, plan, st)
    if st["dims"]:
        draw_dims(img, cv, plan, st)

    fill(label, cv, plan.walls, WALL)
    for d in plan.doors:
        fill(label, cv, d, DOOR)
    for wdw in plan.windows:
        fill(label, cv, wdw, WINDOW)

    img, label = degrade(img, label, st)
    return img, label, st


def colorize(label):
    pal = np.array([[255, 255, 255], [40, 40, 40], [60, 180, 60], [220, 140, 30]], np.uint8)
    return pal[label]
