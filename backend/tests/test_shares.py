"""分享連結 API:建立、讀取、用 token 更新與停止;沒有 token 或 token 錯誤不能改。"""
import pytest
from fastapi.testclient import TestClient

import app as app_module
from shares import ShareStore

SCENE = {
    "meta": {"mm_per_px": 10, "wall_height": 3000, "wall_thickness": 120},
    "walls": [{"id": "w1", "a": [0, 0], "b": [4000, 0], "thickness": 120, "height": 3000}],
}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "shares", ShareStore(tmp_path))
    return TestClient(app_module.app)


def test_share_lifecycle(client, tmp_path):
    r = client.post("/api/shares", json={"name": "王先生住宅", "scene": SCENE})
    assert r.status_code == 200
    share_id, token = r.json()["id"], r.json()["token"]
    assert len(share_id) >= 12 and len(token) >= 24
    stored = (tmp_path / "shares" / f"{share_id}.json").read_text(encoding="utf-8")
    assert token not in stored  # 只存雜湊

    got = client.get(f"/api/shares/{share_id}").json()
    assert got["name"] == "王先生住宅" and got["scene"]["walls"][0]["b"] == [4000, 0]

    scene2 = {**SCENE, "walls": [{**SCENE["walls"][0], "b": [5000, 0]}]}
    assert client.put(f"/api/shares/{share_id}", json={"name": "改", "scene": scene2}).status_code == 403
    assert client.put(f"/api/shares/{share_id}", json={"name": "改", "scene": scene2},
                      headers={"X-Share-Token": "wrong-token-xxxxxxxxxxxxxx"}).status_code == 403
    assert client.put(f"/api/shares/{share_id}", json={"name": "改", "scene": scene2},
                      headers={"X-Share-Token": token}).status_code == 200
    assert client.get(f"/api/shares/{share_id}").json()["scene"]["walls"][0]["b"] == [5000, 0]

    assert client.delete(f"/api/shares/{share_id}").status_code == 403
    assert client.delete(f"/api/shares/{share_id}", headers={"X-Share-Token": token}).status_code == 204
    assert client.get(f"/api/shares/{share_id}").status_code == 404


def test_bad_ids(client):
    for bad in ["nope", "..%2F..%2Fapp", "a" * 60]:
        assert client.get(f"/api/shares/{bad}").status_code == 404


def test_invalid_scene_rejected(client):
    r = client.post("/api/shares", json={"name": "x", "scene": {"walls": "not a list"}})
    assert r.status_code == 422


def test_too_large(client):
    r = client.post("/api/shares", content=b"x", headers={"Content-Length": str(40 * 1024 * 1024), "Content-Type": "application/json"})
    assert r.status_code == 413


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}
