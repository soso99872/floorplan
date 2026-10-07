"""程序化家具模型:依種類和外框尺寸,用方塊/圓柱/圓錐組出看起來像真的家具。

座標是家具自己的局部座標(mm):原點在外框中心、地面 z=0,
+x 沿家具寬度,+y 指向「背面」(床頭、沙發椅背、櫃子靠牆那側),-y 是正面。
每個零件:
  {"kind": "box", "c": [x, y, z], "s": [sx, sy, sz], "color": "#rrggbb"}       c 是方塊中心
  {"kind": "cyl", "c": [x, y, z0], "h": h, "r": [r_bottom, r_top], "color": ..., "sx": 1, "sy": 1}
     圓柱(上下半徑不同就是圓錐),sx / sy 是水平方向縮放,用來做橢圓桌面
零件同時給網頁 (three.js) 畫圖、給 cadquery 輸出 STEP,兩邊看到的是同一個模型。
"""

WOOD = "#8a6240"
WOOD_DARK = "#5c4030"
WHITE = "#f3f1ec"
LINEN = "#e9e4d8"
BLACK = "#1c1c1e"
METAL = "#9a9ea6"
STONE = "#3d3f44"
SHADE = "#f3e3c3"
WATER = "#cfe3f0"


def box(x, y, z0, sx, sy, sz, color, rz=0.0, opacity=1.0):
    """rz:繞自己中心的水平旋轉角度(度),用在半開的門片;opacity < 1 是玻璃。"""
    p = {"kind": "box", "c": [x, y, z0 + sz / 2], "s": [sx, sy, sz], "color": color}
    if rz:
        p["rz"] = rz
    if opacity < 1:
        p["opacity"] = opacity
    return p


def cyl(x, y, z0, h, r0, r1=None, color=METAL, sx=1.0, sy=1.0):
    return {"kind": "cyl", "c": [x, y, z0], "h": h, "r": [r0, r0 if r1 is None else r1], "color": color, "sx": sx, "sy": sy}


def luminance(hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.299 * r + 0.587 * g + 0.114 * b


def shade(hex_color, f):
    """把顏色調暗 (f<1) 或調亮 (f>1)。"""
    c = [int(hex_color[i:i + 2], 16) for i in (1, 3, 5)]
    if f < 1:
        c = [v * f for v in c]
    else:
        c = [v + (255 - v) * (f - 1) for v in c]
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(v))) for v in c)


def legs(w, d, h, inset=60, size=40, color=WOOD_DARK, round_=False):
    out = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * (w / 2 - inset), sy * (d / 2 - inset)
            out.append(cyl(x, y, 0, h, size / 2, color=color) if round_ else box(x, y, 0, size, size, h, color))
    return out


# ---------- 各種家具 ----------

def bed(W, D, color):
    """W = 床頭那一邊的寬度,D = 床長。"""
    # 平面圖上的床多半畫成白色;整張白的床看不出棉被,改用淺灰藍的被套
    cover = color if luminance(color) < 215 else "#d5dee8"
    head = 60
    body_y, body_d = -head / 2, D - head
    parts = [
        box(0, body_y, 80, W, body_d, 200, WOOD),  # 床架
        *legs(W, body_d, 80, inset=80, size=60, color=WOOD_DARK),
        box(0, body_y, 280, W - 40, body_d - 40, 200, WHITE),  # 床墊
        box(0, body_y - body_d * 0.12, 480, W - 10, body_d * 0.68, 35, cover),  # 棉被
        box(0, body_y - body_d * 0.12 - body_d * 0.34 + 15, 300, W - 10, 30, 210, cover),  # 棉被垂下來的那一截
        box(0, D / 2 - head / 2, 0, W, head, 1050, shade(WOOD, 0.85)),  # 床頭板
    ]
    n = 2 if W >= 1200 else 1
    pw = (W - 140) / n - 40
    for i in range(n):
        x = -W / 2 + 70 + (i + 0.5) * (W - 140) / n
        parts.append(box(x, D / 2 - head - 230, 480, pw, 360, 130, LINEN))  # 枕頭
    return parts


def sofa(W, D, color, arms=(True, True)):
    arm = min(180, W * 0.12)
    back = min(220, D * 0.25)
    base_c = shade(color, 0.85)
    parts = [
        box(0, 0, 100, W, D, 240, base_c),  # 底座
        box(0, D / 2 - back / 2, 100, W, back, 700, color),  # 椅背
        *legs(W, D, 100, inset=60, size=50, color=WOOD_DARK, round_=True),
    ]
    left = -W / 2 + (arm if arms[0] else 0)
    right = W / 2 - (arm if arms[1] else 0)
    seat_d = D - back
    n = max(1, round((right - left) / 700))
    cw = (right - left) / n
    for i in range(n):  # 坐墊、靠墊
        x = left + (i + 0.5) * cw
        parts.append(box(x, -back / 2, 340, cw - 15, seat_d - 20, 120, shade(color, 1.08)))
        parts.append(box(x, D / 2 - back - 70, 460, cw - 40, 140, 360, shade(color, 1.12)))
    for side, on in zip((-1, 1), arms):
        if on:  # 扶手
            parts.append(box(side * (W / 2 - arm / 2), -back / 2 + 0.5, 100, arm, D - back + 1, 520, color))
    return parts


def l_sofa(W, D, depth, color):
    """L 形沙發:背靠 +y 和 +x 兩邊,轉角在右後方。"""
    parts = []
    # 沿 +y 那條(整個寬度),左邊有扶手
    for p in sofa(W, depth, color, arms=(True, False)):
        p = dict(p, c=[p["c"][0], p["c"][1] + D / 2 - depth / 2, p["c"][2]])
        parts.append(p)
    # 沿 +x 那條(轉角以外的長度),局部座標轉 90°:椅背朝 +x
    L = D - depth
    for p in sofa(L, depth, color, arms=(False, True)):  # 轉 90° 後,局部右端是遠離轉角的那頭
        x, y, z = p["c"]
        q = dict(p, c=[W / 2 - depth / 2 + y, -D / 2 + L / 2 + x * -1, z])
        if p["kind"] == "box":
            q["s"] = [p["s"][1], p["s"][0], p["s"][2]]
        parts.append(q)
    return parts


def chair(color):
    """餐椅,正面朝 -y(面向桌子的方向由呼叫端旋轉)。"""
    return [
        *legs(420, 420, 440, inset=30, size=35, color=WOOD_DARK),
        box(0, 0, 440, 440, 440, 40, color),
        box(0, 200, 480, 420, 40, 420, color),
    ]


def rotate_parts(parts, quarter_turns, dx, dy):
    out = []
    for p in parts:
        x, y, z = p["c"]
        for _ in range(quarter_turns % 4):
            x, y = -y, x
        q = dict(p, c=[x + dx, y + dy, z])
        if p["kind"] == "box" and quarter_turns % 2:
            q["s"] = [p["s"][1], p["s"][0], p["s"][2]]
        out.append(q)
    return out


def dining(W, D, color, oval=False):
    """外框通常連椅子一起框進來(椅子一半塞在桌下),桌面取內圈,椅子沿長邊排一圈。"""
    with_chairs = min(W, D) > 1100
    tw, td = (W - 600, D - 600) if with_chairs else (W, D)
    tw, td = max(tw, 700), max(td, 700)
    top = shade(color, 1.0)
    parts = []
    if oval:
        parts.append(cyl(0, 0, 710, 40, 1, color=top, sx=tw / 2, sy=td / 2))
        parts.append(cyl(0, 0, 0, 710, 70, 60, color=WOOD_DARK))
        parts.append(cyl(0, 0, 0, 25, min(tw, td) * 0.25, color=WOOD_DARK))
    else:
        parts.append(box(0, 0, 710, tw, td, 40, top))
        parts += legs(tw, td, 710, inset=70, size=60, color=WOOD_DARK)
    if with_chairs:
        long_x = tw >= td
        L, S = (tw, td) if long_x else (td, tw)
        n = max(1, round(L / 600))
        for i in range(n):
            a = -L / 2 + (i + 0.5) * L / n
            for side in (-1, 1):
                dist = S / 2 + 110
                # 椅背朝外:椅子局部 +y 指向離開桌子的方向
                if long_x:
                    parts += rotate_parts(chair(shade(color, 0.9)), 0 if side > 0 else 2, a, side * dist)
                else:
                    parts += rotate_parts(chair(shade(color, 0.9)), 3 if side > 0 else 1, side * dist, a)
        if L > 1000:  # 長桌兩端各一張
            for side in (-1, 1):
                dist = L / 2 + 110
                if long_x:
                    parts += rotate_parts(chair(shade(color, 0.9)), 3 if side > 0 else 1, side * dist, 0)
                else:
                    parts += rotate_parts(chair(shade(color, 0.9)), 0 if side > 0 else 2, 0, side * dist)
    return parts


def low_table(W, D, color):
    return [
        box(0, 0, 390, W, D, 50, color),
        box(0, 0, 120, W - 120, D - 120, 25, shade(color, 0.85)),  # 下層板
        *legs(W, D, 390, inset=40, size=45, color=WOOD_DARK),
    ]


def wardrobe(W, D, color):
    H = 2000
    parts = [box(0, 0, 0, W, D, 60, WOOD_DARK), box(0, 0, 60, W, D, H - 60, color)]
    n = max(2, round(W / 500))
    for i in range(1, n):  # 門縫
        parts.append(box(-W / 2 + i * W / n, -D / 2 - 1, 80, 6, 4, H - 100, shade(color, 0.6)))
    for i in range(n):  # 把手
        x = -W / 2 + (i + 0.5) * W / n + (W / n / 2 - 60) * (1 if i % 2 == 0 else -1)
        parts.append(box(x, -D / 2 - 12, 900, 20, 20, 300, METAL))
    return parts


def cabinet(W, D, color):
    """矮櫃 / 電視櫃;夠長的話上面放一台電視。"""
    if luminance(color) < 70:  # 顏色取自電視本身(黑色),櫃子改用木色
        color = WOOD
    parts = [box(0, 0, 120, W, D, 400, color), *legs(W, D, 120, inset=50, size=40, color=WOOD_DARK)]
    n = max(1, round(W / 600))
    for i in range(1, n):
        parts.append(box(-W / 2 + i * W / n, -D / 2 - 1, 140, 5, 4, 360, shade(color, 0.6)))
    if W >= 800:
        tw = min(W * 0.75, 1450)
        th = tw * 9 / 16
        parts += [
            box(0, D / 2 - 150, 520, 300, 180, 20, BLACK),  # 電視底座
            box(0, D / 2 - 150, 540, 60, 40, 80, BLACK),
            box(0, D / 2 - 150, 600, tw, 45, th, BLACK),  # 螢幕
        ]
    return parts


def counter(W, D, color, stove=False):
    parts = [
        box(0, 0, 0, W, D, 80, STONE),  # 踢腳
        box(0, 10, 80, W, D - 20, 780, WHITE),
        box(0, 0, 860, W + 20, D + 20, 40, STONE),  # 檯面
    ]
    if stove:
        for dx in (-0.25, 0.25):
            for dy in (-0.22, 0.22):
                parts.append(cyl(dx * W, dy * D, 900, 12, min(W, D) * 0.12, color=BLACK))
    return parts


def appliance(W, D, color):
    return [
        box(0, 0, 0, W, D, 850, WHITE),
        box(0, -D / 2 - 1, 120, W - 40, 4, 700, shade(WHITE, 0.92)),  # 門板
        box(W / 2 - 80, -D / 2 - 15, 500, 25, 25, 260, METAL),  # 把手
    ]


def bathtub(W, D, color):
    return [
        box(0, 0, 0, W, D, 550, WHITE),
        box(0, 0, 545, W - 140, D - 140, 8, WATER),  # 浴缸內的水面(簡化)
    ]


def lamp(W, D, color):
    r = max(min(W, D) / 2, 120)
    return [
        cyl(0, 0, 0, 25, r * 0.8, color=BLACK),
        cyl(0, 0, 25, 1150, 12, color=METAL),
        cyl(0, 0, 1150, 300, r * 1.1, r * 0.75, color=SHADE),
    ]


def rug(W, D, color):
    return [box(0, 0, 0, W, D, 12, color)]


def generic(W, D, color, h=700):
    return [box(0, 0, 0, W, D, h, color)]


# ---------- 門窗 ----------
# 局部座標:x 沿著牆,y 是牆厚方向(門往 -y 那一側開),z 從地面算起。W = 開口寬,T = 牆厚

FRAME = "#f1efea"
GLASS = "#9ec9e6"
DOOR_WOOD = "#a77b52"
ENTRY_WOOD = "#6e4a31"


def window(W, T, sill, head):
    f = 55  # 窗框寬
    d = min(T * 0.6, 90)  # 窗框深
    h = head - sill
    parts = [
        box(-W / 2 + f / 2, 0, sill, f, d, h, FRAME),
        box(W / 2 - f / 2, 0, sill, f, d, h, FRAME),
        box(0, 0, sill, W, d, f, FRAME),
        box(0, 0, head - f, W, d, f, FRAME),
        box(0, -T / 2 - 15, sill - 30, W + 80, 70, 30, FRAME),  # 室內窗台板
        box(0, 0, sill + f, W - 2 * f, 8, h - 2 * f, GLASS, opacity=0.35),
    ]
    if W > 1000:  # 寬窗中間加一根直料,看起來是兩扇
        parts.append(box(0, 0, sill + f, 45, d, h - 2 * f, FRAME))
    return parts


LEAF_T = 40  # 門片厚度


def leaf(hinge_x, length, head, side, color, T):
    """一片門片。門片可以繞鉸鏈轉(網頁上點門開關),所以零件給的是「以鉸鏈為原點、關門狀態」
    的座標;hinge 是鉸鏈在門的局部座標裡的位置。side = +1 門片從鉸鏈往 +x 延伸,-1 往 -x。
    打開時一律往局部 -y 那側轉:轉角 = -side * 開門角度。"""
    parts = [box(side * length / 2, 0, 0, length, LEAF_T, head - 15, color)]
    for y in (-35, 35):  # 把手,門片兩面各一支,在離鉸鏈遠的那端
        parts.append(box(side * (length - 80), y, 1000, 120, 18, 22, METAL))
    # 關門時門片貼齊開門那側的牆面
    return {"hinge": [hinge_x, -T / 2 + LEAF_T / 2], "side": side, "parts": parts}


def door(W, T, head, entry=False):
    """回傳 (門框零件, 門片清單)。W > 1800 是開放的通道,只有門框;1200~1800 是雙開門;其餘單開門。"""
    color = ENTRY_WOOD if entry else DOOR_WOOD
    f, d = 50, T + 20
    frame = [
        box(-W / 2 + f / 2, 0, 0, f, d, head, FRAME),
        box(W / 2 - f / 2, 0, 0, f, d, head, FRAME),
        box(0, 0, head - f, W, d, f, FRAME),
    ]
    clear = W - 2 * f
    if W > 1800:
        return frame, []
    if W > 1200:
        return frame, [leaf(-clear / 2, clear / 2, head - f, +1, color, T),
                       leaf(clear / 2, clear / 2, head - f, -1, color, T)]
    return frame, [leaf(-clear / 2, clear, head - f, +1, color, T)]


def build(kind, W, D, color, **opt):
    """回傳零件清單。kind 對應 plan2model 的家具種類。"""
    if kind == "bed":
        return bed(W, D, color)
    if kind == "sofa":
        if opt.get("l_depth"):
            return l_sofa(W, D, opt["l_depth"], color)
        return sofa(W, D, color)
    if kind == "table":
        return dining(W, D, color, oval=opt.get("oval", False))
    if kind == "low_table":
        return low_table(W, D, color)
    if kind == "wardrobe":
        return wardrobe(W, D, color)
    if kind == "cabinet":
        return cabinet(W, D, color)
    if kind == "counter":
        return counter(W, D, color, stove=opt.get("stove", False))
    if kind == "fixture":
        return bathtub(W, D, color) if opt.get("bluish") else appliance(W, D, color)
    if kind == "lamp":
        return lamp(W, D, color)
    if kind == "rug":
        return rug(W, D, color)
    return generic(W, D, color)
