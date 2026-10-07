"""產生預覽圖:原始 DXF 圖面 + 重建出來的 3D 模型(兩個角度),存成一張 PNG。

用法: python preview.py samples/bracket.dxf out/bracket.step [-o out/bracket_preview.png]
"""
import argparse

import cadquery as cq
import ezdxf
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def draw_dxf(ax, path):
    doc = ezdxf.readfile(path)
    Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(doc.modelspace())
    ax.set_title("2D drawing (input)")
    ax.set_aspect("equal")


def draw_solid(ax, shape, elev, azim, title):
    verts, tris = shape.tessellate(0.05, 0.2)
    pts = [v.toTuple() for v in verts]
    mesh = Poly3DCollection([[pts[i] for i in t] for t in tris], facecolor="#9ab8d8", edgecolor="none", alpha=1.0)
    ax.add_collection3d(mesh)
    for e in shape.Edges():
        n = 2 if e.geomType() == "LINE" else 48
        xyz = [e.positionAt(i / (n - 1)).toTuple() for i in range(n)]
        ax.plot(*zip(*xyz), color="#1f2d3d", linewidth=0.8)
    bb = shape.BoundingBox()
    size = max(bb.xlen, bb.ylen, bb.zlen)
    ax.set_xlim(bb.center.x - size / 2, bb.center.x + size / 2)
    ax.set_ylim(bb.center.y - size / 2, bb.center.y + size / 2)
    ax.set_zlim(bb.center.z - size / 2, bb.center.z + size / 2)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=elev, azim=azim)
    ax.set_xlabel("X")
    ax.set_ylabel("Y")
    ax.set_zlabel("Z")
    ax.set_title(title)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dxf")
    ap.add_argument("step")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    shape = cq.importers.importStep(a.step).val()

    fig = plt.figure(figsize=(16, 5.5))
    draw_dxf(fig.add_subplot(1, 3, 1), a.dxf)
    draw_solid(fig.add_subplot(1, 3, 2, projection="3d"), shape, 25, -60, "3D model (front-left)")
    draw_solid(fig.add_subplot(1, 3, 3, projection="3d"), shape, 30, 40, "3D model (back-right)")
    fig.tight_layout()
    out = a.out or a.step.rsplit(".", 1)[0] + "_preview.png"
    fig.savefig(out, dpi=110)
    print("preview:", out)


if __name__ == "__main__":
    main()
