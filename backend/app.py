"""平面圖 → 3D 空間的 API 服務。

開發: cd backend && ../.venv/Scripts/python -m uvicorn app:app --reload --port 8000
前端開發伺服器 (Vite) 會把 /api 轉到這裡;正式環境由這個服務直接提供 frontend/dist。
"""
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from floorplan import recognize as rz
from floorplan.build import DEFAULT_WALL_HEIGHT, build_scene, data_url

ROOT = Path(__file__).parent
SAMPLES = ROOT / "samples" / "images"
DIST = ROOT.parent / "frontend" / "dist"
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MAX_UPLOAD = 20 * 1024 * 1024

app = FastAPI(title="Floorplan to 3D")


@app.get("/api/samples")
def samples():
    return sorted(p.name for p in SAMPLES.iterdir() if p.suffix.lower() in IMAGE_TYPES)


@app.post("/api/recognize")
async def recognize(
    file: UploadFile = File(None),
    sample: str = Form(None),
    width: float = Form(None, gt=0),  # 外牆總寬 mm;不給就用牆厚估比例尺
    height: float = Form(DEFAULT_WALL_HEIGHT, gt=0),
):
    """上傳平面圖圖片(或指定範例名稱),回傳 Scene JSON、辨識疊圖與過程紀錄。"""
    if file is not None and file.filename:
        if Path(file.filename).suffix.lower() not in IMAGE_TYPES:
            raise HTTPException(415, "只支援 PNG / JPG / WEBP / BMP 圖片")
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "圖片超過 20 MB")
        src = data
    elif sample:
        path = SAMPLES / Path(sample).name  # 只取檔名,不讓路徑跳出範例資料夾
        if not path.is_file():
            raise HTTPException(404, "找不到這個範例")
        src = path
    else:
        raise HTTPException(400, "請上傳平面圖圖片")

    try:
        # 辨識是 CPU 密集的同步運算,丟到執行緒池避免卡住其他請求
        result = await run_in_threadpool(build_scene, src, width, height)
    except rz.PlanError as e:
        raise HTTPException(422, str(e))
    return {"scene": result.scene.model_dump(), "overlay": data_url(result.overlay_png), "log": result.log}


if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")
