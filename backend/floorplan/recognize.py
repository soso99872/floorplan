"""平面圖圖片的辨識:牆、門窗開口、房間、家具。

這裡只負責「從像素找出東西」,不產生 3D;結果由 build.py 組成 Scene JSON。
座標在這個檔案裡都是像素(圖片座標,y 向下),換算成 mm 由 build.py 負責。
"""
import cv2
import numpy as np
from shapely.geometry import Polygon, box as shp_box

DARK_V = 80  # HSV 亮度低於這個值算深色(牆)
DOOR_HEAD = 2100  # 門、窗上緣高度 mm
WINDOW_SILL = 900  # 窗台高度 mm
MIN_OPENING, MAX_OPENING = 450, 2600  # 開口寬度合理範圍 mm
EMPTY_GAP_V = 215  # 外牆缺口內平均亮度高於這個值 = 裡面沒畫窗的玻璃線,當成門


class PlanError(Exception):
    pass


def load_image(src):
    """src 可以是檔案路徑或檔案內容 (bytes)。"""
    if isinstance(src, (bytes, bytearray)):
        data = np.frombuffer(src, dtype=np.uint8)
    else:
        data = np.fromfile(str(src), dtype=np.uint8)  # cv2.imread 不吃 Windows 中文路徑
    im = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if im is None:
        raise PlanError("讀不到這張圖片(支援 PNG / JPG / WEBP / BMP)")
    if max(im.shape[:2]) < 1200:  # 小圖先放大,輪廓比較平滑
        f = 1200 / max(im.shape[:2])
        im = cv2.resize(im, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    return im


def wall_thickness(mask):
    """最常見的深色連續長度(橫向+縱向)≈ 牆厚,單位像素。"""
    runs = []
    for m in (mask, mask.T):
        d = np.diff(np.pad(m > 0, ((0, 0), (1, 1))).astype(np.int8), axis=1)
        starts, ends = np.where(d == 1), np.where(d == -1)
        runs.append(ends[1] - starts[1])
    runs = np.concatenate(runs)
    runs = runs[(runs >= 3) & (runs <= 60)]
    if len(runs) == 0:
        raise PlanError("找不到牆線(圖上沒有夠深的粗線)")
    return int(np.bincount(runs).argmax())


def wall_mask(im):
    v = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)[..., 2]
    mask = (v < DARK_V).astype(np.uint8) * 255
    t = wall_thickness(mask)
    # 去掉比牆細的線(文字、家具輪廓、尺寸線)
    k = max(3, int(t * 0.6))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    # 去掉不像牆的塊:太短(燈具、小家具),或又粗又實心(爐具、深色家具)。
    # 牆是細長的線,就算是 L 形、T 形,外框短邊不是約等於牆厚、就是外框裡大半是空的
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
    keep = np.zeros_like(mask)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        chunky = min(w, h) > 2 * t and area / (w * h) > 0.4
        if max(w, h) >= 5 * t and not chunky:
            keep[lab == i] = 255
    if not keep.any():
        raise PlanError("找不到牆")
    return keep, t


def runs_of(line):
    d = np.diff(np.r_[0, line.astype(np.int8), 0])
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def find_openings(mask, t, px_per_mm):
    """開口 = 同一方向的兩段牆「頭對頭」中間的缺口。

    逐列(找水平牆上的缺口)、逐欄(找垂直牆上的缺口)掃描深色段;相鄰兩段之間的空白
    長度在合理範圍,而且至少一邊是沿這個方向延伸的牆(深色段夠長),就標成開口。
    另一邊可以是垂直的牆:房門常開在牆角,牆走到離轉角一扇門寬的地方就停了。
    只用形態學補洞的話,兩道平行牆之間的空間也會被補起來。"""
    lo, hi = int(MIN_OPENING * px_per_mm), int(MAX_OPENING * px_per_mm)
    min_run = 2 * t
    found = []
    for horizontal in (True, False):
        m = mask > 0 if horizontal else (mask > 0).T
        marks = np.zeros(m.shape, np.uint8)
        for r in range(m.shape[0]):
            rs = runs_of(m[r])
            for (s1, e1), (s2, e2) in zip(rs, rs[1:]):
                along = max(e1 - s1, e2 - s2) >= min_run  # 至少一邊是同方向的牆
                solid = min(e1 - s1, e2 - s2) >= 0.5 * t  # 另一邊是牆(同向或垂直),不是雜點
                if lo <= s2 - e1 <= hi and along and solid:
                    marks[r, e1:s2] = 255
        if not horizontal:
            marks = marks.T
        n, lab, st, _ = cv2.connectedComponentsWithStats(marks)
        for i in range(1, n):
            x, y, w, h, area = st[i]
            length, thick = (w, h) if horizontal else (h, w)
            if lo <= length <= hi and 0.5 * t <= thick <= 1.8 * t:
                found.append((x, y, w, h))
    return found


def classify(openings, wall_box, t, value):
    """內牆上的缺口當門。外牆上的缺口通常是窗(缺口裡會畫玻璃的細線);
    缺口裡幾乎全白、什麼都沒畫的,是大門。"""
    x0, y0, x1, y1 = wall_box
    out = []
    for x, y, w, h in openings:
        # 缺口本身要落在外牆那條線上;只是端點靠近外牆的內牆缺口不算
        if w >= h:
            outer = y - y0 < 2 * t or y1 - (y + h) < 2 * t
        else:
            outer = x - x0 < 2 * t or x1 - (x + w) < 2 * t
        empty = value[y:y + h, x:x + w].mean() > EMPTY_GAP_V
        out.append({"rect": (x, y, w, h), "kind": "window" if outer and not empty else "door", "outer": outer})
    return out


# ---------- 家具 ----------

# 家具種類 -> (高度 mm, 中文名)。圖上沒有高度資訊,用常見尺寸
FURNITURE = {
    "bed": (550, "床"),
    "sofa": (800, "沙發/椅"),
    "table": (750, "桌椅"),
    "low_table": (450, "茶几/矮櫃"),
    "wardrobe": (2000, "衣櫃"),
    "cabinet": (600, "櫃子"),
    "counter": (900, "流理台/爐具"),
    "fixture": (850, "設備(衛浴/家電)"),
    "lamp": (1400, "立燈"),
    "rug": (15, "地毯"),
    "other": (700, "其他"),
}
MIN_FURNITURE_M2 = 0.04  # 比這小的色塊不算家具(角落的立燈大約 0.05 m²)


def seal_rooms(mask, openings, t, px_per_mm):
    """把牆、開口、以及牆上還沒辨識到的小缺口都封起來,剩下的空間一塊塊就是房間。"""
    barrier = mask.copy()
    for o in openings:
        x, y, w, h = o["rect"]
        barrier[y:y + h, x:x + w] = 255
    hi = int(1300 * px_per_mm)  # 1.3 m 以內的缺口都當成門封起來
    for horizontal in (True, False):
        m = barrier > 0 if horizontal else (barrier > 0).T
        fill = np.zeros(m.shape, bool)
        for r in range(m.shape[0]):
            rs = runs_of(m[r])
            for (s1, e1), (s2, e2) in zip(rs, rs[1:]):
                if s2 - e1 <= hi and e1 - s1 >= 2 * t and e2 - s2 >= 2 * t:
                    fill[r, e1:s2] = True
        barrier[fill if horizontal else fill.T] = 255
    return barrier


def floor_color(lab_pixels):
    """房間裡最常見的顏色(Lab 量化後取眾數)就是地板色。"""
    q = np.clip(lab_pixels + [0, 128, 128], 0, 255).astype(np.int32) // 6
    keys = q[:, 0] * 4096 + q[:, 1] * 64 + q[:, 2]
    k = np.bincount(keys).argmax()
    return lab_pixels[keys == k].mean(axis=0)


def lab_real(lab):
    """OpenCV 的 8 位元 Lab 轉回真正的 L*a*b*,才能用色差 ΔE 比較。"""
    lab = lab.astype(np.float32)
    return np.stack([lab[..., 0] * 100 / 255, lab[..., 1] - 128, lab[..., 2] - 128], axis=-1)


def classify_furniture(color_lab, area_m2, long_m, short_m, bedroom):
    L, a, b = color_lab
    chroma = (a * a + b * b) ** 0.5
    if L < 40:
        if long_m / max(short_m, 1e-6) > 2.2 and short_m < 0.3:  # 深色又薄又長:電視(連同電視櫃一起做)
            return "cabinet"
        return "lamp" if area_m2 < 0.3 else "counter"
    if L > 88 and chroma < 15:  # 白色:大的是床,小的是衛浴設備、家電
        return "bed" if area_m2 > 2.0 else "fixture"
    if b > 22 and chroma > 25:  # 木頭 / 橘色系
        if L < 58:
            return "table"
        if long_m / max(short_m, 1e-6) > 2.5:
            return "wardrobe" if bedroom else "cabinet"
        return "low_table"
    if chroma < 14 and 40 <= L < 68:
        return "sofa"
    if chroma < 16 and 68 <= L <= 88 and area_m2 > 1.5:
        return "rug"
    return "other"


def looks_like_furniture(f):
    """濾掉不是家具實體的色塊:文字(細長)、衛浴設備的線稿和陰影(形狀破碎)。"""
    if f["type"] == "lamp":
        return True
    if f["short"] < 0.25:  # 家具最窄的一邊至少 25 cm;比這細的是文字或線條
        return False
    min_solidity = 0.8 if f["type"] in ("other", "fixture") else 0.55
    return f["solidity"] >= min_solidity


def axis_rect(f):
    """家具外框:跟牆差不到 SNAP_DEG 度就轉正;斜很多的(多半是輪廓破碎估錯角度)改用正的外接框。
    室內家具幾乎都順著牆擺。"""
    (cx, cy), (w, h), ang = f["rect"]
    r = ang % 90
    if r < SNAP_DEG or r > 90 - SNAP_DEG:
        return (cx, cy), (w, h), _snap_angle(ang)
    x, y, bw, bh = cv2.boundingRect(f["contour"].astype(np.int32))
    return (x + bw / 2, y + bh / 2), (bw, bh), 0.0


def fix_tv_units(found):
    """臥室裡沿牆的長櫃:在床尾正對面的是電視櫃,在床側邊的才是衣櫃。
    (床頭那端貼著牆,床的長軸方向上會出現的長櫃就只有床尾的電視櫃。)"""
    for bed in (f for f in found if f["type"] == "bed"):
        (bx, by), (bw, bh), ba = bed["rect"]
        long_dir = np.radians(ba if bw >= bh else ba + 90)
        axis = np.array([np.cos(long_dir), np.sin(long_dir)])
        for f in found:
            if f["type"] != "wardrobe":
                continue
            d = np.array(f["rect"][0]) - (bx, by)
            if abs(d @ axis) > 0.8 * np.linalg.norm(d):
                f["type"] = "cabinet"


def drop_stacked(found):
    """疊在別的家具上面的東西(電視櫃上的電視、床上的枕頭)不另外做,
    由底下那件家具的模型負責。地毯例外:沙發、茶几本來就放在地毯上。"""
    rects = [Polygon(cv2.boxPoints(axis_rect(f))) for f in found]
    # 底下那件用真正的輪廓判斷:L 形沙發的外框會把轉角內側的茶几也框進去
    shapes = [Polygon(f["contour"]).buffer(0) for f in found]
    keep = []
    for i, f in enumerate(found):
        under = [j for j in range(len(found))
                 if j != i and found[j]["type"] != "rug" and shapes[j].area > rects[i].area
                 and rects[i].intersection(shapes[j]).area > 0.6 * rects[i].area]
        if not under:
            keep.append(f)
        elif f["lab"][0] < 40:
            # 深色的東西放在長櫃上 = 電視:底下那件是電視櫃,不是衣櫃
            for j in under:
                if found[j]["type"] == "wardrobe":
                    found[j]["type"] = "cabinet"
    return keep


def split_by_color(lab, comp, max_k=3, min_de=12):
    """一塊家具裡有明顯不同的顏色時(例如地毯上放沙發和茶几)分成幾塊。"""
    pts = lab[comp].astype(np.float32)
    best = [comp]
    if len(pts) < 200:
        return best
    for k in range(2, max_k + 1):
        _, labels, centers = cv2.kmeans(pts, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 0.5),
                                        2, cv2.KMEANS_PP_CENTERS)
        de = min(np.linalg.norm(centers[i] - centers[j]) for i in range(k) for j in range(i + 1, k))
        if de < min_de:
            break
        parts = []
        for i in range(k):
            m = np.zeros(comp.shape, bool)
            m[comp] = labels.ravel() == i
            parts.append(m)
        best = parts
    return best


def furniture_pieces(part, lab, im, mm_per_px, min_m2):
    """同一個顏色的區塊可能是好幾件分開的家具(例如兩張沙發),每個外輪廓各算一件。"""
    m2 = mm_per_px * mm_per_px / 1e6
    cnts, _ = cv2.findContours(part.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    pieces = []
    for cnt in cnts:
        area_px = cv2.contourArea(cnt)
        if area_px * m2 < min_m2:
            continue
        solidity = area_px / max(cv2.contourArea(cv2.convexHull(cnt)), 1)
        (cx, cy), (w, h), ang = cv2.minAreaRect(cnt)
        # 接近矩形的用乾淨的矩形(大部分家具都是),否則用簡化過的輪廓
        if area_px / max(w * h, 1) > 0.8:
            poly = cv2.boxPoints(((cx, cy), (w, h), ang))
        else:
            poly = cv2.approxPolyDP(cnt, 1.5, True)[:, 0, :]
        if len(poly) < 3:
            continue
        sel = np.zeros(part.shape, np.uint8)
        cv2.drawContours(sel, [cnt], -1, 1, -1)
        sel = (sel > 0) & part
        pieces.append({
            "rect": ((cx, cy), (w, h), ang),
            "fill": area_px / max(w * h, 1),
            "contour": cnt[:, 0, :].astype(float),
            "poly": np.asarray(poly, float),
            "lab": lab[sel].mean(axis=0),
            "bgr": im[sel].mean(axis=0),
            "area": area_px * m2,
            "solidity": solidity,
            "long": max(w, h) * mm_per_px / 1000,
            "short": min(w, h) * mm_per_px / 1000,
        })
    return pieces


def image_lab(im):
    return lab_real(cv2.cvtColor(cv2.GaussianBlur(im, (5, 5), 0), cv2.COLOR_BGR2LAB))


def segment_rooms(mask, openings, t, mm_per_px):
    """牆和門窗開口圍起來的每一塊空間就是一個房間。回傳 (label 圖, 房間 label 清單)。"""
    barrier = seal_rooms(mask, openings, t, 1 / mm_per_px)
    ys, xs = np.nonzero(mask)
    inside = np.zeros(mask.shape, bool)
    inside[ys.min():ys.max(), xs.min():xs.max()] = True
    space = inside & (cv2.dilate(barrier, np.ones((5, 5), np.uint8)) == 0)
    n, labels = cv2.connectedComponents(space.astype(np.uint8))
    m2 = mm_per_px * mm_per_px / 1e6
    ids = [r for r in range(1, n) if (labels == r).sum() * m2 >= 1.0]  # 太小的是牆角縫隙,不是房間
    return labels, ids


def detect_furniture(im, lab, labels, room_ids, t, mm_per_px):
    """每個房間各自找地板色;跟地板色差很多的色塊就是家具。每件家具記下所在的房間 label。"""
    m2 = mm_per_px * mm_per_px / 1e6
    k = max(3, t // 2) | 1
    open_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    items = []
    for r in room_ids:
        room = labels == r
        floor = floor_color(lab[room])
        de = np.linalg.norm(lab - floor, axis=-1)
        furn = (room & (de > 14)).astype(np.uint8) * 255
        # 去掉細線:文字、家具外框線、門的開啟弧線
        furn = cv2.morphologyEx(cv2.morphologyEx(furn, cv2.MORPH_OPEN, open_k), cv2.MORPH_CLOSE, open_k)
        found = []
        nc, comps, st, _ = cv2.connectedComponentsWithStats(furn)
        for c in range(1, nc):
            if st[c, 4] * m2 < MIN_FURNITURE_M2:
                continue
            for part in split_by_color(lab, comps == c):
                part = cv2.morphologyEx(part.astype(np.uint8) * 255, cv2.MORPH_OPEN, open_k) > 0
                found += furniture_pieces(part, lab, im, mm_per_px, MIN_FURNITURE_M2)
        bedroom = any(f["lab"][0] > 88 and f["area"] > 2.0 for f in found)  # 房間裡有床
        for f in found:
            f["type"] = classify_furniture(f["lab"], f["area"], f["long"], f["short"], bedroom)
            f["room"] = r
        fix_tv_units(found)
        items += drop_stacked([f for f in found if looks_like_furniture(f)])
    return items


# ---------- 牆體規整化 ----------

def _bands(mask, t, horizontal):
    """找出水平(或垂直)走向的牆段,每段用「中位數」決定上下緣,不受邊緣毛刺影響。
    回傳 [along0, along1, across0, across1](像素)。"""
    L = 3 * t
    kernel = np.ones((1, L) if horizontal else (L, 1), np.uint8)
    m = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    if not horizontal:
        m = m.T
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    bands = []
    for i in range(1, n):
        x, y, w, h, _ = st[i]
        if w < L:
            continue
        comp = lab[y:y + h, x:x + w] == i
        cols = comp.any(axis=0)
        top = np.argmax(comp, axis=0)[cols]
        bot = h - np.argmax(comp[::-1], axis=0)[cols]
        bands.append([float(x), float(x + w), y + float(np.median(top)), y + float(np.median(bot))])
    return bands


def _align(bands, t):
    """同一條直線上的牆段(中心線相差不到 0.6 牆厚)對齊到同一條線,厚度統一。"""
    bands.sort(key=lambda b: (b[2] + b[3]) / 2)
    groups = []
    for b in bands:
        c = (b[2] + b[3]) / 2
        if groups and abs(c - groups[-1]["c"]) < 0.6 * t:
            g = groups[-1]
            g["items"].append(b)
            w = np.array([x[1] - x[0] for x in g["items"]])
            g["c"] = float(np.average([(x[2] + x[3]) / 2 for x in g["items"]], weights=w))
        else:
            groups.append({"c": c, "items": [b]})
    for g in groups:
        thick = float(np.median([x[3] - x[2] for x in g["items"]]))
        if abs(thick - t) < 0.35 * t:  # 跟主要牆厚差不多的就統一成同一個厚度
            thick = float(t)
        for b in g["items"]:
            b[2], b[3] = g["c"] - thick / 2, g["c"] + thick / 2
    return bands


def _snap_ends(bands, cross, t):
    """牆段的端點如果碰到垂直的牆,延伸到那道牆的外緣,轉角才會乾淨地接起來。"""
    for b in bands:
        c0, c1 = b[2], b[3]
        for o in cross:  # o 的 across 範圍 = 這邊的 along 座標
            if o[0] - t <= c0 and c1 <= o[1] + t:  # 那道牆的長度範圍涵蓋這段牆的厚度
                if abs(b[0] - o[2]) < 1.2 * t or o[2] - t < b[0] < o[3] + t:
                    b[0] = min(b[0], o[2])
                if abs(b[1] - o[3]) < 1.2 * t or o[2] - t < b[1] < o[3] + t:
                    b[1] = max(b[1], o[3])
    return bands


def regularize_walls(mask, t):
    """把從圖片描出來、邊緣有毛刺的牆,換成乾淨的直角矩形。

    回傳 (rects, leftovers, clean_mask):rects 是 (x0, y0, x1, y1) 像素座標的矩形;
    leftovers 是斜牆、短牆頭等矩形表示不了的部分(輪廓點);clean_mask 是規整後的牆。"""
    h_bands = _align(_bands(mask, t, True), t)
    v_bands = _align(_bands(mask, t, False), t)
    h_bands = _snap_ends(h_bands, v_bands, t)
    v_bands = _snap_ends(v_bands, h_bands, t)
    rects = [(b[0], b[2], b[1], b[3]) for b in h_bands] + [(b[2], b[0], b[3], b[1]) for b in v_bands]

    clean = np.zeros_like(mask)
    for x0, y0, x1, y1 in rects:
        cv2.rectangle(clean, (int(round(x0)), int(round(y0))), (int(round(x1)) - 1, int(round(y1)) - 1), 255, -1)
    # 沒被矩形涵蓋、而且夠厚夠長的部分(斜牆、短牆頭)才保留;沿著牆邊的毛刺丟掉
    rest = cv2.bitwise_and(mask, cv2.bitwise_not(cv2.dilate(clean, np.ones((5, 5), np.uint8))))
    leftovers = []
    n, lab, st, _ = cv2.connectedComponentsWithStats(rest)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if max(w, h) >= 2 * t and area / max(w, h) >= 0.5 * t:
            comp = (lab == i).astype(np.uint8)
            cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cnt = max(cnts, key=cv2.contourArea)
            rect = cv2.minAreaRect(cnt)
            if cv2.contourArea(cnt) > 0.7 * rect[1][0] * rect[1][1]:  # 差不多是矩形(短牆頭)就用矩形
                c = cv2.boxPoints((rect[0], rect[1], _snap_angle(rect[2])))
            else:  # 斜牆或真正不規則的牆才保留輪廓
                c = cv2.approxPolyDP(cnt, 1.5, True)[:, 0, :]
            if len(c) >= 3:
                leftovers.append(c.astype(float))
                cv2.fillPoly(clean, [c.astype(np.int32)], 255)
    return rects, leftovers, clean


# ---------- 家具擺放 ----------

SNAP_DEG = 10  # 跟牆的方向差不到這麼多度的家具,轉正


def _snap_angle(a):
    r = a % 90
    if r < SNAP_DEG:
        return a - r
    if r > 90 - SNAP_DEG:
        return a + 90 - r
    return a


def place_furniture(f, wall_dist, to_mm):
    """決定家具在模型裡的位置、方向(哪一面靠牆)和尺寸。模型零件由前端依型錄產生。"""
    corners_px = cv2.boxPoints(axis_rect(f))
    corners = np.array([to_mm(p) for p in corners_px])
    center = corners.mean(axis=0)
    sides = []
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        mid = (a + b) / 2
        n = mid - center
        n /= np.linalg.norm(n) or 1
        mid_px = (corners_px[i] + corners_px[(i + 1) % 4]) / 2
        px = np.clip(mid_px.astype(int), 0, [wall_dist.shape[1] - 1, wall_dist.shape[0] - 1])
        sides.append({"len": float(np.linalg.norm(b - a)), "n": n, "dist": float(wall_dist[px[1], px[0]]), "i": i})

    long_side = max(s["len"] for s in sides)
    short = [s for s in sides if s["len"] < long_side - 1e-6] or sides
    short_ids = {s["i"] for s in short}
    longs = [s for s in sides if s["i"] not in short_ids] or sides
    # 床頭在短邊、其他家具的背面在長邊;選離牆最近的那一邊當背面
    candidates = short if f["type"] == "bed" else longs
    back = min(candidates, key=lambda s: s["dist"])

    opts = {}
    if f["type"] == "sofa" and f["fill"] < 0.8:  # L 形沙發:背面要選在「滿」的那個轉角兩側
        A = f["area"] * 1e6
        Wr, Dr = sides[0]["len"], sides[1]["len"]
        disc = (Wr + Dr) ** 2 - 4 * A
        depth = ((Wr + Dr) - disc ** 0.5) / 2 if disc > 0 else min(Wr, Dr) / 2
        footprint = Polygon([to_mm(p) for p in f["contour"]]).buffer(0)
        full = max(range(4), key=lambda k: footprint.intersection(
            shp_box(*(corners[k] - depth / 2), *(corners[k] + depth / 2))).area)
        q = corners[full] - center
        # 轉角兩邊都是背面;挑讓轉角落在局部 +x 那一側的當主要背面
        for s in sides:
            if s["i"] in (full, (full - 1) % 4):
                xhat = np.array([s["n"][1], -s["n"][0]])
                if q @ xhat > 0:
                    back = s
        opts["l_depth"] = depth
    if f["type"] == "table":
        opts["oval"] = 0.6 < f["fill"] < 0.86 and f["solidity"] > 0.85
    if f["type"] == "counter":
        opts["stove"] = f["lab"][0] < 45
    if f["type"] == "fixture":
        opts["bluish"] = f["lab"][2] < -3

    yhat = back["n"]
    xhat = np.array([yhat[1], -yhat[0]])
    W = back["len"]
    D = sides[(back["i"] + 1) % 4]["len"]
    return {
        "type": f["type"],
        "x": float(center[0]),
        "y": float(center[1]),
        "angle": float(np.degrees(np.arctan2(xhat[1], xhat[0]))),
        "width": float(W),
        "depth": float(D),
        "color": "#%02x%02x%02x" % tuple(int(c) for c in f["bgr"][::-1]),
        "options": {k: (float(v) if isinstance(v, (float, np.floating)) else bool(v)) for k, v in opts.items()},
    }
