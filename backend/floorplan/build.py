"""把辨識結果組成 Scene JSON。

流程:
  1. 找牆(像素) → 規整成直角矩形
  2. 找門窗開口
  3. 把開口「填回」牆裡再規整一次 → 牆變成連續的牆段,開口掛在牆段上(沿牆位置)
     這樣編輯器才能把門窗沿著牆拖、刪掉門窗牆會自動補起來
  4. 房間、家具
  5. 全部換算成 mm(模型座標:y 向上,原點在原圖左下角)

用法: python -m floorplan.build plan.png [--width 12000] [-o scene.json]
"""
import argparse
import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from shapely.geometry import Polygon

from . import recognize as rz
from .scene import Background, Furniture, Meta, Opening, Room, Scene, Wall

DEFAULT_WIDTH_MM = 12000
TYPICAL_WALL_MM = 150  # 沒給尺寸時,假設圖上最常見的牆厚是 15 cm 來估比例尺
DEFAULT_WALL_HEIGHT = 3000
PASSAGE_WIDTH = 1800  # 比這寬的門洞是開放通道,不放門片
DOUBLE_DOOR_WIDTH = 1200  # 比這寬的是雙開門

# 房間名稱:看房間裡有什麼家具來猜
# 依序比對:有床就是臥室;有沙發的是客廳(開放式空間常同時有餐桌、電視櫃)
ROOM_NAMES = [
    ("bed", "臥室"),
    ("sofa", "客廳"),
    ("counter", "廚房"),
    ("table", "餐廳"),
    ("fixture", "衛浴"),
]


class Recognition:
    """辨識結果:Scene 加上給使用者看的偵錯資訊。"""

    def __init__(self, scene, overlay_png, log):
        self.scene = scene
        self.overlay_png = overlay_png
        self.log = log


def data_url(img):
    ok, buf = cv2.imencode(".png", img)
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def rect_to_segment(x0, y0, x1, y1):
    """規整後的牆矩形(像素) -> 中心線兩端點 + 厚度。"""
    if x1 - x0 >= y1 - y0:
        yc = (y0 + y1) / 2
        return (x0, yc), (x1, yc), y1 - y0
    xc = (x0 + x1) / 2
    return (xc, y0), (xc, y1), x1 - x0


def poly_to_segment(poly):
    """不規則牆(輪廓點)用最小外接矩形近似成一段牆。"""
    (cx, cy), (w, h), ang = cv2.minAreaRect(poly.astype(np.float32))
    if w < h:
        w, h, ang = h, w, ang + 90
    d = np.array([np.cos(np.radians(ang)), np.sin(np.radians(ang))]) * w / 2
    return tuple(np.array([cx, cy]) - d), tuple(np.array([cx, cy]) + d), h


def attach_opening(o, walls_px):
    """找開口所在的牆段:方向相同、開口中心落在牆的厚度範圍內和長度範圍內。"""
    x, y, w, h = o["rect"]
    c = np.array([x + w / 2, y + h / 2])
    best = None
    for i, (a, b, th) in enumerate(walls_px):
        a, b = np.array(a), np.array(b)
        d = b - a
        L = np.linalg.norm(d)
        if L < 1e-6:
            continue
        u = d / L
        along = (c - a) @ u
        across = abs((c - a) @ np.array([-u[1], u[0]]))
        horizontal_wall = abs(u[0]) > abs(u[1])
        if horizontal_wall != (w >= h) or not (0 <= along <= L) or across > th:
            continue
        if best is None or across < best[1]:
            best = (i, across, along)
    return best


def swing_side(o, wall, wall_dist, img_shape):
    """門往哪一側開:大門往室內,內門往比較寬敞的一側。回傳 +1(牆的左手邊)或 -1。"""
    (ax, ay), (bx, by) = wall
    u = np.array([bx - ax, by - ay], float)
    u /= np.linalg.norm(u)
    left = np.array([-u[1], u[0]])  # 圖片座標下 a→b 的左手邊
    x, y, w, h = o["rect"]
    c = np.array([x + w / 2, y + h / 2])
    if o["outer"]:
        center = np.array(img_shape[::-1], float) / 2
        return 1 if left @ (center - c) > 0 else -1
    reach = min(max(w, h), 80)

    def free(d):
        px, py = np.clip(c + d * reach, 0, np.array(img_shape[::-1]) - 1).astype(int)
        return wall_dist[py, px]

    return 1 if free(left) >= free(-left) else -1


def room_name(types, used):
    for t, name in ROOM_NAMES:
        if t in types:
            n = used.get(name, 0) + 1
            used[name] = n
            return name if n == 1 else f"{name} {n}"
    n = used.get("房間", 0) + 1
    used["房間"] = n
    return f"房間 {n}"


def build_scene(src, width_mm=DEFAULT_WIDTH_MM, wall_height=DEFAULT_WALL_HEIGHT, with_background=True):
    """width_mm = 外牆總寬(圖上最左到最右外牆外緣的實際長度);給 None 時用牆厚估比例尺。"""
    cv2.setRNGSeed(0)  # 家具分色用 k-means,固定亂數種子,同一張圖每次結果才一樣
    log = []
    im = rz.load_image(src)
    raw, t = rz.wall_mask(im)
    rects, leftovers, clean = rz.regularize_walls(raw, t)
    ys, xs = np.nonzero(clean)
    wall_box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    width_px = wall_box[2] - wall_box[0]
    if width_mm:
        mm_per_px = width_mm / width_px
        log.append(f"[比例] 外牆寬 {width_px} px = {width_mm:g} mm,1 px = {mm_per_px:.2f} mm;"
                   f"牆厚約 {t} px ≈ {t * mm_per_px:.0f} mm")
    else:
        mm_per_px = TYPICAL_WALL_MM / t
        log.append(f"[比例] 沒有給尺寸,假設牆厚 {TYPICAL_WALL_MM} mm 估算:1 px ≈ {mm_per_px:.2f} mm,"
                   f"外牆總寬約 {width_px * mm_per_px / 1000:.1f} m(請核對)")

    value = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)[..., 2]
    openings = rz.classify(rz.find_openings(clean, t, 1 / mm_per_px), wall_box, t, value)

    # 開口填回牆裡再規整一次:牆段會連續穿過門窗
    filled = clean.copy()
    for o in openings:
        x, y, w, h = o["rect"]
        filled[y:y + h, x:x + w] = 255
    rects2, leftovers2, _ = rz.regularize_walls(filled, t)
    walls_px = [rect_to_segment(*r) for r in rects2] + [poly_to_segment(p) for p in leftovers2]

    img_h = im.shape[0]
    to_mm = lambda p: (round(float(p[0]) * mm_per_px, 1), round(float(img_h - p[1]) * mm_per_px, 1))

    scene_walls = [
        Wall(id=f"w{i + 1}", a=to_mm(a), b=to_mm(b), thickness=round(th * mm_per_px, 1), height=wall_height)
        for i, (a, b, th) in enumerate(walls_px)
    ]
    log.append(f"[牆] {len(scene_walls)} 段")

    wall_dist = cv2.distanceTransform(cv2.bitwise_not(clean), cv2.DIST_L2, 5)
    scene_openings = []
    for o in openings:
        hit = attach_opening(o, walls_px)
        if hit is None:
            log.append(f"[警告] 有一個開口找不到所在的牆,略過(位置 {o['rect'][:2]})")
            continue
        i, _, along = hit
        x, y, w, h = o["rect"]
        width = max(w, h) * mm_per_px
        kind = o["kind"]
        if kind == "door" and width > PASSAGE_WIDTH:
            kind = "passage"
        scene_openings.append(Opening(
            id=f"o{len(scene_openings) + 1}",
            wall=scene_walls[i].id,
            kind=kind,
            offset=round(along * mm_per_px, 1),
            width=round(width, 1),
            sill=rz.WINDOW_SILL if kind == "window" else 0,
            head=rz.DOOR_HEAD,
            leaves=0 if kind != "door" else (2 if width > DOUBLE_DOOR_WIDTH else 1),
            # 圖片座標的左手邊,換到 y 向上的模型座標會變成右手邊,所以要反號
            swing=-swing_side(o, walls_px[i][:2], wall_dist, clean.shape) if kind == "door" else 1,
            exterior=bool(o["outer"]),
        ))
    n_kind = {k: sum(o.kind == k for o in scene_openings) for k in ("window", "door", "passage")}
    log.append(f"[開口] 窗 {n_kind['window']}、門 {n_kind['door']}、通道 {n_kind['passage']}")

    lab = rz.image_lab(im)
    labels, room_ids = rz.segment_rooms(clean, openings, t, mm_per_px)
    items = rz.detect_furniture(im, lab, labels, room_ids, t, mm_per_px)
    scene_furniture = []
    for f in items:
        pl = rz.place_furniture(f, wall_dist, to_mm)
        pl.update({k: round(pl[k], 1) for k in ("x", "y", "width", "depth")}, angle=round(pl["angle"], 2))
        scene_furniture.append(Furniture(id=f"f{len(scene_furniture) + 1}", **pl))
    log.append(f"[家具] {len(scene_furniture)} 件")

    scene_rooms, used = [], {}
    for r in room_ids:
        m = (labels == r).astype(np.uint8)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnt = cv2.approxPolyDP(max(cnts, key=cv2.contourArea), 2.0, True)[:, 0, :]
        if len(cnt) < 3:
            continue
        poly = [to_mm(p) for p in cnt]
        floor = rz.floor_color(lab[labels == r])
        floor_bgr = cv2.cvtColor(np.uint8([[[floor[0] * 255 / 100, floor[1] + 128, floor[2] + 128]]]), cv2.COLOR_LAB2BGR)[0, 0]
        types = {f["type"] for f in items if f["room"] == r}
        scene_rooms.append(Room(
            id=f"r{len(scene_rooms) + 1}",
            name=room_name(types, used),
            polygon=poly,
            area=round(Polygon(poly).area / 1e6, 2),
            floor_color="#%02x%02x%02x" % tuple(int(c) for c in floor_bgr[::-1]),
        ))
    log.append(f"[房間] {len(scene_rooms)} 間:" + "、".join(f"{r.name} {r.area:g} m²" for r in scene_rooms))

    background = None
    if with_background:
        background = Background(src=data_url(im), width=im.shape[1] * mm_per_px, height=img_h * mm_per_px)
    scene = Scene(
        meta=Meta(mm_per_px=mm_per_px, wall_height=wall_height, wall_thickness=round(t * mm_per_px, 1),
                  background=background),
        walls=scene_walls, openings=scene_openings, rooms=scene_rooms, furniture=scene_furniture,
    )
    return Recognition(scene, overlay(im, clean, openings, items), log)


def overlay(im, clean, openings, items):
    """偵錯疊圖:紅 = 牆,藍 = 窗,綠 = 門,紫框 = 家具。"""
    out = im.copy()
    out[clean > 0] = (40, 40, 220)
    for o in openings:
        x, y, w, h = o["rect"]
        color = (60, 180, 60) if o["kind"] == "door" else (220, 140, 30)
        cv2.rectangle(out, (x, y), (x + w, y + h), color, -1)
    out = cv2.addWeighted(im, 0.45, out, 0.55, 0)
    for f in items:
        cv2.polylines(out, [cv2.boxPoints(rz.axis_rect(f)).astype(np.int32)], True, (200, 60, 200), 2)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--width", type=float, default=DEFAULT_WIDTH_MM, help="外牆總寬度 mm")
    ap.add_argument("--height", type=float, default=DEFAULT_WALL_HEIGHT, help="牆高 mm")
    ap.add_argument("-o", "--out", help="輸出 scene.json 路徑")
    a = ap.parse_args()
    try:
        r = build_scene(a.image, a.width, a.height)
    except rz.PlanError as e:
        sys.exit(str(e))
    print("\n".join(r.log))
    if a.out:
        Path(a.out).write_text(json.dumps(r.scene.model_dump(), ensure_ascii=False), encoding="utf-8")
        print(f"[輸出] {a.out}")


if __name__ == "__main__":
    main()
