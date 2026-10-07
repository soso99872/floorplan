@echo off
chcp 65001 >nul
rem 啟動「平面圖 -> 3D 空間」服務:後端 API + 已建置的前端,瀏覽器開 http://127.0.0.1:8000
cd /d "%~dp0backend"
set PYTHONIOENCODING=utf-8
if not exist "..\frontend\dist\index.html" (
  echo 前端還沒建置,請先執行: cd frontend 然後 npm install 再 npm run build
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8000"
..\.venv\Scripts\python -m uvicorn app:app --port 8000
pause
