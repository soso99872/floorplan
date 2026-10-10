// 給客戶的報告:A4 版面的網頁,開新視窗後叫出列印對話框,選「另存為 PDF」就是 PDF。
// 用瀏覽器列印而不是在伺服器產生 PDF:中文字型、圖片品質都交給瀏覽器,不用另外裝字型。
import type { Scene } from '../scene/types'
import { floorCost } from '../scene/materials'
import { PING_M2, openingRows, roomRows } from './tables'

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export interface ReportImages { perspective: string; plan: string }

export function reportHtml(scene: Scene, title: string, images: ReportImages): string {
  const rooms = roomRows(scene)
  const total = rooms.reduce((s, r) => s + r.area, 0)
  const openings = openingRows(scene)
  const cost = floorCost(scene)
  const date = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })
  const xs = scene.walls.flatMap((w) => [w.a[0], w.b[0]])
  const ys = scene.walls.flatMap((w) => [w.a[1], w.b[1]])
  const t = Math.max(0, ...scene.walls.map((w) => w.thickness))
  const size = xs.length ? `${((Math.max(...xs) - Math.min(...xs) + t) / 1000).toFixed(2)} × ${((Math.max(...ys) - Math.min(...ys) + t) / 1000).toFixed(2)} m` : '-'

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)} 空間規劃</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif; color: #1d2433; margin: 0; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1d2433; padding-bottom: 4mm; margin-bottom: 5mm; }
  h1 { font-size: 20pt; margin: 0; }
  h2 { font-size: 13pt; margin: 6mm 0 3mm; }
  .muted { color: #6b7385; font-size: 9.5pt; }
  img { width: 100%; display: block; border-radius: 2mm; }
  .facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 5mm 0; }
  .facts div { background: #f3f4f6; border-radius: 2mm; padding: 3mm; }
  .facts b { display: block; font-size: 14pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { padding: 1.6mm 2mm; border-bottom: 1px solid #dfe3ea; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-top: 2px solid #1d2433; }
  .plan { max-height: 150mm; object-fit: contain; }
  .note { margin-top: 6mm; font-size: 9pt; color: #6b7385; }
  @media screen { body { background: #e5e7eb; } .page { background: #fff; width: 210mm; min-height: 297mm; margin: 8mm auto; padding: 14mm; box-shadow: 0 2px 12px rgba(0,0,0,.15); } }
</style></head>
<body>
  <section class="page">
    <header><h1>${esc(title)}</h1><span class="muted">空間規劃 · ${date}</span></header>
    <img src="${images.perspective}" alt="3D 透視">
    <div class="facts">
      <div><span class="muted">室內面積</span><b>${total.toFixed(1)} m²</b></div>
      <div><span class="muted">約</span><b>${(total / PING_M2).toFixed(1)} 坪</b></div>
      <div><span class="muted">房間</span><b>${rooms.length} 間</b></div>
      <div><span class="muted">外牆尺寸</span><b>${size}</b></div>
    </div>
    <h2>平面配置</h2>
    <img class="plan" src="${images.plan}" alt="平面配置">
  </section>
  <section class="page">
    <h2>房間面積表</h2>
    <table>
      <thead><tr><th>房間</th><th class="n">面積 (m²)</th><th class="n">坪</th><th class="n">周長 (m)</th><th>地板</th></tr></thead>
      <tbody>${rooms.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${r.area.toFixed(2)}</td><td class="n">${r.ping.toFixed(2)}</td><td class="n">${r.perimeter.toFixed(2)}</td><td>${esc(r.floor)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>合計(室內)</td><td class="n">${total.toFixed(2)}</td><td class="n">${(total / PING_M2).toFixed(2)}</td><td></td><td></td></tr></tfoot>
    </table>
    <h2>地板材料估算(含 ${Math.round(cost.waste * 100)}% 損耗)</h2>
    <table>
      <thead><tr><th>材料</th><th class="n">面積 (m²)</th><th class="n">單價 (元/m²)</th><th class="n">小計 (元)</th></tr></thead>
      <tbody>${cost.rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${r.area.toFixed(2)}</td><td class="n">${r.price.toLocaleString()}</td><td class="n">${Math.round(r.cost).toLocaleString()}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>合計</td><td></td><td></td><td class="n">NT$ ${Math.round(cost.total).toLocaleString()}</td></tr></tfoot>
    </table>
    <h2>門窗表</h2>
    <table>
      <thead><tr><th>編號</th><th>種類</th><th class="n">寬 (mm)</th><th class="n">高 (mm)</th><th class="n">窗台高 (mm)</th><th>開法</th><th class="n">數量</th></tr></thead>
      <tbody>${openings.map((o) => `<tr><td>${o.code}</td><td>${o.kind}</td><td class="n">${o.width}</td><td class="n">${o.height}</td><td class="n">${o.kind === '窗' ? o.sill : ''}</td><td>${o.leaves}</td><td class="n">${o.count}</td></tr>`).join('')}</tbody>
    </table>
    <p class="note">面積為牆內淨面積(依牆中心線與牆厚計算),僅供規劃參考,實際以現場丈量為準。1 坪 = 3.3058 m²。</p>
  </section>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300))</script>
</body></html>`
}

/** 開新視窗顯示報告並叫出列印。要在點擊事件裡同步呼叫 window.open,不然會被擋快顯視窗 */
export async function openReport(scene: Scene, title: string, render: () => Promise<ReportImages>) {
  const win = window.open('', '_blank')
  if (!win) throw new Error('瀏覽器擋住了新視窗,請允許這個網站開啟快顯視窗')
  win.document.title = '正在產生報告…'
  win.document.body.textContent = '正在產生報告…'
  const html = reportHtml(scene, title, await render())
  win.location.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
}
