"""2D 圖 → 3D 預覽的本機網頁工具。
支援:機械三視圖 DXF(dxf2solid),以及建築平面圖圖片(plan2model)。

啟動: .venv\\Scripts\\python server.py   然後瀏覽器開 http://127.0.0.1:5000
只聽 127.0.0.1,不會對外開放。
"""
import threading
import uuid
import webbrowser
from pathlib import Path

import cadquery as cq
from flask import Flask, abort, jsonify, request, send_from_directory

import dxf2solid
import plan2model

ROOT = Path(__file__).parent
SAMPLES = ROOT / "samples"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
WORK = ROOT / "out" / "web"
WORK.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
occ_lock = threading.Lock()  # OpenCascade 不保證執行緒安全,一次只轉一張


def sample_edge(edge):
    n = 2 if edge.geomType() == "LINE" else 48
    return [list(edge.positionAt(i / (n - 1)).toTuple()) for i in range(n)]


def mesh_of(solid, tol=0.02):
    verts, tris = solid.tessellate(tol, 0.15)
    return {
        "positions": [c for v in verts for c in v.toTuple()],
        "indices": [i for t in tris for i in t],
    }


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/samples")
def samples():
    names = sorted(p.name for p in SAMPLES.glob("*.dxf"))
    names += sorted(f"images/{p.name}" for p in (SAMPLES / "images").glob("*") if p.suffix.lower() in IMAGE_EXTS)
    return jsonify(names)


def float_arg(name, default):
    try:
        v = float(request.form.get(name) or default)
    except ValueError:
        raise plan2model.PlanError(f"{name} 不是數字")
    if v <= 0:
        raise plan2model.PlanError(f"{name} 必須大於 0")
    return v


def convert_plan(src, name, job, lines):
    width = float_arg("width", 12000)
    height = float_arg("height", 3000)
    r = plan2model.convert_image(src, width, height, log=lines.append)
    solid = r["solid"]
    step, stl = export(plan2model.with_furniture(r), job)
    bb = solid.BoundingBox()
    return {
        "kind": "plan",
        "name": name,
        "ok": True,
        "size": (bb.xlen, bb.ylen, bb.zlen),
        "openings": {k: sum(o["kind"] == k for o in r["openings"]) for k in ("window", "door")},
        "thickness": r["thickness_mm"],
        "log": lines,
        "mesh": mesh_of(solid, 2.0),
        "edges": [sample_edge(e) for e in dxf2solid.real_edges(solid)],
        "floor": {"image": plan2model.png_b64(r["image"]), "size": r["image_size_mm"]},
        "furniture": [f["placement"] for f in r["furniture"]],
        "fittings": r["fittings"],
        "overlay": plan2model.png_b64(r["overlay"]),
        "downloads": downloads(step, stl, name),
    }


def export(solid, job):
    step, stl = WORK / f"{job}.step", WORK / f"{job}.stl"
    cq.exporters.export(solid, str(step))
    cq.exporters.export(solid, str(stl))
    return step, stl


def downloads(step, stl, name):
    return {"step": f"/download/{step.name}?as={name}.step", "stl": f"/download/{stl.name}?as={name}.stl"}


@app.post("/api/convert")
def convert():
    job = uuid.uuid4().hex[:8]
    if "file" in request.files and request.files["file"].filename:
        f = request.files["file"]
        name = Path(f.filename).stem
        src = WORK / f"{job}{Path(f.filename).suffix.lower()}"
        f.save(src)
    elif request.form.get("sample"):
        rel = Path(request.form["sample"])
        src = SAMPLES / (rel.name if rel.parent.name != "images" else Path("images") / rel.name)  # 不讓路徑跳出 samples/
        if not src.exists():
            abort(404)
        name = src.stem
    else:
        return jsonify(error="沒有收到 DXF 檔"), 400

    lines = []
    if src.suffix.lower() in IMAGE_EXTS:
        try:
            with occ_lock:
                return jsonify(convert_plan(src, name, job, lines))
        except plan2model.PlanError as e:
            return jsonify(error=str(e), log=lines), 422
        except Exception as e:
            return jsonify(error=f"轉換失敗:{type(e).__name__}: {e}", log=lines), 500

    angle = request.form.get("angle") or None
    try:
        with occ_lock:
            r = dxf2solid.convert(src, angle if angle in ("first", "third") else None, log=lines.append)
            solid = r["solid"]
            step, stl = export(solid, job)
            payload = {
                "kind": "views",
                "name": name,
                "ok": r["ok"],
                "angle": r["angle"],
                "size": r["size"],
                "volume": r["volume"],
                "errs": {v: {"area": a, "extra": x} for v, (a, x) in r["errs"].items()},
                "log": lines,
                "mesh": mesh_of(solid),
                "edges": [sample_edge(e) for e in dxf2solid.real_edges(solid)],
                "drawing": {
                    v: [{"pts": [p[:2] for p in sample_edge(e)], "hidden": h} for e, h in items]
                    for v, items in r["drawing"].items()
                },
                "downloads": downloads(step, stl, name),
            }
    except dxf2solid.ConversionError as e:
        return jsonify(error=str(e), log=lines), 422
    except Exception as e:  # DXF 格式錯誤、幾何運算失敗等
        return jsonify(error=f"轉換失敗:{type(e).__name__}: {e}", log=lines), 500
    return jsonify(payload)


@app.get("/download/<fname>")
def download(fname):
    return send_from_directory(WORK, Path(fname).name, as_attachment=True,
                               download_name=request.args.get("as") or fname)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    print(f"開啟 {url}  (Ctrl+C 結束)")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=args.port, threaded=True)
