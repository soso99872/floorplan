"""平面圖 → 3D 空間的 API 服務。

開發: cd backend && ../.venv/Scripts/python -m uvicorn app:app --reload --port 8000
前端開發伺服器 (Vite) 會把 /api 轉到這裡;正式環境由這個服務直接提供 frontend/dist。
"""
import json
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from floorplan import recognize as rz
from floorplan.build import DEFAULT_WALL_HEIGHT, build_scene, data_url
from floorplan.cad_import import build_scene_from_cad
from floorplan.dxf_export import export_dxf
from floorplan.scene import Scene

ROOT = Path(__file__).parent
SAMPLE_DIRS = [ROOT / "samples" / "images", ROOT / "samples" / "cad"]
DIST = ROOT.parent / "frontend" / "dist"
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
CAD_TYPES = {".dxf", ".dwg"}
MAX_UPLOAD = 20 * 1024 * 1024

app = FastAPI(title="Floorplan to 3D")


def sample_files():
    return {p.name: p for d in SAMPLE_DIRS if d.is_dir() for p in d.iterdir()
            if p.suffix.lower() in IMAGE_TYPES | CAD_TYPES}


@app.get("/api/samples")
def samples():
    return sorted(sample_files())


@app.post("/api/recognize")
async def recognize(
    file: UploadFile = File(None),
    sample: str = Form(None),
    width: float = Form(None, gt=0),  # 外牆總寬 mm;不給就用牆厚估比例尺
    height: float = Form(DEFAULT_WALL_HEIGHT, gt=0),
    layers: str = Form(None),  # CAD 圖層對應 JSON {"圖層名": "wall" | "door" | ...},蓋過自動判斷
):
    """上傳平面圖圖片或 AutoCAD 檔(DXF / DWG),或指定範例名稱。
    回傳 Scene JSON、辨識疊圖、過程紀錄;CAD 檔另外回傳圖層清單。"""
    if file is not None and file.filename:
        name = file.filename
        if Path(name).suffix.lower() not in IMAGE_TYPES | CAD_TYPES:
            raise HTTPException(415, "只支援 PNG / JPG / WEBP / BMP 圖片,或 AutoCAD 的 DXF / DWG 檔")
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "檔案超過 20 MB")
        src = data
    elif sample:
        path = sample_files().get(Path(sample).name)  # 只取檔名,不讓路徑跳出範例資料夾
        if path is None:
            raise HTTPException(404, "找不到這個範例")
        name, src = path.name, path
    else:
        raise HTTPException(400, "請上傳平面圖圖片或 DXF / DWG 檔")

    try:
        roles = json.loads(layers) if layers else None
        if roles is not None and not isinstance(roles, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "圖層對應格式錯誤")

    try:
        # 辨識是 CPU 密集的同步運算,丟到執行緒池避免卡住其他請求
        if Path(name).suffix.lower() in CAD_TYPES:
            data = src.read_bytes() if isinstance(src, Path) else src
            result = await run_in_threadpool(build_scene_from_cad, data, name, height, roles)
        else:
            result = await run_in_threadpool(build_scene, src, width, height)
    except rz.PlanError as e:
        raise HTTPException(422, str(e))
    return {"scene": result.scene.model_dump(), "overlay": data_url(result.overlay_png), "log": result.log,
            "cad": result.cad}


@app.post("/api/export/dxf")
def export(scene: Scene):
    """Scene JSON → AutoCAD DXF 平面圖。"""
    return Response(export_dxf(scene), media_type="application/dxf",
                    headers={"Content-Disposition": 'attachment; filename="floorplan.dxf"'})


if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")
