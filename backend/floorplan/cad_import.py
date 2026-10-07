"""AutoCAD 平面圖(DXF;DWG 先用 ODA File Converter 轉成 DXF)→ Scene。

跟圖片辨識共用後段(build.make_walls / make_openings / make_rooms),差別在前段:
  - 比例尺是精確的(看檔案的單位設定),不用猜
  - 牆:牆圖層的線畫成遮罩,雙線牆中間的窄縫填滿
  - 門:門弧(ARC)的圓心 = 鉸鏈,半徑 = 門片寬,打開的方向 = 往哪一側開
  - 窗:窗圖層的線
  - 家具:圖塊(INSERT),種類看圖塊名稱
  - 房間名稱:房間裡的文字
圖層靠名稱判斷角色(見 ROLE_KEYWORDS),使用者可以用 layer_roles 改。
"""
import glob
import io
import math
import os
import re
import tempfile
from pathlib import Path

import cv2
import ezdxf
import numpy as np
from ezdxf import bbox as dxfbbox
from ezdxf import path as dxfpath
from ezdxf import recover, units
from ezdxf.addons import odafc

from . import recognize as rz
from .build import Recognition, data_url, make_openings, make_rooms, make_walls, overlay, room_name
from .scene import Background, Furniture, Meta, Scene

ROLES = ("wall", "door", "window", "furniture", "text", "other", "ignore")
# 依序比對圖層名稱(不分大小寫),先比到的算數;都沒比到 = other(只畫在底圖)
ROLE_KEYWORDS = [
    ("ignore", ["DIM", "標註", "标注", "尺寸", "AXIS", "軸", "轴", "GRID", "TITLE", "圖框", "图框", "DEFPOINTS",
                "VIEWPORT", "VPORT"]),
    ("door", ["DOOR", "門", "门"]),
    ("window", ["WIN", "GLAZ", "窗"]),
    ("furniture", ["FURN", "家具", "傢俱", "傢具", "EQPM", "FIXT", "潔具", "洁具", "PLUMB", "衛浴", "卫浴"]),
    ("wall", ["WALL", "牆", "墙", "壁", "COLS", "COLUMN", "柱"]),
    ("text", ["AREA", "ROOM", "IDEN", "TEXT", "文字", "房間", "房间", "空間", "空间"]),
]
# 圖塊名稱 → 家具種類(順序重要:coffee table 要先比到 low_table)
FURNITURE_KEYWORDS = [
    ("low_table", ["COFFEE", "茶几", "矮櫃", "矮柜", "TV", "電視", "电视"]),
    ("counter", ["KITCHEN", "COUNTER", "STOVE", "COOK", "SINK-K", "流理", "爐", "炉", "灶", "廚", "厨"]),
    ("bed", ["BED", "床"]),
    ("sofa", ["SOFA", "COUCH", "CHAIR", "ARMCHAIR", "沙發", "沙发", "椅"]),
    ("table", ["TABLE", "DINING", "DESK", "桌", "餐"]),
    ("wardrobe", ["WARDROBE", "CLOSET", "衣櫃", "衣柜", "衣櫥", "衣橱"]),
    ("cabinet", ["CABINET", "SHELF", "BOOK", "櫃", "柜", "架"]),
    ("fixture", ["TOILET", "WC", "BASIN", "LAV", "BATH", "TUB", "SHOWER", "SINK", "FRIDGE", "WASH",
                 "馬桶", "马桶", "坐便", "浴", "洗手", "洗臉", "洗脸", "冰箱", "洗衣"]),
    ("lamp", ["LAMP", "LIGHT", "燈", "灯"]),
    ("rug", ["RUG", "CARPET", "地毯"]),
]
FURNITURE_COLORS = {
    "bed": "#d9cdb8", "sofa": "#8d8f96", "table": "#a47b54", "low_table": "#9c7b5c", "wardrobe": "#c9b79c",
    "cabinet": "#b9a58a", "counter": "#d6d3cc", "fixture": "#eef1f2", "lamp": "#e9dcc0", "rug": "#b8a68f",
    "other": "#b0a89c",
}
DOOR_LEAF_MM = (300, 1300)  # 門弧半徑的合理範圍
WALL_GAP_MM = 450  # 雙線牆兩條線的距離小於這個 = 牆身,中間要填滿
MM_PER_PX = 10.0
MAX_PX = 5000
MARGIN_MM = 1000
AREA_TEXT = re.compile(r"^[\s\d.,:()（）]*(m²|m2|㎡|平方米|平米|坪|sq\.?\s*ft|sf)?[\s\d.,()（）]*$", re.I)


class CadError(rz.PlanError):
    pass


# ---------- 讀檔 ----------

def find_odafc():
    """ODA File Converter 的位置:環境變數 ODA_CONVERTER,或 Windows 預設安裝路徑。"""
    env = os.environ.get("ODA_CONVERTER")
    if env and Path(env).exists():
        return env
    for pattern in (r"C:\Program Files\ODA\ODAFileConverter*\ODAFileConverter.exe",
                    r"C:\Program Files (x86)\ODA\ODAFileConverter*\ODAFileConverter.exe"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    return None


def read_document(data: bytes, filename: str):
    if filename.lower().endswith(".dwg"):
        exe = find_odafc()
        if not exe:
            raise CadError("DWG 需要先安裝免費的 ODA File Converter 才能讀;或在 AutoCAD 用「另存新檔」存成 DXF 再上傳")
        ezdxf.options.set("odafc-addon", "win_exec_path", exe)
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "plan.dwg"
            src.write_bytes(data)
            try:
                return odafc.readfile(str(src))
            except odafc.ODAFCError as e:
                raise CadError(f"DWG 轉檔失敗:{e}")
    try:
        doc, auditor = recover.read(io.BytesIO(data))
    except (ezdxf.DXFStructureError, IOError):
        try:
            doc, auditor = recover.read(io.BytesIO(patch_legacy_dxf(data)))
        except (ezdxf.DXFStructureError, IOError, UnicodeDecodeError) as e:
            raise CadError(f"讀不到這個 DXF 檔:{e}")
    return doc


def patch_legacy_dxf(data: bytes) -> bytes:
    """有些程式輸出的 DXF 標成 R12、卻用了沒有子類別標記的 LWPOLYLINE,AutoCAD 讀得了、ezdxf 不行。
    補上子類別標記並把版本改成 R2000。"""
    lines = [l.strip() for l in data.decode("utf-8", errors="replace").splitlines()]
    pairs = list(zip(lines[0::2], lines[1::2]))
    out, i = [], 0
    while i < len(pairs):
        code, value = pairs[i]
        if code == "1" and value == "AC1009" and out and out[-1] == ("9", "$ACADVER"):
            value = "AC1015"
        out.append((code, value))
        if code == "0" and value == "LWPOLYLINE":
            j = i + 1
            body = []
            while j < len(pairs) and pairs[j][0] != "0":
                body.append(pairs[j])
                j += 1
            if not any(c == "100" for c, _ in body):
                head = [t for t in body if t[0] in ("5", "8", "62", "6", "370")]
                rest = [t for t in body if t not in head]
                body = [("100", "AcDbEntity")] + head + [("100", "AcDbPolyline")] + rest
            out += body
            i = j
            continue
        i += 1
    return "".join(f"{c}\n{v}\n" for c, v in out).encode("utf-8")


def to_mm_factor(doc, extent):
    """檔案單位 → mm。沒設定單位時,依圖的大小猜(平面圖通常 5~100 m 寬)。"""
    code = doc.header.get("$INSUNITS", 0)
    if code:
        try:
            f = units.conversion_factor(code, units.MM)
            if 2000 <= extent * f <= 500000:
                return f, units.decode(code)
            note = f"(檔案設定 {units.decode(code)},但這樣整張圖只有 {extent * f / 1000:g} m,不合理)"
        except (KeyError, ValueError, TypeError):
            note = ""
    else:
        note = ""
    f, name = guess_unit(extent)
    return f, name + note


def guess_unit(extent):
    if extent < 300:
        return 1000.0, "m(猜測)"
    if extent < 3000:
        return 10.0, "cm(猜測)"
    return 1.0, "mm(猜測)"


# ---------- 取出圖元 ----------

def role_by_name(name, table):
    up = name.upper()
    for role, words in table:
        if any(w.upper() in up for w in words):
            return role
    return None


class Item:
    """攤平後的一個圖元(已經是世界座標)。"""

    def __init__(self, entity, layer, insert):
        self.e = entity
        self.layer = layer
        self.insert = insert  # 最外層的圖塊參照(沒有就是 None)


def walk(entities, layer=None, insert=None, depth=0):
    """把圖塊參照展開成世界座標的圖元;圖塊裡放在 0 層的東西跟著圖塊參照的圖層。"""
    for e in entities:
        own = e.dxf.get("layer", "0")
        eff = layer if (own == "0" and layer) else own
        if e.dxftype() == "INSERT":
            if depth > 8:
                continue
            try:
                children = list(e.virtual_entities())
            except Exception:
                continue
            yield from walk(children, eff, insert or e, depth + 1)
        else:
            yield Item(e, eff, insert)


def flatten(e, tol):
    """圖元 → 折線點列(世界座標)。"""
    kind = e.dxftype()
    try:
        if kind == "HATCH":
            return [list(p.flattening(tol)) for p in dxfpath.from_hatch(e)]
        if kind in ("TEXT", "MTEXT", "DIMENSION", "POINT", "ATTRIB", "ATTDEF", "VIEWPORT", "IMAGE", "WIPEOUT"):
            return []
        return [list(dxfpath.make_path(e).flattening(tol))]
    except Exception:
        return []


def text_of(e):
    if e.dxftype() == "MTEXT":
        s = e.plain_text()
    elif e.dxftype() == "TEXT":
        s = e.plain_text() if hasattr(e, "plain_text") else e.dxf.text
    else:
        return None
    s = s.strip().splitlines()[0].strip() if s.strip() else ""
    return s or None


# ---------- 主流程 ----------

class Raster:
    """CAD 座標(mm)↔ 像素。像素 y 向下,原點在 (x0, y1)。"""

    def __init__(self, x0, y0, x1, y1, mm_per_px):
        self.x0, self.y1, self.mpp = x0, y1, mm_per_px
        self.w = int(math.ceil((x1 - x0) / mm_per_px)) + 1
        self.h = int(math.ceil((y1 - y0) / mm_per_px)) + 1

    def px(self, pts):
        a = np.asarray(pts, float)[:, :2]
        return np.stack([(a[:, 0] - self.x0) / self.mpp, (self.y1 - a[:, 1]) / self.mpp], axis=1)

    def scene(self, x, y):
        """CAD 座標 → Scene 座標(跟 build.Frame 一致:原點在點陣圖左下角)。"""
        return x - self.x0, y - (self.y1 - self.h * self.mpp)

    def blank(self, value=0):
        return np.full((self.h, self.w), value, np.uint8)

    def draw(self, img, polylines, color=255, thickness=1):
        for pl in polylines:
            if len(pl) < 2:
                continue
            p = np.round(self.px(pl)).astype(np.int32)
            cv2.polylines(img, [p], False, color, thickness, cv2.LINE_8)

    def fill(self, img, polylines, color=255):
        ps = [np.round(self.px(pl)).astype(np.int32) for pl in polylines if len(pl) >= 3]
        if ps:
            cv2.fillPoly(img, ps, color)


def wall_mask_from_lines(lines_img, solid_img, mm_per_px):
    """牆線 → 實心牆:兩條牆線之間的窄縫(寬度小於 WALL_GAP_MM)填滿。"""
    free = cv2.bitwise_not(lines_img)
    k = max(3, int(round(WALL_GAP_MM / mm_per_px)) | 1)
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    roomy = cv2.morphologyEx(free, cv2.MORPH_OPEN, disk)  # 放得進大圓的空間 = 房間、室外
    narrow = cv2.bitwise_and(free, cv2.bitwise_not(roomy))
    mask = lines_img | narrow | solid_img
    # 去掉孤立的小雜點(例如牆圖層上的短標記)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] * mm_per_px ** 2 >= 0.05e6
    return np.where(keep[lab], 255, 0).astype(np.uint8)


def main_cluster(polylines, mm_per_px_hint):
    """模型空間裡可能有好幾張圖:只取牆最多的那一塊的範圍。"""
    pts = np.concatenate([np.asarray(p, float)[:, :2] for p in polylines if len(p)])
    x0, y0 = pts.min(axis=0)
    x1, y1 = pts.max(axis=0)
    mpp = max(mm_per_px_hint * 5, max(x1 - x0, y1 - y0) / 1500)
    r = Raster(x0, y0, x1, y1, mpp)
    img = r.blank()
    r.draw(img, polylines, 255, 1)
    img = cv2.dilate(img, np.ones((5, 5), np.uint8), iterations=max(1, int(1500 / mpp / 2)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(img)
    if n <= 2:
        return (x0, y0, x1, y1), 1
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    bx, by, bw, bh = stats[best, :4]
    big = int((stats[1:, cv2.CC_STAT_AREA] > stats[best, cv2.CC_STAT_AREA] * 0.2).sum())
    return (x0 + bx * mpp, y1 - (by + bh) * mpp, x0 + (bx + bw) * mpp, y1 - by * mpp), big


def door_arcs(items, scale):
    """門弧:半徑在門片寬度範圍內、張角接近 90° 的弧。回傳 [(鉸鏈, 半徑, 起點方向, 終點方向)](mm)。"""
    arcs = []
    for it in items:
        e = it.e
        if e.dxftype() != "ARC":
            continue
        r = e.dxf.radius * scale
        sweep = (e.dxf.end_angle - e.dxf.start_angle) % 360
        if not (DOOR_LEAF_MM[0] <= r <= DOOR_LEAF_MM[1] and 60 <= sweep <= 120):
            continue
        c = np.array([e.dxf.center.x, e.dxf.center.y]) * scale
        d1 = np.array([math.cos(math.radians(e.dxf.start_angle)), math.sin(math.radians(e.dxf.start_angle))])
        d2 = np.array([math.cos(math.radians(e.dxf.end_angle)), math.sin(math.radians(e.dxf.end_angle))])
        if e.dxf.extrusion[2] < 0:  # 鏡射過的圖塊:弧在反面,x 要反過來
            c[0], d1[0], d2[0] = -c[0], -d1[0], -d2[0]
        arcs.append((c, r, d1, d2))
    return arcs


def furniture_type(block_name):
    up = block_name.upper()
    if up.startswith("FURN-") and up[5:].lower() in FURNITURE_COLORS:
        return up[5:].lower()
    return role_by_name(block_name, FURNITURE_KEYWORDS)


def build_scene_from_cad(data: bytes, filename: str, wall_height=3000, layer_roles=None, with_background=True):
    log = []
    doc = read_document(data, filename)
    msp = doc.modelspace()
    items = list(walk(msp))
    if not items:
        raise CadError("檔案的模型空間是空的")

    # 圖層角色
    counts = {}
    for it in items:
        counts[it.layer] = counts.get(it.layer, 0) + 1
    roles = {name: role_by_name(name, ROLE_KEYWORDS) or "other" for name in counts}
    for name, role in (layer_roles or {}).items():
        if name in roles and role in ROLES:
            roles[name] = role
    layers = [{"name": n, "count": counts[n], "role": roles[n]} for n in sorted(counts, key=lambda n: -counts[n])]
    by_role = {r: [it for it in items if roles[it.layer] == r] for r in ROLES}
    # 放在其他圖層、但圖塊名稱看得出是門窗家具的圖塊參照
    for it in by_role["other"] + by_role["wall"]:
        if it.insert is not None:
            name = it.insert.dxf.name
            r = role_by_name(name, ROLE_KEYWORDS[1:3]) or ("furniture" if furniture_type(name) else None)
            if r:
                by_role[r].append(it)
    if not by_role["wall"]:
        raise CadError("找不到牆:沒有圖層被判定為「牆」。請在圖層對應裡指定哪個圖層是牆")

    # 單位
    raw_lines = [pl for it in by_role["wall"] for pl in flatten(it.e, 1.0)]
    raw_lines = [pl for pl in raw_lines if len(pl) >= 2]
    pts = np.concatenate([np.asarray(p, float)[:, :2] for p in raw_lines])
    scale, unit_name = to_mm_factor(doc, float(np.ptp(pts, axis=0).max()))
    log.append(f"[單位] {unit_name},1 單位 = {scale:g} mm")
    S = lambda pl: [(p[0] * scale, p[1] * scale) for p in pl]
    tol = 20 / scale  # 曲線攤平誤差 20 mm

    def lines_of(role, solid=False):
        out = []
        for it in by_role[role]:
            if solid != (it.e.dxftype() == "HATCH" and it.e.dxf.solid_fill):
                continue
            out += [S(pl) for pl in flatten(it.e, tol) if len(pl) >= 2]
        return out

    wall_lines, wall_solids = lines_of("wall"), lines_of("wall", solid=True)
    (x0, y0, x1, y1), n_plans = main_cluster(wall_lines + wall_solids, MM_PER_PX)
    if n_plans > 1:
        log.append(f"[注意] 檔案裡有 {n_plans} 張圖,只處理牆最多的那一張")
    mpp = max(MM_PER_PX, max(x1 - x0, y1 - y0) / MAX_PX)
    R = Raster(x0 - MARGIN_MM, y0 - MARGIN_MM, x1 + MARGIN_MM, y1 + MARGIN_MM, mpp)

    lines_img, solid_img = R.blank(), R.blank()
    R.draw(lines_img, wall_lines, 255, 1)
    R.fill(solid_img, wall_solids, 255)
    raw = wall_mask_from_lines(lines_img, solid_img, mpp)
    if not raw.any():
        raise CadError("找不到牆:牆圖層畫出來是空的")
    t = rz.wall_thickness(raw)
    rects, leftovers, clean = rz.regularize_walls(raw, t)
    if not clean.any():
        raise CadError("找不到牆")
    log.append(f"[比例] 1 px = {mpp:g} mm;牆厚約 {t * mpp:.0f} mm")

    openings = find_cad_openings(clean, t, mpp, R, by_role, scale, tol, S, log)
    walls_px, scene_walls, to_mm = make_walls(clean, t, mpp, openings, wall_height, log)
    for w in scene_walls:
        w.thickness = cad_thickness(w.thickness, mpp)
    scene_openings, wall_dist = make_openings(openings, walls_px, scene_walls, clean, mpp, log)

    labels, room_ids = rz.segment_rooms(clean, openings, t, mpp)
    scene_furniture = cad_furniture(doc, by_role["furniture"], scale, R, labels, log, S, tol)

    texts = []
    for it in items:
        if roles[it.layer] == "ignore":
            continue
        s = text_of(it.e)
        if s and not AREA_TEXT.match(s) and len(s) <= 20:
            p = R.px([np.array([it.e.dxf.insert.x, it.e.dxf.insert.y]) * scale])[0]
            texts.append((s, p))
    used = {}

    def name_of(r, _poly):
        for s, (px, py) in texts:
            ix, iy = int(px), int(py)
            if 0 <= iy < labels.shape[0] and 0 <= ix < labels.shape[1] and labels[iy, ix] == r:
                return s
        return room_name({f.type for f, rr in scene_furniture if rr == r}, used)

    names = {}

    def name_of_cached(r, poly):
        names[r] = name_of(r, poly)
        return names[r]

    scene_rooms = make_rooms(labels, room_ids, to_mm, name_of_cached, lambda r: floor_color_for(names[r]), log)

    bg = R.blank(255)
    for role in ("other", "furniture", "door", "window", "text"):
        R.draw(bg, lines_of(role), 170, 1)
    R.draw(bg, wall_lines, 60, 2)
    R.fill(bg, wall_solids, 60)
    im = cv2.cvtColor(bg, cv2.COLOR_GRAY2BGR)

    background = None
    if with_background:
        background = Background(src=data_url(im), width=R.w * mpp, height=R.h * mpp)
    scene = Scene(
        meta=Meta(mm_per_px=mpp, wall_height=wall_height, wall_thickness=cad_thickness(t * mpp, mpp),
                  background=background),
        walls=scene_walls, openings=scene_openings, rooms=scene_rooms,
        furniture=[f for f, _ in scene_furniture],
    )
    return Recognition(scene, overlay(im, clean, openings, []), log, cad={"layers": layers})


def cad_thickness(mm, mpp):
    """點陣化時牆線本身多佔了約一個像素,扣掉;CAD 的牆厚通常是 5 mm 的倍數。"""
    return float(max(20, round((mm - mpp) / 5) * 5))


def floor_color_for(name):
    if re.search(r"衛|卫|浴|廁|厕|bath|wc|toilet", name, re.I):
        return "#dfe6e9"
    if re.search(r"廚|厨|kitchen", name, re.I):
        return "#e6e1d6"
    if re.search(r"陽台|阳台|balcony", name, re.I):
        return "#d9d6d0"
    return "#e8dcc6"


def is_wall(mask, p):
    x, y = int(round(p[0])), int(round(p[1]))
    return 0 <= y < mask.shape[0] and 0 <= x < mask.shape[1] and mask[y, x] > 0


def find_cad_openings(clean, t, mpp, R, by_role, scale, tol, S, log):
    """牆上的缺口 = 開口;缺口裡有門弧是門、有窗線是窗。不在缺口上的門弧、窗也收進來。"""
    ys, xs = np.nonzero(clean)
    wall_box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    gaps = rz.find_openings(clean, t, 1 / mpp)
    outer = [o["outer"] for o in rz.classify(gaps, wall_box, t, np.zeros(clean.shape, np.uint8))]

    arcs = []
    for c, r, d1, d2 in door_arcs(by_role["door"] + by_role["other"], scale):
        h = R.px([c])[0]
        flip = np.array([1, -1])
        arcs.append({"hinge": h, "r": r / mpp, "dirs": (d1 * flip, d2 * flip), "used": False})

    win_img = R.blank()
    R.draw(win_img, [S(pl) for it in by_role["window"] for pl in flatten(it.e, tol) if len(pl) >= 2], 255, 1)
    win_img = cv2.dilate(win_img, np.ones((3, 3), np.uint8))

    def leaf_dirs(arc, along):
        """弧的兩個端點方向:平行牆的是關門位置,垂直牆的是開門方向。"""
        d1, d2 = arc["dirs"]
        if abs(d1 @ along) > abs(d2 @ along):
            return d1, d2
        return d2, d1

    openings = []
    for (x, y, w, h), out in zip(gaps, outer):
        along = np.array([1.0, 0.0]) if w >= h else np.array([0.0, 1.0])
        long_side = max(w, h)
        box = (x - t, y - t, x + w + t, y + h + t)
        near = [a for a in arcs if not a["used"] and box[0] <= a["hinge"][0] <= box[2]
                and box[1] <= a["hinge"][1] <= box[3]]
        o = {"rect": (x, y, w, h), "outer": out}
        if near:
            single = [a for a in near if abs(a["r"] - long_side) < max(0.25 * long_side, 2 * t)]
            pair = [a for a in near if abs(a["r"] - long_side / 2) < max(0.2 * long_side, 2 * t)]
            if single:
                a = single[0]
                a["used"] = True
                closed, opened = leaf_dirs(a, along)
                o.update(kind="door", leaves=1, out_px=tuple(opened), hinge_px=tuple(a["hinge"]))
            elif len(pair) >= 2:
                for a in pair[:2]:
                    a["used"] = True
                closed, opened = leaf_dirs(pair[0], along)
                o.update(kind="door", leaves=2, out_px=tuple(opened))
            else:
                o["kind"] = "door"
        elif win_img[y:y + h, x:x + w].any():
            o["kind"] = "window"
        else:
            o["kind"] = "passage"
        openings.append(o)

    # 牆沒有斷開、但畫了門弧的門
    extra_doors = 0
    for a in arcs:
        if a["used"]:
            continue
        d1, d2 = a["dirs"]
        hx, hy = a["hinge"]
        for closed, opened in ((d1, d2), (d2, d1)):
            if abs(closed[0]) < 0.9 and abs(closed[1]) < 0.9:
                continue  # 只處理水平/垂直的牆
            # 關門的位置貼著牆(往牆裡偏一點取樣),開門的方向是空地
            along_wall = a["hinge"] + closed * a["r"] / 2 - opened * t * 0.4
            into_room = a["hinge"] + opened * a["r"] / 2
            if not (is_wall(clean, along_wall) and not is_wall(clean, into_room)):
                continue
            end = a["hinge"] + closed * a["r"]
            center = (a["hinge"] + end) / 2 - opened * t / 2
            hw, hh = (a["r"] / 2, t / 2) if abs(closed[0]) > abs(closed[1]) else (t / 2, a["r"] / 2)
            rect = (int(center[0] - hw), int(center[1] - hh), int(2 * hw), int(2 * hh))
            openings.append({"rect": rect, "outer": False, "kind": "door", "leaves": 1,
                             "out_px": tuple(opened), "hinge_px": (hx, hy)})
            extra_doors += 1
            break

    # 牆沒有斷開、但畫了窗線的窗
    n, lab, stats, _ = cv2.connectedComponentsWithStats(win_img)
    extra_windows = 0
    for i in range(1, n):
        x, y, w, h = stats[i, :4]
        long_mm = max(w, h) * mpp
        if not (300 <= long_mm <= 6000) or min(w, h) > 3 * t:
            continue
        if any(rx - t <= x + w / 2 <= rx + rw + t and ry - t <= y + h / 2 <= ry + rh + t
               for (rx, ry, rw, rh) in (o["rect"] for o in openings)):
            continue
        if clean[y:y + h, x:x + w].mean() < 0.3 * 255:
            continue
        if w >= h:
            rect = (int(x), int(y + h / 2 - t / 2), int(w), int(t))
        else:
            rect = (int(x + w / 2 - t / 2), int(y), int(t), int(h))
        openings.append({"rect": rect, "outer": True, "kind": "window"})
        extra_windows += 1

    if extra_doors or extra_windows:
        log.append(f"[開口] 另外從門弧找到 {extra_doors} 扇門、從窗線找到 {extra_windows} 扇窗(牆上沒有斷開)")
    return openings


def loose_furniture(items, R, labels, S, tol):
    """家具圖層上沒包成圖塊的線:連在一起的一組線 = 一件家具,用最小外接矩形當外框。"""
    img = R.blank()
    for it in items:
        if it.insert is None:
            R.draw(img, [S(pl) for pl in flatten(it.e, tol) if len(pl) >= 2], 255, 1)
    if not img.any():
        return []
    img = cv2.dilate(img, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    for c in cnts:
        (cx, cy), (w, h), ang = cv2.minAreaRect(c)
        w, h = (w - 2) * R.mpp, (h - 2) * R.mpp
        if w < 150 or h < 150 or w > 8000 or h > 8000:
            continue
        if w < h:
            w, h, ang = h, w, ang + 90
        ix, iy = int(cx), int(cy)
        if not (0 <= iy < labels.shape[0] and 0 <= ix < labels.shape[1]):
            continue
        circle = cv2.contourArea(c) / max(1.0, (w / R.mpp + 2) * (h / R.mpp + 2)) < 0.85 and abs(w - h) < 0.1 * w
        kind = guess_furniture(w, h, circle)
        x_mm = R.x0 + cx * R.mpp
        y_mm = R.y1 - cy * R.mpp
        found.append((kind, R.scene(x_mm, y_mm), -ang, w, h, int(labels[iy, ix])))
    return found


def guess_furniture(long_mm, short_mm, round_shape):
    """只有外框時依尺寸猜種類。"""
    if round_shape:
        return "table"
    if 1800 <= long_mm <= 2300 and short_mm >= 900:
        return "bed"
    if short_mm <= 700 and long_mm >= 1200:
        return "cabinet"
    if 1200 <= long_mm <= 2600 and 700 < short_mm <= 1100:
        return "sofa"
    return "other"


def cad_furniture(doc, items, scale, R, labels, log, S=None, tol=1.0):
    """家具圖塊 → Scene 家具(外框中心、角度、寬深)。回傳 [(Furniture, 房間 label)]。"""
    seen, result, skipped = set(), [], 0
    box_cache = {}
    for it in items:
        ins = it.insert
        if ins is None or id(ins) in seen:
            continue
        seen.add(id(ins))
        name = ins.dxf.name
        kind = furniture_type(name) or "other"
        if name not in box_cache:
            try:
                box_cache[name] = dxfbbox.extents(doc.blocks[name], fast=True)
            except Exception:
                box_cache[name] = None
        box = box_cache[name]
        if box is None or not box.has_data:
            skipped += 1
            continue
        sx, sy = abs(ins.dxf.get("xscale", 1)), abs(ins.dxf.get("yscale", 1))
        width, depth = box.size.x * sx * scale, box.size.y * sy * scale
        if width < 100 or depth < 100 or width > 8000 or depth > 8000:
            skipped += 1
            continue
        c = ins.matrix44().transform(box.center)
        cx, cy = c.x * scale, c.y * scale
        px = R.px([(cx, cy)])[0]
        ix, iy = int(px[0]), int(px[1])
        if not (0 <= iy < labels.shape[0] and 0 <= ix < labels.shape[1]):
            skipped += 1
            continue
        angle = ins.dxf.get("rotation", 0.0)
        if ins.dxf.get("xscale", 1) < 0:
            angle += 180
        sxm, sym = R.scene(cx, cy)
        result.append((Furniture(
            id=f"f{len(result) + 1}", type=kind, x=round(sxm, 1), y=round(sym, 1),
            angle=round(((angle + 180) % 360) - 180, 2), width=round(width, 1), depth=round(depth, 1),
            color=FURNITURE_COLORS.get(kind, FURNITURE_COLORS["other"]),
        ), int(labels[iy, ix])))
    n_blocks = len(result)
    for kind, (x, y), angle, w, h, room in loose_furniture(items, R, labels, S, tol) if S else []:
        result.append((Furniture(
            id=f"f{len(result) + 1}", type=kind, x=round(x, 1), y=round(y, 1),
            angle=round(((angle + 180) % 360) - 180, 2), width=round(w, 1), depth=round(h, 1),
            color=FURNITURE_COLORS.get(kind, FURNITURE_COLORS["other"]),
        ), room))
    log.append(f"[家具] {len(result)} 件(圖塊 {n_blocks}、散線 {len(result) - n_blocks})"
               + (f",略過 {skipped} 個看不出大小或在圖外的圖塊" if skipped else ""))
    return result
