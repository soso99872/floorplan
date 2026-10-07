"""產生兩張測試用的 2D 三視圖 DXF(模型空間 1:1,單位 mm)。

bracket.dxf    L 形支架,第三角法(俯視圖在上、右視圖在右)
boss_block.dxf 帶凸台的方塊,第一角法(俯視圖在下、左視圖在右)

可見輪廓線在 OUTLINE 圖層,隱藏線在 HIDDEN(虛線),中心線在 CENTER,尺寸在 DIM,
跟一般工程圖的圖層習慣一樣——轉換程式不靠圖層名稱判斷視圖,只靠位置排列。
"""
from pathlib import Path

import ezdxf

OUT = Path(__file__).parent / "samples"


def new_doc():
    doc = ezdxf.new("R2010", setup=True)  # setup=True 會載入 DASHED/CENTER 等標準線型
    doc.layers.add("OUTLINE", color=7)
    doc.layers.add("HIDDEN", color=8, linetype="DASHED")
    doc.layers.add("CENTER", color=1, linetype="CENTER")
    doc.layers.add("DIM", color=3)
    return doc


def rect(msp, x0, y0, x1, y1, layer="OUTLINE"):
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": layer})


def line(msp, p, q, layer="OUTLINE"):
    msp.add_line(p, q, dxfattribs={"layer": layer})


def dim(msp, p1, p2, base, angle=0):
    msp.add_linear_dim(base=base, p1=p1, p2=p2, angle=angle, dxfattribs={"layer": "DIM"}).render()


def bracket():
    """底板 80x50x10,後方立板 80x10x50;底板兩個 Ø12 通孔,立板一個 Ø16 通孔。"""
    doc = new_doc()
    msp = doc.modelspace()

    # 前視圖 (u=X, v=Z),原點 (0,0)
    rect(msp, 0, 0, 80, 60)
    line(msp, (0, 10), (80, 10))
    msp.add_circle((40, 35), 8, dxfattribs={"layer": "OUTLINE"})
    for x in (14, 26, 54, 66):
        line(msp, (x, 0), (x, 10), "HIDDEN")
    line(msp, (40, 23), (40, 47), "CENTER")
    line(msp, (28, 35), (52, 35), "CENTER")
    dim(msp, (0, 0), (80, 0), (0, -12))
    dim(msp, (0, 0), (0, 60), (-12, 0), angle=90)

    # 俯視圖 (u=X, v=Y),第三角法放在前視圖上方
    oy = 90
    rect(msp, 0, oy, 80, oy + 50)
    line(msp, (0, oy + 40), (80, oy + 40))
    for cx in (20, 60):
        msp.add_circle((cx, oy + 20), 6, dxfattribs={"layer": "OUTLINE"})
        line(msp, (cx, oy + 11), (cx, oy + 29), "CENTER")
        line(msp, (cx - 9, oy + 20), (cx + 9, oy + 20), "CENTER")
    for x in (32, 48):
        line(msp, (x, oy + 40), (x, oy + 50), "HIDDEN")
    dim(msp, (80, oy), (80, oy + 50), (92, oy), angle=90)

    # 右視圖 (u=Y, v=Z),放在前視圖右邊
    ox = 110
    msp.add_lwpolyline(
        [(ox, 0), (ox + 50, 0), (ox + 50, 60), (ox + 40, 60), (ox + 40, 10), (ox, 10)],
        close=True, dxfattribs={"layer": "OUTLINE"},
    )
    for z in (27, 43):
        line(msp, (ox + 40, z), (ox + 50, z), "HIDDEN")
    for y in (14, 26):
        line(msp, (ox + y, 0), (ox + y, 10), "HIDDEN")
    dim(msp, (ox + 40, 60), (ox + 50, 60), (ox, 70))

    doc.saveas(OUT / "bracket.dxf")


def boss_block():
    """方塊 60x40x15,上方 Ø24 高 15 的凸台(中心 x=30, y=15,刻意不對稱),Ø10 貫穿孔。"""
    doc = new_doc()
    msp = doc.modelspace()

    # 前視圖 (u=X, v=Z)
    msp.add_lwpolyline(
        [(0, 0), (60, 0), (60, 15), (42, 15), (42, 30), (18, 30), (18, 15), (0, 15)],
        close=True, dxfattribs={"layer": "OUTLINE"},
    )
    line(msp, (18, 15), (42, 15))
    for x in (25, 35):
        line(msp, (x, 0), (x, 30), "HIDDEN")
    line(msp, (30, -3), (30, 33), "CENTER")
    dim(msp, (0, 0), (60, 0), (0, -10))

    # 俯視圖,第一角法放在前視圖「下方」(影像本身與第三角法相同:後緣在上)
    oy = -70
    rect(msp, 0, oy, 60, oy + 40)
    msp.add_circle((30, oy + 15), 12, dxfattribs={"layer": "OUTLINE"})
    msp.add_circle((30, oy + 15), 5, dxfattribs={"layer": "OUTLINE"})
    line(msp, (30, oy), (30, oy + 30), "CENTER")
    line(msp, (15, oy + 15), (45, oy + 15), "CENTER")

    # 左視圖 (從 -X 看,u = 40 - Y),第一角法放在前視圖「右邊」
    ox = 90
    msp.add_lwpolyline(
        [(ox, 0), (ox + 40, 0), (ox + 40, 15), (ox + 37, 15), (ox + 37, 30), (ox + 13, 30), (ox + 13, 15), (ox, 15)],
        close=True, dxfattribs={"layer": "OUTLINE"},
    )
    line(msp, (ox + 13, 15), (ox + 37, 15))
    for u in (20, 30):
        line(msp, (ox + u, 0), (ox + u, 30), "HIDDEN")

    doc.saveas(OUT / "boss_block.dxf")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    bracket()
    boss_block()
    print("samples written to", OUT)
