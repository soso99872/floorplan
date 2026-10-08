"""辨識回歸測試:範例平面圖的辨識結果不能退步。

數字是目前版本在 samples/images/floorplan.png 上的結果;改辨識規則後如果變好,
請連同這裡的數字一起更新,並在 commit 說明裡寫清楚哪裡變好。
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import app
from floorplan.build import build_scene
from floorplan.scene import Scene

SAMPLE = Path(__file__).parent.parent / "samples" / "images" / "floorplan.png"


@pytest.fixture(scope="module")
def result():
    return build_scene(SAMPLE, 12000, 3000)


def test_scale(result):
    xs = [p[0] for w in result.scene.walls for p in (w.a, w.b)]
    assert max(xs) - min(xs) == pytest.approx(12000, abs=150)  # 外牆總寬 = 輸入值(差一個牆厚以內)


def test_walls(result):
    walls = result.scene.walls
    assert 12 <= len(walls) <= 16
    for w in walls:
        assert 100 < w.thickness < 160  # 牆厚統一在約 124 mm
        assert w.a[0] == w.b[0] or w.a[1] == w.b[1]  # 都是水平或垂直的直牆


def test_openings(result):
    ops = result.scene.openings
    kinds = [o.kind for o in ops]
    assert kinds.count("window") == 10
    assert kinds.count("door") + kinds.count("passage") == 10
    assert sum(o.exterior and o.kind == "door" for o in ops) == 1  # 一扇大門
    wall_ids = {w.id for w in result.scene.walls}
    walls = {w.id: w for w in result.scene.walls}
    for o in ops:
        assert o.wall in wall_ids
        w = walls[o.wall]
        length = abs(w.b[0] - w.a[0]) + abs(w.b[1] - w.a[1])
        assert o.width / 2 <= o.offset + 1 and o.offset - 1 <= length - o.width / 2  # 開口整個落在牆上


def test_rooms(result):
    rooms = result.scene.rooms
    assert len(rooms) >= 8
    names = [r.name for r in rooms]
    for expected in ("客廳", "廚房", "臥室", "臥室 2"):
        assert expected in names
    assert sum(r.area for r in rooms) == pytest.approx(130, abs=20)  # 12 m x 12 m 扣掉牆


def test_furniture(result):
    types = [f.type for f in result.scene.furniture]
    assert len(types) >= 25
    assert types.count("bed") == 2
    assert types.count("sofa") >= 4
    assert "table" in types and "wardrobe" in types and "rug" in types


def test_scene_roundtrip(result):
    data = result.scene.model_dump()
    assert Scene.model_validate(data) == result.scene


def test_api_recognize_sample():
    client = TestClient(app)
    assert "floorplan.png" in client.get("/api/samples").json()
    r = client.post("/api/recognize", data={"sample": "floorplan.png", "width": "12000"})
    assert r.status_code == 200
    body = r.json()
    Scene.model_validate(body["scene"])
    assert body["overlay"].startswith("data:image/png;base64,")


def test_auto_scale_without_width():
    r = build_scene(SAMPLE, None, 3000)
    xs = [p[0] for w in r.scene.walls for p in (w.a, w.b)]
    assert 8000 < max(xs) - min(xs) < 20000  # 牆厚 9 px 當 150 mm 估,外牆約 14 m(實際 12 m 上下),量級對就好
    assert any("沒有給尺寸" in line for line in r.log)


def test_api_rejects_bad_input():
    client = TestClient(app)
    assert client.post("/api/recognize", data={"sample": "../app.py"}).status_code == 404
    assert client.post("/api/recognize", files={"file": ("x.txt", b"hello")}).status_code == 415
    assert client.post("/api/recognize", files={"file": ("x.png", b"not an image")}).status_code == 422
    assert client.post("/api/recognize", data={"sample": "floorplan.png", "width": "-5"}).status_code == 422


@pytest.mark.skipif(not __import__("floorplan.ml", fromlist=["available"]).available(), reason="沒有 ML 模型")
def test_ml_engine():
    """機器學習辨識:範例圖也要得到合理的牆、門窗、房間。"""
    r = build_scene(SAMPLE, 12000, 3000, with_background=False, engine="ml")
    s = r.scene
    assert any("機器學習" in line for line in r.log)
    assert 8 <= len(s.walls) <= 30
    kinds = [o.kind for o in s.openings]
    assert kinds.count("window") >= 6 and kinds.count("door") + kinds.count("passage") >= 6
    assert len(s.rooms) >= 6
