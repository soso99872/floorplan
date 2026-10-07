"""Scene → DXF 平面圖(給 AutoCAD)。

圖層用 AIA 慣例,cad_import 讀得回來:
  A-WALL       牆(各牆段聯集、扣掉門窗開口後的外框 + 實心填充)
  A-DOOR       門(門片線 + 開門弧)
  A-GLAZ       窗(三線窗)
  A-FURN       家具(每個型錄種類一個圖塊,圖塊名 FURN-<type>)
  A-AREA-IDEN  房間名稱與面積
  A-DIMS       外牆總尺寸
單位 mm,座標與 Scene 相同(y 向上)。
"""
import io
import math

import ezdxf
from ezdxf import units
from shapely.geometry import Polygon
from shapely.ops import unary_union

from .scene import Scene

LAYERS = {
    "A-WALL": 7,
    "A-DOOR": 3,
    "A-GLAZ": 5,
    "A-FURN": 8,
    "A-AREA-IDEN": 2,
    "A-DIMS": 1,
}
TEXT_HEIGHT = 250
TEXT_STYLE = "CJK"  # 中文字要用 TrueType 字型,AutoCAD 預設的 SHX 字型顯示不出來
TEXT_FONT = "msjh.ttc"
FURN_BLOCK = "FURN-{}"
UNIT = 1000.0  # 家具圖塊以 1000×1000 畫,插入時用比例縮放到實際寬深


def wall_frame(w):
    dx, dy = w.b[0] - w.a[0], w.b[1] - w.a[1]
    L = math.hypot(dx, dy) or 1.0
    u = (dx / L, dy / L)
    n = (-u[1], u[0])  # a→b 的左手邊
    return u, n, L


def strip(p, u, n, start, end, half):
    """沿 u 從 start 到 end、往 n 兩側各 half 的矩形。"""
    pts = []
    for s, k in ((start, -half), (end, -half), (end, half), (start, half)):
        pts.append((p[0] + u[0] * s + n[0] * k, p[1] + u[1] * s + n[1] * k))
    return Polygon(pts)


def wall_outline(scene):
    walls = {w.id: w for w in scene.walls}
    solid = unary_union([strip(w.a, *wall_frame(w)[:2], 0, wall_frame(w)[2], w.thickness / 2) for w in scene.walls])
    holes = []
    for o in scene.openings:
        w = walls.get(o.wall)
        if w is None:
            continue
        u, n, _ = wall_frame(w)
        holes.append(strip(w.a, u, n, o.offset - o.width / 2, o.offset + o.width / 2, w.thickness / 2 + 1))
    if holes:
        solid = solid.difference(unary_union(holes))
    return [g for g in getattr(solid, "geoms", [solid]) if not g.is_empty]


def add_polygon(msp, poly, layer):
    hatch = msp.add_hatch(color=256, dxfattribs={"layer": layer})
    rings = [poly.exterior] + list(poly.interiors)
    for i, ring in enumerate(rings):
        pts = list(ring.coords)[:-1]
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})
        hatch.paths.add_polyline_path(pts, is_closed=True,
                                      flags=ezdxf.const.BOUNDARY_PATH_EXTERNAL if i == 0 else 0)


def arc_between(msp, center, r, v1, v2, layer):
    """畫從方向 v1 到 v2 的 90° 弧(取兩者夾的那一段)。"""
    a1 = math.degrees(math.atan2(v1[1], v1[0]))
    a2 = math.degrees(math.atan2(v2[1], v2[0]))
    if v1[0] * v2[1] - v1[1] * v2[0] < 0:  # 順時針 → 交換,DXF 弧一律逆時針
        a1, a2 = a2, a1
    msp.add_arc(center, r, a1, a2, dxfattribs={"layer": layer})


def add_door(msp, o, w):
    u, n, _ = wall_frame(w)
    s = o.swing
    face = (w.a[0] + u[0] * o.offset + n[0] * s * w.thickness / 2,
            w.a[1] + u[1] * o.offset + n[1] * s * w.thickness / 2)
    out = (n[0] * s, n[1] * s)
    if o.leaves == 2:
        hinges = [(-1, o.width / 2), (1, o.width / 2)]
    else:
        hinges = [(-1 if o.hinge == "start" else 1, o.width)]
    for side, leaf in hinges:
        h = (face[0] + u[0] * side * o.width / 2, face[1] + u[1] * side * o.width / 2)
        closed = (-u[0] * side, -u[1] * side)
        tip = (h[0] + out[0] * leaf, h[1] + out[1] * leaf)
        msp.add_line(h, tip, dxfattribs={"layer": "A-DOOR"})
        arc_between(msp, h, leaf, closed, out, "A-DOOR")


def add_window(msp, o, w):
    u, n, _ = wall_frame(w)
    c = (w.a[0] + u[0] * o.offset, w.a[1] + u[1] * o.offset)
    for k in (-w.thickness / 2, 0, w.thickness / 2):
        p = (c[0] + n[0] * k, c[1] + n[1] * k)
        msp.add_line((p[0] - u[0] * o.width / 2, p[1] - u[1] * o.width / 2),
                     (p[0] + u[0] * o.width / 2, p[1] + u[1] * o.width / 2), dxfattribs={"layer": "A-GLAZ"})


def furniture_block(doc, kind):
    """1000×1000 的俯視符號,中心在原點,+y 是背面(床頭、椅背)。"""
    name = FURN_BLOCK.format(kind)
    if name in doc.blocks:
        return name
    b = doc.blocks.new(name)
    h = UNIT / 2
    b.add_lwpolyline([(-h, -h), (h, -h), (h, h), (-h, h)], close=True)
    if kind == "bed":
        b.add_lwpolyline([(-h + 60, h - 60), (h - 60, h - 60), (h - 60, h - 260), (-h + 60, h - 260)], close=True)
        b.add_line((-h, h - 330), (h, h - 330))
    elif kind == "sofa":
        b.add_line((-h, h - 250), (h, h - 250))
    elif kind == "table":
        b.add_circle((0, 0), h * 0.6)
    elif kind == "wardrobe":
        b.add_line((-h, -h), (h, h))
        b.add_line((-h, h), (h, -h))
    elif kind == "fixture":
        b.add_circle((0, 0), h * 0.7)
    elif kind == "counter":
        b.add_line((-h, -h + 80), (h, -h + 80))
    return name


def export_dxf(scene: Scene) -> bytes:
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1
    doc.styles.add(TEXT_STYLE, font=TEXT_FONT)
    for name, color in LAYERS.items():
        doc.layers.add(name, color=color)
    msp = doc.modelspace()

    for poly in wall_outline(scene):
        add_polygon(msp, poly, "A-WALL")
    walls = {w.id: w for w in scene.walls}
    for o in scene.openings:
        w = walls.get(o.wall)
        if w is None:
            continue
        if o.kind == "door":
            add_door(msp, o, w)
        elif o.kind == "window":
            add_window(msp, o, w)

    for f in scene.furniture:
        block = furniture_block(doc, f.type)
        msp.add_blockref(block, (f.x, f.y), dxfattribs={
            "layer": "A-FURN", "xscale": f.width / UNIT, "yscale": f.depth / UNIT, "rotation": f.angle,
        })

    for r in scene.rooms:
        p = Polygon(r.polygon).representative_point()
        msp.add_mtext(f"{r.name}\\P{r.area:g} m²", dxfattribs={
            "layer": "A-AREA-IDEN", "style": TEXT_STYLE, "char_height": TEXT_HEIGHT, "insert": (p.x, p.y),
            "attachment_point": 5,
        })

    if scene.walls:
        xs = [c for w in scene.walls for c in (w.a[0], w.b[0])]
        ys = [c for w in scene.walls for c in (w.a[1], w.b[1])]
        t = max(w.thickness for w in scene.walls)
        x0, x1, y0, y1 = min(xs) - t / 2, max(xs) + t / 2, min(ys) - t / 2, max(ys) + t / 2
        gap = 800
        style = {"dimtxt": TEXT_HEIGHT, "dimasz": 150, "dimexe": 80, "dimexo": 80, "dimdec": 0,
                 "dimlfac": 1, "dimtxsty": TEXT_STYLE}
        msp.add_linear_dim(base=(x0, y0 - gap), p1=(x0, y0), p2=(x1, y0), angle=0,
                           override=style, dxfattribs={"layer": "A-DIMS"}).render()
        msp.add_linear_dim(base=(x0 - gap, y0), p1=(x0, y0), p2=(x0, y1), angle=90,
                           override=style, dxfattribs={"layer": "A-DIMS"}).render()

    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")
