// 房間面積表、門窗表:CSV 匯出與報告共用同一份資料。
import { FLOOR_MATERIALS, floorMaterialId } from '../scene/materials'
import type { Scene } from '../scene/types'
import { polygonArea, wallFrame } from '../editor/geometry'

export const PING_M2 = 400 / 121 // 1 坪 = 3.3058 m²

export interface RoomRow { name: string; area: number; ping: number; perimeter: number; floor: string }
export interface OpeningRow { code: string; kind: string; width: number; height: number; sill: number; leaves: string; count: number }

export function roomRows(scene: Scene): RoomRow[] {
  return scene.rooms.map((r) => {
    let per = 0
    for (let i = 0; i < r.polygon.length; i++) {
      const [x0, y0] = r.polygon[i], [x1, y1] = r.polygon[(i + 1) % r.polygon.length]
      per += Math.hypot(x1 - x0, y1 - y0)
    }
    const area = r.area || polygonArea(r.polygon) / 1e6
    return { name: r.name, area, ping: area / PING_M2, perimeter: per / 1000, floor: FLOOR_MATERIALS[floorMaterialId(r)].name }
  })
}

/** 門窗表:同種類、同尺寸的合併計數,編號 D1、D2…(門)、W1…(窗)、P1…(通道) */
export function openingRows(scene: Scene): OpeningRow[] {
  const groups = new Map<string, OpeningRow>()
  const kinds = { door: '門', window: '窗', passage: '開放通道' }
  for (const o of scene.openings) {
    if (!scene.walls.some((w) => w.id === o.wall && wallFrame(w).length > 0)) continue
    const width = Math.round(o.width / 10) * 10
    const height = Math.round((o.head - o.sill) / 10) * 10
    const leaves = o.kind === 'door' ? (o.leaves === 2 ? '雙開' : '單開') + (o.exterior ? '(大門)' : '') : ''
    const key = [o.kind, width, height, o.sill, leaves].join('/')
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { code: '', kind: kinds[o.kind], width, height, sill: o.sill, leaves, count: 1 })
  }
  const order = ['門', '窗', '開放通道']
  const rows = [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.width - a.width)
  const n: Record<string, number> = {}
  const prefix: Record<string, string> = { 門: 'D', 窗: 'W', 開放通道: 'P' }
  for (const r of rows) r.code = prefix[r.kind] + (n[r.kind] = (n[r.kind] ?? 0) + 1)
  return rows
}

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Excel 直接開的 CSV(UTF-8 加 BOM,中文才不會亂碼) */
export function tablesCsv(scene: Scene, title: string): Blob {
  const rooms = roomRows(scene)
  const total = rooms.reduce((s, r) => s + r.area, 0)
  const lines: (string | number)[][] = [
    [title],
    [],
    ['房間面積表'],
    ['房間', '面積 (m²)', '坪', '周長 (m)', '地板材質'],
    ...rooms.map((r) => [r.name, r.area.toFixed(2), r.ping.toFixed(2), r.perimeter.toFixed(2), r.floor]),
    ['合計(室內)', total.toFixed(2), (total / PING_M2).toFixed(2), '', ''],
    [],
    ['門窗表'],
    ['編號', '種類', '寬 (mm)', '高 (mm)', '窗台高 (mm)', '開法', '數量'],
    ...openingRows(scene).map((o) => [o.code, o.kind, o.width, o.height, o.kind === '窗' ? o.sill : '', o.leaves, o.count]),
  ]
  const text = lines.map((l) => l.map(csvCell).join(',')).join('\r\n')
  return new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })
}
