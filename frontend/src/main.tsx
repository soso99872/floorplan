import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ShareView from './ShareView.tsx'

// 分享連結 /s/<id> 顯示唯讀檢視;其他網址是編輯器
const shared = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {shared ? <ShareView id={shared[1]} /> : <App />}
  </StrictMode>,
)
