"""自產的 AutoCAD 測試檔:把範例圖的辨識結果匯出成 DXF,再做出各種常見畫法的變體。

真實的 CAD 圖每家事務所畫法都不一樣(圖層名稱、單位、牆有沒有填實、門是不是圖塊),
這些變體用來確保匯入程式不會只認得我們自己匯出的格式。

重新產生網頁上的 CAD 範例檔:
  cd backend && ..\\.venv\\Scripts\\python -m tests.cad_fixtures
"""
import io
from pathlib import Path

import ezdxf
from ezdxf.math import Matrix44

from floorplan.dxf_export import export_dxf

SAMPLES = Path(__file__).parent.parent / "samples"
ZH_LAYERS = {"A-WALL": "牆", "A-DOOR": "門", "A-GLAZ": "窗", "A-FURN": "家具", "A-AREA-IDEN": "房間名稱",
             "A-DIMS": "標註"}


def _load(data):
    return ezdxf.read(io.StringIO(data.decode("utf-8")))


def _dump(doc):
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


def _rename_layers(doc, mapping):
    for e in doc.modelspace():
        if e.dxf.layer in mapping:
            e.dxf.layer = mapping[e.dxf.layer]
    for old, new in mapping.items():
        doc.layers.add(new, color=doc.layers.get(old).color)


def _drop(doc, pred):
    msp = doc.modelspace()
    for e in [e for e in msp if pred(e)]:
        msp.delete_entity(e)


def _doors_to_blocks(doc):
    """門的線和弧各自包成一個圖塊(很多事務所的門是圖塊),圖塊內容放在 0 層。"""
    msp = doc.modelspace()
    doors = [e for e in msp if e.dxf.layer == "A-DOOR"]
    lines = [e for e in doors if e.dxftype() == "LINE"]
    for i, line in enumerate(lines):
        start = line.dxf.start
        arc = next(a for a in doors if a.dxftype() == "ARC" and a.dxf.center.isclose(start, abs_tol=1))
        name = f"DOOR-{i + 1}"
        blk = doc.blocks.new(name)
        blk.add_line(line.dxf.start - start, line.dxf.end - start)
        blk.add_arc((0, 0), arc.dxf.radius, arc.dxf.start_angle, arc.dxf.end_angle)
        msp.add_blockref(name, start, dxfattribs={"layer": "A-DOOR"})
        doors.remove(arc)
        msp.delete_entity(arc)
        msp.delete_entity(line)


def make_variants(scene):
    """回傳 {名稱: DXF bytes}。"""
    base = export_dxf(scene)
    out = {"export": base}

    doc = _load(base)
    _rename_layers(doc, ZH_LAYERS)
    out["zh_layers"] = _dump(doc)

    doc = _load(base)
    _drop(doc, lambda e: e.dxftype() == "HATCH")
    _rename_layers(doc, ZH_LAYERS)
    out["zh_double_line"] = _dump(doc)  # 牆只有雙線外框、沒有填實

    doc = _load(base)
    _drop(doc, lambda e: e.dxftype() == "DIMENSION")
    m = Matrix44.scale(0.001)
    for e in doc.modelspace():
        e.transform(m)
    doc.header["$INSUNITS"] = 6
    out["meters"] = _dump(doc)

    doc = _load(base)
    _doors_to_blocks(doc)
    doc.header["$INSUNITS"] = 0  # 沒設定單位:要靠圖的大小猜出是 mm
    out["door_blocks_unitless"] = _dump(doc)
    return out


def main():
    from floorplan.build import build_scene

    scene = build_scene(SAMPLES / "images" / "floorplan.png", 12000, 3000).scene
    variants = make_variants(scene)
    dest = SAMPLES / "cad"
    dest.mkdir(exist_ok=True)
    (dest / "apartment_zh.dxf").write_bytes(variants["zh_double_line"])
    (dest / "apartment_aia.dxf").write_bytes(variants["door_blocks_unitless"])
    print("已寫入", dest)


if __name__ == "__main__":
    main()
