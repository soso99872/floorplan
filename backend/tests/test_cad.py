"""AutoCAD 匯出 / 匯入測試:範例圖 → DXF(各種畫法)→ 再匯入,結果要跟原本一致。"""
import io
import math
from collections import Counter
from pathlib import Path

import ezdxf
import pytest
from fastapi.testclient import TestClient

from app import app
from floorplan.build import build_scene
from floorplan.cad_import import CadError, build_scene_from_cad, find_odafc

from .cad_fixtures import make_variants

SAMPLE = Path(__file__).parent.parent / "samples" / "images" / "floorplan.png"


@pytest.fixture(scope="module")
def original():
    return build_scene(SAMPLE, 12000, 3000, with_background=False).scene


@pytest.fixture(scope="module")
def variants(original):
    return make_variants(original)


def wall_length(scene):
    return sum(math.dist(w.a, w.b) for w in scene.walls)


def door_signature(scene):
    """每個門窗:種類、門片數、開門方向(世界座標)。位置用相對整體中心的座標,不受平移影響。"""
    walls = {w.id: w for w in scene.walls}
    items = []
    for o in scene.openings:
        w = walls[o.wall]
        L = math.dist(w.a, w.b)
        u = ((w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L)
        c = (w.a[0] + u[0] * o.offset, w.a[1] + u[1] * o.offset)
        out = (round(-u[1] * o.swing), round(u[0] * o.swing)) if o.kind == "door" else None
        items.append((o.kind, o.leaves, out, c))
    cx = sum(i[3][0] for i in items) / len(items)
    cy = sum(i[3][1] for i in items) / len(items)
    return [(k, lv, out, (c[0] - cx, c[1] - cy)) for k, lv, out, c in items]


def same_openings(a, b, tol=150):
    """兩組門窗一一對得上:種類、門片數、開門方向相同,位置差 tol mm 以內。"""
    left = list(b)
    for k, lv, out, c in a:
        hit = next((x for x in left if x[:3] == (k, lv, out) and math.dist(x[3], c) < tol), None)
        if hit is None:
            return False
        left.remove(hit)
    return not left


def test_export_layers(variants):
    doc = ezdxf.read(io.StringIO(variants["export"].decode("utf-8")))
    layers = Counter(e.dxf.layer for e in doc.modelspace())
    assert layers["A-WALL"] > 0 and layers["A-DOOR"] > 0 and layers["A-GLAZ"] > 0
    assert layers["A-FURN"] == 28
    assert doc.header["$INSUNITS"] == 4


@pytest.mark.parametrize("name", ["export", "zh_layers", "zh_double_line", "meters", "door_blocks_unitless"])
def test_round_trip(original, variants, name):
    scene = build_scene_from_cad(variants[name], f"{name}.dxf", with_background=False).scene
    assert len(scene.walls) == len(original.walls)
    assert wall_length(scene) == pytest.approx(wall_length(original), rel=0.02)
    assert same_openings(door_signature(scene), door_signature(original))
    assert len(scene.furniture) == len(original.furniture)
    assert Counter(f.type for f in scene.furniture) == Counter(f.type for f in original.furniture)
    assert sorted(r.name for r in scene.rooms) == sorted(r.name for r in original.rooms)
    for a, b in zip(sorted(original.rooms, key=lambda r: r.name), sorted(scene.rooms, key=lambda r: r.name)):
        assert b.area == pytest.approx(a.area, abs=0.3)


def test_layer_override(variants):
    """使用者把牆圖層改成「忽略」→ 找不到牆;沒有任何牆圖層時要回報清楚的錯誤。"""
    with pytest.raises(CadError, match="牆"):
        build_scene_from_cad(variants["export"], "x.dxf", layer_roles={"A-WALL": "ignore"})


def test_bad_file():
    with pytest.raises(CadError):
        build_scene_from_cad(b"this is not a dxf", "x.dxf")


@pytest.mark.skipif(find_odafc() is not None, reason="已安裝 ODA File Converter")
def test_dwg_without_converter():
    with pytest.raises(CadError, match="ODA File Converter"):
        build_scene_from_cad(b"AC1032", "x.dwg")


@pytest.mark.skipif(find_odafc() is None, reason="沒有安裝 ODA File Converter")
def test_dwg_round_trip(tmp_path, variants, original):
    from ezdxf.addons import odafc

    ezdxf.options.set("odafc-addon", "win_exec_path", find_odafc())
    src = tmp_path / "plan.dxf"
    src.write_bytes(variants["export"])
    odafc.convert(str(src), str(tmp_path / "plan.dwg"), version="R2018")
    scene = build_scene_from_cad((tmp_path / "plan.dwg").read_bytes(), "plan.dwg", with_background=False).scene
    assert len(scene.walls) == len(original.walls)


def test_api_cad(variants):
    client = TestClient(app)
    r = client.post("/api/recognize", files={"file": ("plan.dxf", variants["zh_layers"], "application/dxf")})
    assert r.status_code == 200, r.text
    body = r.json()
    roles = {l["name"]: l["role"] for l in body["cad"]["layers"]}
    assert roles["牆"] == "wall" and roles["門"] == "door" and roles["窗"] == "window"
    r = client.post("/api/recognize", files={"file": ("plan.dxf", variants["zh_layers"], "application/dxf")},
                    data={"layers": '{"牆": "ignore"}'})
    assert r.status_code == 422


def test_api_export(original):
    client = TestClient(app)
    r = client.post("/api/export/dxf", json=original.model_dump())
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/dxf")
    doc = ezdxf.read(io.StringIO(r.content.decode("utf-8")))
    assert len(doc.modelspace()) > 50


def test_cad_samples():
    """網頁上的 CAD 範例要能直接用。"""
    client = TestClient(app)
    names = [n for n in client.get("/api/samples").json() if n.endswith(".dxf")]
    assert names
    for n in names:
        r = client.post("/api/recognize", data={"sample": n})
        assert r.status_code == 200, (n, r.text)
        scene = r.json()["scene"]
        assert len(scene["walls"]) >= 5 and len(scene["rooms"]) >= 4


def test_public_sample():
    """公開範例檔(dwgvieweronline.com,可任意使用):表頭單位寫錯、舊格式、家具是散線、門畫在沒斷開的牆上。"""
    data = (Path(__file__).parent.parent / "samples" / "cad" / "public_apartment.dxf").read_bytes()
    r = build_scene_from_cad(data, "public_apartment.dxf", with_background=False)
    s = r.scene
    assert any("不合理" in line for line in r.log)  # 有發現單位設定錯誤
    xs = [c for w in s.walls for c in (w.a[0], w.b[0])]
    assert max(xs) - min(xs) == pytest.approx(12000, abs=400)  # 外牆中心線約 12 m
    assert sorted(r.name for r in s.rooms) == ["BEDROOM 1", "BEDROOM 2", "KITCHEN", "LIVING"]
    assert Counter(o.kind for o in s.openings)["window"] == 4
    assert Counter(o.kind for o in s.openings)["door"] >= 2
    assert Counter(f.type for f in s.furniture) == Counter({"bed": 1, "table": 1, "cabinet": 1, "sofa": 1})
