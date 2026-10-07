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
