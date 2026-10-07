import type { LayerRole, RecognizeResponse, Scene } from './scene/types'

export async function listSamples(): Promise<string[]> {
  const r = await fetch('/api/samples')
  return r.ok ? r.json() : []
}

export interface RecognizeInput {
  file?: File
  sample?: string
  /** 外牆總寬 mm;不給的話後端用牆厚估比例尺 */
  width?: number
  height: number
  /** CAD 圖層對應,蓋過自動判斷 */
  layers?: Record<string, LayerRole>
  /** 圖片辨識方式 */
  engine?: Engine
}

export async function recognize(input: RecognizeInput): Promise<RecognizeResponse> {
  const form = new FormData()
  if (input.file) form.append('file', input.file)
  if (input.sample) form.append('sample', input.sample)
  if (input.width) form.append('width', String(input.width))
  form.append('height', String(input.height))
  if (input.layers) form.append('layers', JSON.stringify(input.layers))
  if (input.engine) form.append('engine', input.engine)
  const r = await fetch('/api/recognize', { method: 'POST', body: form })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) {
    // FastAPI 的錯誤格式:{detail: "訊息"} 或欄位驗證錯誤的陣列
    const detail = typeof body.detail === 'string' ? body.detail : '輸入的數值不正確'
    throw new Error(detail || `伺服器錯誤 (${r.status})`)
  }
  return body as RecognizeResponse
}

/** Scene → AutoCAD DXF */
export async function exportDxf(scene: Scene): Promise<Blob> {
  const r = await fetch('/api/export/dxf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scene),
  })
  if (!r.ok) throw new Error(`匯出 DXF 失敗 (${r.status})`)
  return r.blob()
}

/** Scene → AutoCAD DWG(伺服器要有 ODA File Converter) */
export async function exportDwg(scene: Scene): Promise<Blob> {
  const r = await fetch('/api/export/dwg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scene),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `匯出 DWG 失敗 (${r.status})`)
  return r.blob()
}

export type Engine = 'auto' | 'ml' | 'rules'

export async function getCapabilities(): Promise<{ dwg: boolean; ml: boolean }> {
  const r = await fetch('/api/capabilities').catch(() => null)
  return r?.ok ? r.json() : { dwg: false, ml: false }
}

// ---------- 分享連結 ----------

export interface SharedScene { name: string; scene: Scene; updated: number }

async function json<T>(r: Response, what: string): Promise<T> {
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `${what}失敗 (${r.status})`)
  return body as T
}

export async function createShare(name: string, scene: Scene): Promise<{ id: string; token: string }> {
  const r = await fetch('/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scene }) })
  return json(r, '建立分享')
}

export async function updateShare(id: string, token: string, name: string, scene: Scene): Promise<void> {
  const r = await fetch(`/api/shares/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token }, body: JSON.stringify({ name, scene }),
  })
  await json(r, '更新分享')
}

export async function deleteShare(id: string, token: string): Promise<void> {
  const r = await fetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-Share-Token': token } })
  if (!r.ok && r.status !== 404) await json(r, '停止分享')
}

export async function getShare(id: string): Promise<SharedScene> {
  return json(await fetch(`/api/shares/${encodeURIComponent(id)}`), '讀取分享')
}
