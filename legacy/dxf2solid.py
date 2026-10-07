"""dxf2solid:把 2D 三視圖 DXF 重建成等比例 3D 實體(STEP)。

流程
  1. 讀 DXF 的可見輪廓線(略過虛線、中心線、尺寸、文字)
  2. 依幾何位置把線條分群成各視圖,判斷前/俯/側視圖與第一角/第三角法
  3. 每個視圖切出封閉區域;「只由圓構成」的區域有歧義(可能是孔,也可能是凸台)
  4. 每個視圖的實心區域沿視線方向擠出成柱體,所有柱體取交集 = 3D 實體
  5. 把實體投影回每個視圖驗證:外輪廓要一致,而且實體的每條邊都要落在原圖的線上
     (可見線或隱藏線)
  6. 不通過時「雕刻」:用圖上每條線沿視線方向延伸成切割面,把實體切成小格,
     逐格挖掉會產生多餘邊線的格子(例如圓凸台被交集成方柱時多出的四個角)
  7. 還是不通過就換一種孔/凸台的解讀再試

用法: python dxf2solid.py drawing.dxf [-o out_dir] [--first-angle | --third-angle]
"""
import argparse
import itertools
import sys
from pathlib import Path

import cadquery as cq
import ezdxf
from OCP.BRep import BRep_Tool
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepAlgoAPI import BRepAlgoAPI_Splitter
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.gp import gp_Trsf, gp_Vec
from OCP.TopTools import TopTools_ListOfShape
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

SKIP_LINETYPES = ("CENTER", "PHANTOM", "DIVIDE")  # 中心線、假想線不是零件的邊
HIDDEN_LINETYPES = ("DASH", "HIDDEN", "DOT")
GEOM_TOL = 1e-6
MATCH_TOL = 0.002  # 投影輪廓與原圖的面積差異容許比例
LINE_TOL = 0.05  # 實體的邊投影後離原圖線條多遠以內算「在線上」(mm)
EXTRA_TOL = 0.1  # 原圖上不存在的邊,總長超過這個值就判定不通過(mm)
MAX_AMBIGUOUS = 10  # 歧義區域超過這個數量就不窮舉

# 視圖 2D 座標 (u, v, w=視線方向) -> 世界座標 (X, Y, Z),全部是旋轉矩陣(det=+1)
VIEW_MATRIX = {
    "front": [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0]],  # (u, -w, v)
    "top": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],  # (u, v, w)
    "side": [[0, 0, 1, 0], [1, 0, 0, 0], [0, 1, 0, 0]],  # (w, u, v)
}
# 世界座標投影回視圖 (u, v)
VIEW_PROJECT = {
    "front": lambda p: (p[0], p[2]),
    "top": lambda p: (p[0], p[1]),
    "side": lambda p: (p[1], p[2]),
}


class ConversionError(Exception):
    pass


# ---------- 1. 讀 DXF ----------

def resolved_linetype(e, doc):
    lt = e.dxf.get("linetype", "BYLAYER")
    if lt.upper() == "BYLAYER" and doc.layers.has_entry(e.dxf.layer):
        lt = doc.layers.get(e.dxf.layer).dxf.linetype
    return lt.upper()


def entity_to_edges(e):
    t = e.dxftype()
    if t == "LINE":
        s, d = e.dxf.start, e.dxf.end
        if (s - d).magnitude < GEOM_TOL:
            return []
        return [cq.Edge.makeLine(cq.Vector(s.x, s.y, 0), cq.Vector(d.x, d.y, 0))]
    if t == "CIRCLE":
        c = e.dxf.center
        return [cq.Edge.makeCircle(e.dxf.radius, cq.Vector(c.x, c.y, 0))]
    if t == "ARC":
        c = e.dxf.center
        a1, a2 = e.dxf.start_angle, e.dxf.end_angle
        if a2 <= a1:
            a2 += 360
        return [cq.Edge.makeCircle(e.dxf.radius, cq.Vector(c.x, c.y, 0), cq.Vector(0, 0, 1), a1, a2)]
    if t in ("LWPOLYLINE", "POLYLINE"):
        return [edge for sub in e.virtual_entities() for edge in entity_to_edges(sub)]
    return []  # 文字、尺寸、填充線等不參與建模


def read_edges(path):
    """回傳 [(edge, is_hidden)];隱藏線不參與建模,只在驗證時使用。"""
    doc = ezdxf.readfile(path)
    items = []
    for e in doc.modelspace():
        lt = resolved_linetype(e, doc)
        if any(k in lt for k in SKIP_LINETYPES):
            continue
        hidden = any(k in lt for k in HIDDEN_LINETYPES)
        items += [(edge, hidden) for edge in entity_to_edges(e)]
    return items


# ---------- 2. 分群成視圖 ----------

class Box:
    def __init__(self, xmin, ymin, xmax, ymax):
        self.xmin, self.ymin, self.xmax, self.ymax = xmin, ymin, xmax, ymax

    @classmethod
    def of(cls, items):
        bbs = [e.BoundingBox() for e, _ in items]
        return cls(min(b.xmin for b in bbs), min(b.ymin for b in bbs), max(b.xmax for b in bbs), max(b.ymax for b in bbs))

    @property
    def w(self):
        return self.xmax - self.xmin

    @property
    def h(self):
        return self.ymax - self.ymin

    def touches(self, o, gap):
        return not (self.xmax + gap < o.xmin or o.xmax + gap < self.xmin or self.ymax + gap < o.ymin or o.ymax + gap < self.ymin)

    def x_overlaps(self, o):
        return min(self.xmax, o.xmax) - max(self.xmin, o.xmin) > 0

    def y_overlaps(self, o):
        return min(self.ymax, o.ymax) - max(self.ymin, o.ymin) > 0


def cluster_edges(edges, gap=0.5):
    boxes = [Box.of([e]) for e in edges]
    parent = list(range(len(edges)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(edges)):
        for j in range(i + 1, len(edges)):
            if boxes[i].touches(boxes[j], gap):
                parent[find(i)] = find(j)
    groups = {}
    for i, e in enumerate(edges):
        groups.setdefault(find(i), []).append(e)
    # 多段線拆開後是一條條細長的框,框內的圓碰不到它們;再用整群的外框合併一次,直到穩定
    clusters = [(Box.of(g), g) for g in groups.values()]
    merged = True
    while merged:
        merged = False
        for a, b in itertools.combinations(range(len(clusters)), 2):
            if clusters[a][0].touches(clusters[b][0], gap):
                g = clusters[a][1] + clusters[b][1]
                clusters = [c for k, c in enumerate(clusters) if k not in (a, b)] + [(Box.of(g), g)]
                merged = True
                break
    clusters.sort(key=lambda c: c[0].w * c[0].h, reverse=True)
    return clusters[:3]


def assign_views(clusters, angle):
    """回傳 ({'front'|'top'|'side': (box, edges, mirror)}, 判定的投影法)。"""
    if len(clusters) < 2:
        raise ConversionError("找不到至少兩個視圖")
    front = None
    for c in clusters:
        others = [o for o in clusters if o is not c]
        vert = [o for o in others if c[0].x_overlaps(o[0])]
        horiz = [o for o in others if c[0].y_overlaps(o[0])]
        if vert and (horiz or len(clusters) == 2):
            # 兩個視圖上下排列時無法單從位置分辨,假設下面那個是前視圖
            if front is None or c[0].ymin < front[0].ymin:
                front = c
    if front is None:
        raise ConversionError("無法從排列判斷哪個是前視圖")

    others = [o for o in clusters if o is not front]
    top = next((o for o in others if front[0].x_overlaps(o[0])), None)
    side = next((o for o in others if front[0].y_overlaps(o[0])), None)

    if angle is None:
        angle = "first" if top is not None and top[0].ymin < front[0].ymin else "third"

    views = {"front": (front[0], front[1], False)}
    if top is not None:
        views["top"] = (top[0], top[1], False)
    if side is not None:
        on_right = side[0].xmin > front[0].xmin
        # 第三角法:右邊放右視圖;第一角法:右邊放左視圖。左視圖要左右鏡射才能當成右視圖用
        is_left_view = on_right == (angle == "first")
        views["side"] = (side[0], side[1], is_left_view)
    return views, angle


# ---------- 3. 切區域 ----------

def normalize(edges, box, mirror):
    """平移到 (0,0) 起算;左視圖鏡射成右視圖的座標。"""
    out = [(e.translate(cq.Vector(-box.xmin, -box.ymin, 0)), h) for e, h in edges]
    if mirror:
        out = [(e.mirror("YZ", cq.Vector(box.w / 2, 0, 0)), h) for e, h in out]
    return out


def split_regions(edges, box):
    m = max(box.w, box.h)
    pts = [cq.Vector(-m, -m, 0), cq.Vector(box.w + m, -m, 0), cq.Vector(box.w + m, box.h + m, 0), cq.Vector(-m, box.h + m, 0)]
    big = cq.Face.makeFromWires(cq.Wire.makePolygon(pts, close=True))

    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(big.wrapped)
    for e in edges:
        tools.Append(e.wrapped)
    sp = BRepAlgoAPI_Splitter()
    sp.SetArguments(args)
    sp.SetTools(tools)
    sp.SetFuzzyValue(1e-5)
    sp.Build()
    if not sp.IsDone():
        raise ConversionError("切割視圖區域失敗")

    regions = []
    for f in cq.Shape.cast(sp.Shape()).Faces():
        if f.BoundingBox().xmin < -m / 2:  # 外圍那一塊不是零件
            continue
        ambiguous = all(e.geomType() == "CIRCLE" for e in f.Edges())
        regions.append({"face": f, "ambiguous": ambiguous})
    return regions


# ---------- 4. 擠出 + 交集 ----------

def prism(shape2d, view, depth):
    """把視圖平面上的面(或邊)沿視線方向擠出,前後各 depth,再轉到世界座標。"""
    f = shape2d.translate(cq.Vector(0, 0, -depth))
    solid = cq.Shape.cast(BRepPrimAPI_MakePrism(f.wrapped, gp_Vec(0, 0, 2 * depth)).Shape())
    trsf = gp_Trsf()
    trsf.SetValues(*[x for row in VIEW_MATRIX[view] for x in row])
    return cq.Shape.cast(BRepBuilderAPI_Transform(solid.wrapped, trsf).Shape())


def fuse_all(shapes):
    return shapes[0].fuse(*shapes[1:]).clean() if len(shapes) > 1 else shapes[0]


def build_solid(views, material, depth, cache):
    result = None
    for name, regions in views.items():
        prisms = []
        for i, r in enumerate(regions):
            if (name, i) in material:
                if (name, i) not in cache:
                    cache[(name, i)] = prism(r["face"], name, depth)
                prisms.append(cache[(name, i)])
        if not prisms:
            return None
        body = fuse_all(prisms)
        result = body if result is None else result.intersect(body)
    return result.clean()


# ---------- 5. 投影回去驗證 ----------

def tri_union(shape, project):
    verts, tris = shape.tessellate(0.01, 0.1)
    polys = []
    for t in tris:
        p = Polygon([project(verts[i].toTuple()) for i in t])
        if p.is_valid and p.area > 1e-9:
            polys.append(p)
    return unary_union(polys)


def edge_polyline(edge, project):
    n = 2 if edge.geomType() == "LINE" else 64
    return LineString([project(edge.positionAt(i / (n - 1)).toTuple()) for i in range(n)])


def real_edges(solid):
    """實體的邊,去掉圓柱面的接縫線(那是建模資料結構的產物,圖上不會畫)。"""
    seams = [e for f in solid.Faces() for e in f.Edges() if BRep_Tool.IsClosed_s(e.wrapped, f.wrapped)]
    return [e for e in solid.Edges() if not any(e.isSame(s) for s in seams)]


def check_view(solid, view, regions, material, drawing_edges):
    """回傳 (外輪廓面積差異比例, 原圖上不存在的邊總長 mm)。"""
    if solid is None or solid.Volume() < GEOM_TOL:
        return 1.0, float("inf")
    faces = [r["face"] for i, r in enumerate(regions) if (view, i) in material]
    target = tri_union(cq.Compound.makeCompound(faces), lambda p: (p[0], p[1]))
    got = tri_union(solid, VIEW_PROJECT[view])
    area_err = target.symmetric_difference(got).area / target.area

    ink = unary_union([edge_polyline(e, lambda p: (p[0], p[1])) for e, _ in drawing_edges]).buffer(LINE_TOL)
    extra = 0.0
    for e in real_edges(solid):
        ls = edge_polyline(e, VIEW_PROJECT[view])
        if ls.length > GEOM_TOL:  # 跟視線平行的邊投影成一點,不用檢查
            extra += ls.difference(ink).length
    return area_err, extra


def ink_of(drawing_edges):
    return unary_union([edge_polyline(e, lambda p: (p[0], p[1])) for e, _ in drawing_edges]).buffer(LINE_TOL)


def off_ink(edges, inks):
    """這些邊投影到各視圖後,有沒有任何一段不在圖上的線上。"""
    for view, ink in inks.items():
        for e in edges:
            ls = edge_polyline(e, VIEW_PROJECT[view])
            if ls.length > GEOM_TOL and ls.difference(ink).length > EXTRA_TOL:
                return True
    return False


def split_cells(solid, drawn, depth, with_hidden):
    tools = TopTools_ListOfShape()
    for view, items in drawn.items():
        for e, hidden in items:
            if with_hidden or not hidden:
                tools.Append(prism(e, view, depth).wrapped)
    args = TopTools_ListOfShape()
    args.Append(solid.wrapped)
    sp = BRepAlgoAPI_Splitter()
    sp.SetArguments(args)
    sp.SetTools(tools)
    sp.SetFuzzyValue(1e-5)
    sp.Build()
    return cq.Shape.cast(sp.Shape()).Solids() if sp.IsDone() else []


def carve(solid, views, material, drawn, depth, log):
    """逐格挖掉會產生多餘邊線的格子,每次挑讓整體誤差下降最多的那一格。

    先只用可見線切格:格子剛好落在特徵的邊界上,一格就是一個完整的「多出來的角」;
    隱藏線會把同一個角再切碎,單獨挖掉其中一小塊反而多出新邊線,貪婪法會卡住。
    可見線不夠時才加上隱藏線再試一次。"""
    best = None
    for with_hidden in (False, True):
        result = _carve(solid, views, material, drawn, depth, with_hidden, log)
        if best is None or badness(result[1]) < badness(best[1]):
            best = result
        if passed(best[1]):
            break
    return best


def _carve(solid, views, material, drawn, depth, with_hidden, log):
    inks = {n: ink_of(drawn[n]) for n in views}
    cells = split_cells(solid, drawn, depth, with_hidden)
    log(f"  [雕刻] 用{'可見線+隱藏線' if with_hidden else '可見線'}切成 {len(cells)} 格")

    def evaluate(s):
        return {n: check_view(s, n, views[n], material, drawn[n]) for n in views}

    errs = evaluate(solid)
    present = list(cells)
    while not passed(errs):
        candidates = [c for c in present if off_ink(real_edges(c), inks)]
        best = None
        for c in candidates:
            trial = solid.cut(c).clean()
            e = evaluate(trial)
            if badness(e) < badness(errs) - 1e-6 and (best is None or badness(e) < badness(best[2])):
                best = (c, trial, e)
        if best is None:
            break
        c, solid, errs = best
        present.remove(c)
        log(f"  [雕刻] 挖掉一格(體積 {c.Volume():.1f} mm³),剩餘多餘邊線 {sum(x for _, x in errs.values()):.2f} mm")
    return solid, errs


def passed(errs):
    return all(a < MATCH_TOL and x < EXTRA_TOL for a, x in errs.values())


def badness(errs):
    return sum(a * 1000 + x for a, x in errs.values())


def convert(src, angle=None, log=print):
    """把 DXF 三視圖轉成 3D 實體。回傳 dict:solid、ok(驗證是否通過)、size、volume、
    errs(各視圖的驗證數據)、drawing(各視圖的原始線條,給預覽用)。"""
    edges = read_edges(src)
    if not edges:
        raise ConversionError("圖面裡沒有可用的線條(LINE / ARC / CIRCLE / LWPOLYLINE)")
    placed, angle = assign_views(cluster_edges(edges), angle)
    log(f"[視圖] 找到 {', '.join(placed)},{'第一角法' if angle == 'first' else '第三角法'}")
    views, sizes, drawn = {}, {}, {}
    for name, (box, es, mirror) in placed.items():
        drawn[name] = normalize(es, box, mirror)
        views[name] = split_regions([e for e, hidden in drawn[name] if not hidden], box)
        sizes[name] = (box.w, box.h)
        n_amb = sum(r["ambiguous"] for r in views[name])
        log(f"  {name:5s} {box.w:g} x {box.h:g},{len(views[name])} 個區域(其中 {n_amb} 個只由圓構成)"
              + (",左視圖已鏡射" if mirror else ""))

    # 共用軸的尺寸必須一致:前/俯同寬 (X)、前/側同高 (Z)、俯視高 = 側視寬 (Y)
    checks = [("front", 0, "top", 0, "X"), ("front", 1, "side", 1, "Z"), ("top", 1, "side", 0, "Y")]
    for v1, i1, v2, i2, axis in checks:
        if v1 in sizes and v2 in sizes and abs(sizes[v1][i1] - sizes[v2][i2]) > 0.01:
            log(f"[警告] {axis} 方向尺寸不一致:{v1}={sizes[v1][i1]:g}, {v2}={sizes[v2][i2]:g}")

    fixed = {(n, i) for n, rs in views.items() for i, r in enumerate(rs) if not r["ambiguous"]}
    ambiguous = [(n, i) for n, rs in views.items() for i, r in enumerate(rs) if r["ambiguous"]]
    if len(ambiguous) > MAX_AMBIGUOUS:
        log(f"[警告] 圓形區域太多 ({len(ambiguous)}),只試「全部當孔」")
        ambiguous = []

    depth = 2 * max(max(s) for s in sizes.values()) + 10
    cache = {}
    # 先試實心最少(孔最多)的解讀:工程圖上單獨的圓多半是孔
    interpretations = [fixed | set(chosen) for k in range(len(ambiguous) + 1)
                       for chosen in itertools.combinations(ambiguous, k)]
    tried = []
    best = None
    for material in interpretations:
        solid = build_solid(views, material, depth, cache)
        errs = {n: check_view(solid, n, views[n], material, drawn[n]) for n in views}
        tried.append((solid, material, errs))
        if best is None or badness(errs) < badness(best[2]):
            best = (solid, material, errs)
        if passed(errs):
            break
    else:
        # 單純交集都對不上:輪廓吻合的解讀才值得雕刻(雕刻只會挖掉,不會補回輪廓)
        for solid, material, errs in tried:
            if solid is None or any(a >= MATCH_TOL for a, _ in errs.values()):
                continue
            solid, errs = carve(solid, views, material, drawn, depth, log)
            if badness(errs) < badness(best[2]):
                best = (solid, material, errs)
            if passed(errs):
                break

    solid, material, errs = best
    ok = passed(errs)
    for n, i in ambiguous:
        kind = "實心(凸台/圓柱)" if (n, i) in material else "孔"
        c = views[n][i]["face"].Center()
        log(f"  [解讀] {n} 視圖圓形區域 @({c.x:g}, {c.y:g}) -> {kind}")
    log("[驗證] 投影回各視圖(輪廓差異 / 圖上沒有的多餘邊線):")
    for n, (a_err, extra) in errs.items():
        log(f"  {n:5s} {a_err * 100:.3f}% / {extra:.2f} mm")
    log("  -> " + ("通過" if ok else "不通過,模型與圖面不一致,請人工確認"))
    if solid is None:
        raise ConversionError("無法建出實體")

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(solid.wrapped, box, False, False)  # 不加模型公差的精確外框
    x0, y0, z0, x1, y1, z1 = box.Get()
    log(f"[結果] 外形 {x1 - x0:.3f} x {y1 - y0:.3f} x {z1 - z0:.3f} mm,體積 {solid.Volume():.2f} mm³")
    return {
        "solid": solid,
        "ok": ok,
        "angle": angle,
        "size": (x1 - x0, y1 - y0, z1 - z0),
        "volume": solid.Volume(),
        "errs": errs,
        "drawing": {n: [(e, h) for e, h in es] for n, (_, es, _) in placed.items()},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dxf")
    ap.add_argument("-o", "--out", default="out")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--first-angle", dest="angle", action="store_const", const="first")
    g.add_argument("--third-angle", dest="angle", action="store_const", const="third")
    a = ap.parse_args()

    src = Path(a.dxf)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    try:
        r = convert(src, a.angle)
    except ConversionError as e:
        sys.exit(str(e))

    stem = out / src.stem
    cq.exporters.export(r["solid"], str(stem.with_suffix(".step")))
    cq.exporters.export(r["solid"], str(stem.with_suffix(".stl")))
    print(f"[輸出] {stem.with_suffix('.step')}  {stem.with_suffix('.stl')}")
    return 0 if r["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
