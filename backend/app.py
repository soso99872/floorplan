"""平面圖 → 3D 空間的 API 服務。

開發: cd backend && ../.venv/Scripts/python -m uvicorn app:app --reload --port 8000
前端開發伺服器 (Vite) 會把 /api 轉到這裡;正式環境由這個服務直接提供 frontend/dist。

環境變數:
  DATA_DIR                分享連結的存放位置(預設 backend/data)
  RECOGNIZE_CONCURRENCY   同時進行的辨識數量上限(預設 2),其他請求排隊
  ODA_CONVERTER           ODA File Converter 的路徑(讀寫 DWG 用)
隱私:上傳的圖檔、CAD 檔只在辨識時放在記憶體,不會寫到磁碟;只有使用者按「分享」的場景會存檔。
"""
import asyncio
import json
import os
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from floorplan import recognize as rz
from floorplan import ml
from floorplan.build import DEFAULT_WALL_HEIGHT, ENGINES, build_scene, data_url
from floorplan.cad_import import CadError, build_scene_from_cad, dxf_to_dwg, find_odafc
from floorplan.dxf_export import export_dxf
from floorplan.scene import Scene
from pydantic import BaseModel, Field
from shares import ShareForbidden, ShareNotFound, ShareStore

ROOT = Path(__file__).parent
SAMPLE_DIRS = [ROOT / "samples" / "images", ROOT / "samples" / "cad"]
DIST = ROOT.parent / "frontend" / "dist"
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
CAD_TYPES = {".dxf", ".dwg"}
MAX_UPLOAD = 20 * 1024 * 1024
MAX_SHARE = 30 * 1024 * 1024  # 分享的場景含原圖,可能好幾 MB

app = FastAPI(title="Floorplan to 3D")
shares = ShareStore(Path(os.environ.get("DATA_DIR", ROOT / "data")))
# 辨識很吃 CPU:限制同時進行的數量,其他請求排隊,避免多人同時上傳把伺服器拖垮
recognize_slots = asyncio.Semaphore(int(os.environ.get("RECOGNIZE_CONCURRENCY", "2")))


@app.middleware("http")
async def limit_body(request: Request, call_next):
    """擋掉過大的請求(還沒讀完內容就拒絕)。"""
    size = request.headers.get("content-length")
    limit = MAX_SHARE if request.url.path.startswith("/api/shares") else MAX_UPLOAD + 1024 * 1024
    if size and size.isdigit() and int(size) > limit:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": f"檔案太大(上限 {limit // 1024 // 1024} MB)"}, status_code=413)
    return await call_next(request)


def sample_files():
    return {p.name: p for d in SAMPLE_DIRS if d.is_dir() for p in d.iterdir()
            if p.suffix.lower() in IMAGE_TYPES | CAD_TYPES}


@app.get("/api/health")
def health():
    """給主機平台、Docker 的健康檢查用。"""
    return {"ok": True}


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
    engine: str = Form("auto"),  # 圖片辨識方式:auto / ml / rules
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
        async with recognize_slots:
            if Path(name).suffix.lower() in CAD_TYPES:
                data = src.read_bytes() if isinstance(src, Path) else src
                result = await run_in_threadpool(build_scene_from_cad, data, name, height, roles)
            else:
                if engine not in ENGINES:
                    raise HTTPException(400, "辨識方式只能是 auto、ml 或 rules")
                result = await run_in_threadpool(build_scene, src, width, height, True, engine)
    except rz.PlanError as e:
        raise HTTPException(422, str(e))
    return {"scene": result.scene.model_dump(), "overlay": data_url(result.overlay_png), "log": result.log,
            "cad": result.cad}


@app.get("/api/capabilities")
def capabilities():
    """這台伺服器能做什麼(前端依此顯示按鈕):dwg = 有沒有安裝 ODA File Converter。"""
    return {"dwg": find_odafc() is not None, "ml": ml.available()}


@app.post("/api/export/dwg")
async def export_dwg(scene: Scene):
    """Scene JSON → AutoCAD DWG(需要伺服器安裝 ODA File Converter)。"""
    try:
        data = await run_in_threadpool(dxf_to_dwg, export_dxf(scene))
    except CadError as e:
        raise HTTPException(503, str(e))
    return Response(data, media_type="application/acad",
                    headers={"Content-Disposition": 'attachment; filename="floorplan.dwg"'})


@app.post("/api/export/dxf")
def export(scene: Scene):
    """Scene JSON → AutoCAD DXF 平面圖。"""
    return Response(export_dxf(scene), media_type="application/dxf",
                    headers={"Content-Disposition": 'attachment; filename="floorplan.dxf"'})


# ---------- 分享連結 ----------

class ShareBody(BaseModel):
    name: str = Field(default="平面圖", max_length=100)
    scene: Scene


@app.post("/api/shares")
def create_share(body: ShareBody):
    """建立分享連結。回傳的 token 只會給這一次,用來更新或停止這個分享。"""
    share_id, token = shares.create(body.name, body.scene.model_dump())
    return {"id": share_id, "token": token}


@app.get("/api/shares/{share_id}")
def get_share(share_id: str):
    try:
        return shares.get(share_id)
    except ShareNotFound:
        raise HTTPException(404, "找不到這個分享,可能已經停止分享")


@app.put("/api/shares/{share_id}")
def update_share(share_id: str, body: ShareBody, x_share_token: str = Header(None)):
    try:
        shares.update(share_id, x_share_token, body.name, body.scene.model_dump())
    except ShareNotFound:
        raise HTTPException(404, "找不到這個分享,可能已經停止分享")
    except ShareForbidden:
        raise HTTPException(403, "沒有權限更新這個分享")
    return {"id": share_id}


@app.delete("/api/shares/{share_id}", status_code=204)
def delete_share(share_id: str, x_share_token: str = Header(None)):
    try:
        shares.delete(share_id, x_share_token)
    except ShareNotFound:
        raise HTTPException(404, "找不到這個分享")
    except ShareForbidden:
        raise HTTPException(403, "沒有權限停止這個分享")
    return Response(status_code=204)


if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")

    @app.get("/s/{share_id}")
    def shared_page(share_id: str):
        """分享連結:同一個前端,看到網址是 /s/... 就顯示唯讀的檢視畫面。"""
        return FileResponse(DIST / "index.html")
