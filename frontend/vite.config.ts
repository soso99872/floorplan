import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 開發時把 /api 轉給後端 FastAPI(backend/app.py,預設 port 8000)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
