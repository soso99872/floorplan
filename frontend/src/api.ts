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
}

export async function recognize(input: RecognizeInput): Promise<RecognizeResponse> {
  const form = new FormData()
  if (input.file) form.append('file', input.file)
  if (input.sample) form.append('sample', input.sample)
  if (input.width) form.append('width', String(input.width))
  form.append('height', String(input.height))
  if (input.layers) form.append('layers', JSON.stringify(input.layers))
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
