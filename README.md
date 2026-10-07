# 平面圖 → 3D 空間

給室內設計師的線上服務:上傳平面圖**圖片**或 **AutoCAD 檔(DXF / DWG)**,自動辨識牆、門窗、房間、家具,
在 2D / 3D 編輯器裡修正,再匯出 DXF(回 AutoCAD)或 GLB(給 SketchUp、Blender)。

產品化路線圖見 `C:\Users\user\.claude\plans\cuddly-toasting-cosmos.md`(階段 0~6)。

## 目錄

| 目錄 | 內容 |
|---|---|
| `backend/` | 辨識程式 + API(FastAPI)。`floorplan/recognize.py` 找牆、門窗、房間、家具;`floorplan/build.py` 組成 Scene JSON;`floorplan/cad_import.py` 讀 AutoCAD 檔;`floorplan/dxf_export.py` 輸出 DXF;`floorplan/scene.py` 是資料格式定義 |
| `frontend/` | 網頁(Vite + React + TypeScript + three.js)。`src/scene/` 是 Scene 型別與家具/門窗型錄,`src/three/` 是 3D 生成與檢視器,`src/editor/` 是 2D 編輯器(指令、房間重算、復原/重做、專案檔) |
| `eval/` | 準確度評估(CubiCasa5k 驗證集,僅內部使用,資料與報告不進 git) |
| `legacy/` | 第一版原型:機械三視圖 DXF → 3D(`dxf2solid.py`)與舊版平面圖工具,保留但不再開發 |

## 核心:Scene JSON

辨識產生它、3D 和匯出從它生成、之後的編輯器修改它。單位 mm,座標 y 向上。

- `walls`:牆段(中心線 a→b、厚度、高度),門窗所在的地方牆是連續的
- `openings`:掛在牆上的門 / 窗 / 開放通道(沿牆位置、寬度、窗台與門高、開門方向、單/雙開)
- `rooms`:房間多邊形、名稱(依家具推測)、面積、地板顏色
- `furniture`:型錄種類 + 位置 + 角度 + 尺寸 + 顏色;3D 模型由前端型錄依尺寸產生
- `meta`:比例尺、牆高、原圖(當地板貼圖)

定義在 `backend/floorplan/scene.py`(Pydantic)與 `frontend/src/scene/types.ts`,兩邊要保持一致。

## AutoCAD 檔

- **匯入**:圖層依名稱判斷角色(`WALL`/牆、`DOOR`/門、`WIN`/`GLAZ`/窗、`FURN`/家具、`DIM`/標註…),判斷錯了可以在網頁左邊改
  圖層對應再重新匯入。雙線牆會自動填實;門弧推出開門方向與鉸鏈;家具圖塊依名稱判斷種類(散線家具依大小猜);
  房間裡的文字當房名。檔案單位設定明顯錯誤時會改用猜測並在紀錄裡說明。
- **DWG**:需要另外安裝免費的 [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter)
  (預設安裝路徑會自動找到,或設定環境變數 `ODA_CONVERTER` 指到 `ODAFileConverter.exe`)。沒有安裝時請在 AutoCAD 另存為 DXF。
- **匯出**:AIA 圖層(`A-WALL`、`A-DOOR`、`A-GLAZ`、`A-FURN`、`A-AREA-IDEN`、`A-DIMS`),單位 mm,中文字用微軟正黑體。
- 範例檔在 `backend/samples/cad/`:`apartment_*.dxf` 是範例圖匯出後改成不同畫法的自產檔;`public_apartment.dxf`
  來自 dwgvieweronline.com 的公開範例(網站聲明可任意使用、不需標示來源)。

## 編輯器

2D 平面圖和 3D 可以並排;在 2D 上選取、拖曳牆(整道平移或拖端點)、門窗沿牆拖、家具移動旋轉,右側面板改尺寸與種類。
工具:畫牆、放門 / 窗 / 開放通道、新增家具、比例尺校正(點兩點輸入實際長度,整張圖等比縮放)。
牆改了房間會自動重新圍出(保留名稱與顏色)。Ctrl+Z / Ctrl+Y 復原重做;編輯內容自動存在瀏覽器,也可以存成 `.fp3d.json` 專案檔。

## 呈現(3D)

- 每個房間可以選地板材質(橡木、胡桃木、白橡、磁磚、小磁磚、大理石、水泥、地毯),預設依房名自動挑;
  紋理是程式畫出來的(`frontend/src/scene/materials.ts`),不需要外部圖檔
- 牆面顏色可調;陽光陰影、室內環境光;天花板可開關;「原圖」把地板換回原始平面圖
- 「走進去」:第一人稱瀏覽,W A S D / 方向鍵移動、滑鼠轉頭、Shift 走快,牆和家具會擋路,門和通道可以穿過,Esc 離開
- 「截圖」:目前視角輸出 3840 px 寬的 PNG,可以直接給客戶看

## 匯出(右上角「匯出」選單)

| 項目 | 給誰用 | 內容 |
|---|---|---|
| AutoCAD DXF | AutoCAD | 牆、門弧、三線窗、家具圖塊、房名面積;外牆四邊分段尺寸 + 總尺寸;圖面旁的房間面積表(m²、坪) |
| AutoCAD DWG | AutoCAD | 同 DXF(伺服器有安裝 ODA File Converter 才會出現) |
| SketchUp / OBJ | SketchUp 2021+、3ds Max、Revit | OBJ + MTL + 地板貼圖 PNG 的 zip;單位公尺、Y 朝上 |
| GLB | 網頁展示、Blender | 含顏色與地板貼圖 |
| 面積表 CSV | Excel | 房間面積(m²、坪、周長、地板材質)、門窗表(同尺寸合併、編號 D1/W1/P1) |
| 客戶報告 PDF | 客戶 | 3D 透視、平面配置、面積表、門窗表;開新視窗後在列印對話框選「另存為 PDF」 |
| 高解析截圖 | 簡報 | 目前視角、寬 3840 px |

## 分享給客戶

右上角「分享」→ 建立連結(`/s/<id>`),客戶打開是唯讀的 3D:旋轉、平面 / 正面視角、開門、天花板、走進去(電腦)、
存圖、房間面積表(m²、坪);手機也能看。改了設計按「用目前的編輯更新」,同一個連結就會更新;「停止分享」後連結失效。

沒有帳號系統:管理分享用的 token 只存在建立它的那台電腦的瀏覽器裡(伺服器只存雜湊),換電腦就不能更新或停止舊的連結。
分享的場景存在 `DATA_DIR/shares/<id>.json`。上傳的圖檔、CAD 檔只在辨識時放在記憶體,不會寫到磁碟。

注意:`start_preview.bat` 只開在本機(127.0.0.1),連結只有這台電腦打得開;要給客戶用,請部署到對外的主機(見下)。

## 部署(Docker)

```
docker compose up -d          # http://localhost:8000,分享資料存在 floorplan-data volume
```
映像包含前端建置與後端 API(`Dockerfile`)。對外服務時請放在提供 HTTPS 的反向代理或平台後面
(Render / Fly.io / Railway 都可以直接用這個 Dockerfile;資料夾 `/data` 要掛永久磁碟)。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `DATA_DIR` | `backend/data`(Docker 是 `/data`) | 分享連結的存放位置 |
| `RECOGNIZE_CONCURRENCY` | `2` | 同時進行的辨識數量,其他請求排隊 |
| `ODA_CONVERTER` | 自動尋找 | ODA File Converter 路徑(讀寫 DWG);Docker 映像裡沒有附 |

健康檢查:`GET /api/health`。

## 開發

第一次設定:
```
python -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements.txt
cd frontend && npm install
```

開發時開兩個終端機:
```
cd backend && ..\.venv\Scripts\python -m uvicorn app:app --reload --port 8000
cd frontend && npm run dev          # http://localhost:5173,/api 自動轉到 8000
```

只想使用:`cd frontend && npm run build` 一次,之後雙擊 `start_preview.bat`(http://127.0.0.1:8000)。

## 測試與評估

```
cd backend && ..\.venv\Scripts\python -m pytest          # 辨識回歸測試 + API 測試
cd frontend && npx tsc -b                                 # 型別檢查
.venv\Scripts\python eval\run_eval.py --n 40              # 準確度報告 → eval\reports\report.html
```
評估資料第一次要先下載(約 300 MB,CubiCasa5k 驗證集,CC BY-NC 4.0,只做內部評估):
```
curl -L -o eval\data\cubicasa5k_valid.parquet https://huggingface.co/datasets/phungpx/cubicassa5k-coco/resolve/main/data/valid-00000-of-00001.parquet
```

## 辨識的假設與限制(目前版本)

- 圖片:牆是深色粗線;比例尺用「外牆總寬」換算,不給就用「牆厚 ≈ 150 mm」估(較不準,可用比例尺工具校正)
- 外牆缺口 = 窗(缺口裡沒畫玻璃線的是大門);內牆缺口 = 門;寬於 1.8 m 是開放通道
- 家具依顏色與大小判斷種類,高度套常見尺寸;只畫線稿的衛浴設備辨識不到
- 只用一種配色風格的圖調過規則;其他畫法的準確度見評估報告
- AutoCAD:目前只處理水平 / 垂直的牆;斜牆、弧形牆會近似成直牆。模型空間有多張圖時只取牆最多的那張
