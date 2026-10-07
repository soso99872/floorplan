# 平面圖 → 3D 空間:前端建置 + 後端 API 打包成一個映像
#   docker build -t floorplan-3d .
#   docker run -p 8000:8000 -v floorplan-data:/data floorplan-3d
# 或用 docker compose up -d(見 docker-compose.yml)

# ---- 前端 ----
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 後端 ----
FROM python:3.8-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    DATA_DIR=/data \
    RECOGNIZE_CONCURRENCY=2
# OpenCV(headless)需要 libglib
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist /app/frontend/dist
RUN useradd --create-home app && mkdir -p /data && chown app /data
USER app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
