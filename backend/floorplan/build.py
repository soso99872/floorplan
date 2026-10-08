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

from . import ml
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

    def __init__(self, scene, overlay_png, log, cad=None):
        self.scene = scene
        self.overlay_png = overlay_png
        self.log = log
        self.cad = cad  # CAD 匯入時的圖層資訊 {"layers": [{name, count, role}]}


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


class Frame:
    """像素 → 模型 mm 的換算(模型 y 向上,原點在圖的左下角)。"""

    def __init__(self, mm_per_px, img_h):
        self.mm_per_px = mm_per_px
        self.img_h = img_h

    def __call__(self, p):
        return (round(float(p[0]) * self.mm_per_px, 1), round(float(self.img_h - p[1]) * self.mm_per_px, 1))


def make_walls(clean, t, mm_per_px, openings, wall_height, log, t_max=None):
    """開口填回牆裡再規整一次:牆段會連續穿過門窗。回傳 (像素牆段, Scene 牆段, 換算)。"""
    filled = clean.copy()
    for o in openings:
        x, y, w, h = o["rect"]
        filled[y:y + h, x:x + w] = 255
    rects, leftovers, _ = rz.regularize_walls(filled, t, t_max)
    walls_px = [rect_to_segment(*r) for r in rects] + [poly_to_segment(p) for p in leftovers]
    to_mm = Frame(mm_per_px, clean.shape[0])
    scene_walls = [
        Wall(id=f"w{i + 1}", a=to_mm(a), b=to_mm(b), thickness=round(th * mm_per_px, 1), height=wall_height)
        for i, (a, b, th) in enumerate(walls_px)
    ]
    log.append(f"[牆] {len(scene_walls)} 段")
    return walls_px, scene_walls, to_mm


def door_from_arc(o, wall):
    """CAD 門弧的方向 → Scene 的 swing / hinge(以牆段 a→b 為準)。"""
    a, b = np.array(wall[0], float), np.array(wall[1], float)
    u = (b - a) / np.linalg.norm(b - a)
    left = np.array([-u[1], u[0]])
    # 圖片座標的左手邊在 y 向上的模型座標是右手邊,所以反號
    res = {"swing": -1 if left @ np.array(o["out_px"]) > 0 else 1}
    if "hinge_px" in o:
        x, y, w, h = o["rect"]
        center = (np.array([x + w / 2, y + h / 2]) - a) @ u
        res["hinge"] = "start" if (np.array(o["hinge_px"]) - a) @ u < center else "end"
    return res


def make_openings(openings, walls_px, scene_walls, clean, mm_per_px, log):
    """開口(像素矩形)掛到牆段上。

    開口可以帶 CAD 讀到的確定值蓋過推測:leaves、width_mm,
    以及門弧推出的 out_px(門片打開時朝向的方向,像素座標)與 hinge_px(鉸鏈位置)。"""
    wall_dist = cv2.distanceTransform(cv2.bitwise_not(clean), cv2.DIST_L2, 5)
    result = []
    for o in openings:
        hit = attach_opening(o, walls_px)
        if hit is None:
            log.append(f"[警告] 有一個開口找不到所在的牆,略過(位置 {o['rect'][:2]})")
            continue
        i, _, along = hit
        x, y, w, h = o["rect"]
        width = o.get("width_mm") or max(w, h) * mm_per_px
        if "out_px" in o:
            o = dict(o, **door_from_arc(o, walls_px[i][:2]))
        kind = o["kind"]
        if kind == "door" and width > PASSAGE_WIDTH and "leaves" not in o:
            kind = "passage"
        if kind == "door":
            # 圖片座標的左手邊,換到 y 向上的模型座標會變成右手邊,所以要反號
            swing = o.get("swing") or -swing_side(o, walls_px[i][:2], wall_dist, clean.shape)
            leaves = o.get("leaves") or (2 if width > DOUBLE_DOOR_WIDTH else 1)
        else:
            swing, leaves = 1, 0
        result.append(Opening(
            id=f"o{len(result) + 1}",
            wall=scene_walls[i].id,
            kind=kind,
            offset=round(along * mm_per_px, 1),
            width=round(width, 1),
            sill=rz.WINDOW_SILL if kind == "window" else 0,
            head=rz.DOOR_HEAD,
            leaves=leaves,
            swing=swing,
            hinge=o.get("hinge", "start"),
            exterior=bool(o["outer"]),
        ))
    n_kind = {k: sum(o.kind == k for o in result) for k in ("window", "door", "passage")}
    log.append(f"[開口] 窗 {n_kind['window']}、門 {n_kind['door']}、通道 {n_kind['passage']}")
    return result, wall_dist


def make_rooms(labels, room_ids, to_mm, name_of, color_of, log):
    """房間 label 圖 → 房間多邊形。name_of(r, polygon_mm)、color_of(r) 由呼叫端決定。"""
    rooms = []
    for r in room_ids:
        m = (labels == r).astype(np.uint8)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnt = cv2.approxPolyDP(max(cnts, key=cv2.contourArea), 2.0, True)[:, 0, :]
        if len(cnt) < 3:
            continue
        poly = [to_mm(p) for p in cnt]
        rooms.append(Room(
            id=f"r{len(rooms) + 1}",
            name=name_of(r, poly),
            polygon=poly,
            area=round(Polygon(poly).area / 1e6, 2),
            floor_color=color_of(r),
        ))
    log.append(f"[房間] {len(rooms)} 間:" + "、".join(f"{r.name} {r.area:g} m²" for r in rooms))
    return rooms


ENGINES = ("auto", "ml", "rules")


def outer_of(rect, wall_box, t):
    """開口是否在外牆上(跟 recognize.classify 同一個判斷)。"""
    x, y, w, h = rect
    x0, y0, x1, y1 = wall_box
    if w >= h:
        return y - y0 < 2 * t or y1 - (y + h) < 2 * t
    return x - x0 < 2 * t or x1 - (x + w) < 2 * t


def ridge_thickness(mask, q=50):
    """牆厚 = 牆中心線上「到牆邊距離」的中位數 × 2。
    比「最常見的連續長度」穩:模型的牆遮罩裡沒有文字筆畫,但牆有粗有細,眾數容易被細牆或雜點帶偏。"""
    dist = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    ridge = (dist >= cv2.dilate(dist, np.ones((3, 3), np.uint8))) & (dist >= 1.5)
    if not ridge.any():
        return rz.wall_thickness(mask)
    return max(3, int(round(2 * float(np.percentile(dist[ridge], q)))))


def ml_walls(im):
    """模型的分割結果(縮放回原圖大小)→ 牆遮罩、牆厚、分割圖。"""
    seg, scale = ml.segment(im)
    if scale != 1:
        seg = cv2.resize(seg, (im.shape[1], im.shape[0]), interpolation=cv2.INTER_NEAREST)
    raw = (seg == ml.WALL).astype(np.uint8) * 255
    n, lab, st, _ = cv2.connectedComponentsWithStats(raw)
    if n <= 1:
        raise rz.PlanError("找不到牆(機器學習)")
    t = ridge_thickness(raw)
    keep = np.zeros_like(raw)  # 去掉零星的小誤判
    for i in range(1, n):
        if max(st[i, 2], st[i, 3]) >= 4 * t:
            keep[lab == i] = 255
    return keep, t, seg, ridge_thickness(keep, 95)


def ml_openings(seg, clean, t, wall_box, mm_per_px, value):
    """門窗:模型標出來的門 / 窗區塊為主;牆上還有沒被模型標到的缺口,用規則補上、依缺口裡模型的投票分門窗。"""
    found = []
    for kind, v in (("door", ml.DOOR), ("window", ml.WINDOW)):
        for r in ml.opening_rects(seg, v, t):
            found.append({"rect": r, "kind": kind, "outer": outer_of(r, wall_box, t)})

    def overlaps(a, b):
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah

    for g in rz.classify(rz.find_openings(clean, t, 1 / mm_per_px), wall_box, t, value):
        if any(overlaps(g["rect"], f["rect"]) for f in found):
            continue
        x, y, w, h = g["rect"]
        sub = seg[max(0, y - t):y + h + t, max(0, x - t):x + w + t]
        votes = {"door": int((sub == ml.DOOR).sum()), "window": int((sub == ml.WINDOW).sum())}
        if max(votes.values()) > 0:
            g["kind"] = max(votes, key=votes.get)
        found.append(g)
    return found


def build_scene(src, width_mm=DEFAULT_WIDTH_MM, wall_height=DEFAULT_WALL_HEIGHT, with_background=True,
                engine="rules"):
    """width_mm = 外牆總寬(圖上最左到最右外牆外緣的實際長度);給 None 時用牆厚估比例尺。
    engine:rules = 規則(深色粗線是牆)、ml = 機器學習分割模型、auto = 有模型就用模型。"""
    cv2.setRNGSeed(0)  # 家具分色用 k-means,固定亂數種子,同一張圖每次結果才一樣
    log = []
    im = rz.load_image(src)
    if engine == "auto":
        engine = "ml" if ml.available() else "rules"
    if engine == "ml":
        if not ml.available():
            raise rz.PlanError("機器學習模型不存在(backend/models/floorplan-seg.onnx),請改用規則辨識")
        raw, t, seg, t_max = ml_walls(im)
        log.append("[辨識方式] 機器學習模型")
    else:
        raw, t = rz.wall_mask(im)
        seg, t_max = None, None
        log.append("[辨識方式] 規則(深色粗線)")
    rects, leftovers, clean = rz.regularize_walls(raw, t, t_max)
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
    if seg is not None:
        openings = ml_openings(seg, clean, t, wall_box, mm_per_px, value)
    else:
        openings = rz.classify(rz.find_openings(clean, t, 1 / mm_per_px), wall_box, t, value)
    walls_px, scene_walls, to_mm = make_walls(clean, t, mm_per_px, openings, wall_height, log, t_max)
    scene_openings, wall_dist = make_openings(openings, walls_px, scene_walls, clean, mm_per_px, log)

    lab = rz.image_lab(im)
    labels, room_ids = rz.segment_rooms(clean, openings, t, mm_per_px)
    items = rz.detect_furniture(im, lab, labels, room_ids, t, mm_per_px)
    scene_furniture = []
    for f in items:
        pl = rz.place_furniture(f, wall_dist, to_mm)
        pl.update({k: round(pl[k], 1) for k in ("x", "y", "width", "depth")}, angle=round(pl["angle"], 2))
        scene_furniture.append(Furniture(id=f"f{len(scene_furniture) + 1}", **pl))
    log.append(f"[家具] {len(scene_furniture)} 件")

    used = {}

    def name_of(r, _poly):
        return room_name({f["type"] for f in items if f["room"] == r}, used)

    def color_of(r):
        floor = rz.floor_color(lab[labels == r])
        bgr = cv2.cvtColor(np.uint8([[[floor[0] * 255 / 100, floor[1] + 128, floor[2] + 128]]]), cv2.COLOR_LAB2BGR)[0, 0]
        return "#%02x%02x%02x" % tuple(int(c) for c in bgr[::-1])

    scene_rooms = make_rooms(labels, room_ids, to_mm, name_of, color_of, log)

    background = None
    if with_background:
        background = Background(src=data_url(im), width=im.shape[1] * mm_per_px, height=im.shape[0] * mm_per_px)
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
    ap.add_argument("--engine", default="auto", choices=ENGINES, help="辨識方式")
    a = ap.parse_args()
    try:
        r = build_scene(a.image, a.width, a.height, engine=a.engine)
    except rz.PlanError as e:
        sys.exit(str(e))
    print("\n".join(r.log))
    if a.out:
        Path(a.out).write_text(json.dumps(r.scene.model_dump(), ensure_ascii=False), encoding="utf-8")
        print(f"[輸出] {a.out}")


if __name__ == "__main__":
    main()
