# 圖片辨識的機器學習模型

把平面圖圖片的每個像素分成 **背景 / 牆 / 門 / 窗**,取代「深色粗線就是牆」的規則。
沒有人工標註的真實資料,所以訓練資料是**自己產生的**:拿真實住宅格局,用程式以各種畫法畫成圖,
標註跟著幾何自動產生。

```
ResPlan 格局(向量)──► synth/render.py 隨機畫法 ──► 圖 + 逐像素標註 ──► train/ U-Net ──► ONNX ──► backend/floorplan/ml.py
```

## 資料來源與授權

| 資料 | 授權 | 用途 |
|---|---|---|
| [ResPlan](https://github.com/m-agour/ResPlan):17,000 份住宅格局(牆、門、窗、房間的向量) | CC BY 4.0 | 訓練用的格局;**使用時須標示來源**(本檔與網頁「關於」) |
| 渲染器產生的圖與標註 | 自有 | 訓練資料 |
| CubiCasa5k 驗證集 | CC BY-NC 4.0 | 只做評估(`eval/`),不拿來訓練 |

> 本專案使用 ResPlan 資料集(m-agour/ResPlan,CC BY 4.0)的格局幾何產生合成訓練資料。
> 原始資料未經修改地使用其牆、門、窗、房間多邊形;渲染出的圖片與標註為本專案自行產生。

## 畫法(`synth/render.py`)

每張圖隨機組合:牆(實心黑 / 灰 / 有色、雙線空心、斜線、交叉線、灰填、外牆加粗)、
門(單開弧、雙開弧、推拉、門片、只有缺口、門框)、窗(三線、雙線、填色、外框)、
地板(色塊、木紋、磁磚)、家具符號(線稿 / 色塊)、中英文房名與面積、尺寸線、軸線、標題、浮水印、
畫質(手繪扭曲、模糊、掃描雜點、JPEG、低解析度、輕微旋轉)。牆厚 3~24 px,讓模型不挑比例。

## 怎麼跑

```
cd ml
py -3.8 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
# 下載 ResPlan.zip 到 data/resplan/ 並解壓(得到 ResPlan.pkl)
.venv\Scripts\python -m synth.generate --out data/synth --workers 14          # 約 3.7 萬塊 512×512,約 10 分鐘
.venv\Scripts\python -m train.train --name v1 --epochs 8 --steps 1000 --size 320   # CPU 約 6 小時,可中斷續跑
.venv\Scripts\python -m train.export --run runs/v1                             # → backend/models/floorplan-seg.onnx
cd .. && .venv\Scripts\python eval\run_eval.py --engine ml                        # 真實圖評估,報告在 eval/reports/ml/
```
`data/`、`runs/`、`.venv/` 不進 git;只有匯出的 ONNX 模型放進 `backend/models/`。

## 版本比較(CubiCasa5k 40 張,同一套後段處理)

| 版本 | 牆 IoU | 牆 P / R | 門窗 P / R | 採用 |
|---|---|---|---|---|
| v1 | 57.1% | 82.5% / 92.3% | 51.2% / 81.0% | ✓(目前的 backend/models) |
| v2 | 52.1%(舊後段) | | | |
| v3(加粗牆、接續 v1 微調) | 55.5% | 81.3% / 90.9% | 48.0% / 86.3% | |

v3 的門窗召回率較高,但牆與門窗精確度都略低,所以維持 v1。
