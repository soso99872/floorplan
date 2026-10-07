// 牆改過之後重新圍出房間:外框扣掉所有牆的聯集,沒碰到外框的每一塊就是一個房間。
// 新房間跟舊房間重疊最多的,沿用舊房間的 id、名稱、地板顏色。
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping'
import type { Point, Room, Scene } from '../scene/types'
import { newId, polygonArea, round1, strip, wallFrame } from './geometry'

const MIN_ROOM_M2 = 0.5
const DEFAULT_FLOOR = '#e8dcc6'

const ring = (pts: Point[]): [number, number][] => [...pts, pts[0]].map(([x, y]) => [x, y])

function unusedName(rooms: Room[]) {
  const names = new Set(rooms.map((r) => r.name))
  let n = 1
  while (names.has(`房間 ${n}`)) n++
  return `房間 ${n}`
}

export function computeRooms(scene: Scene): Room[] {
  if (scene.walls.length < 3) return []
  const strips: Polygon[] = scene.walls.map((w) => [ring(strip(w, 0, wallFrame(w).length, w.thickness))])
  const solid = polygonClipping.union(strips[0], ...strips.slice(1))
  const xs = scene.walls.flatMap((w) => [w.a[0], w.b[0]])
  const ys = scene.walls.flatMap((w) => [w.a[1], w.b[1]])
  const m = 1000
  const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m
  const outer: Polygon = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]
  const free: MultiPolygon = polygonClipping.difference(outer, solid)

  const pieces: { poly: Point[]; area: number; mp: MultiPolygon }[] = []
  for (const p of free) {
    const pts = p[0].slice(0, -1) as Point[]
    const touchesOuter = pts.some(([x, y]) => x <= x0 + 1 || x >= x1 - 1 || y <= y0 + 1 || y >= y1 - 1)
    if (touchesOuter) continue
    const area = (polygonArea(pts) - p.slice(1).reduce((s, h) => s + polygonArea(h.slice(0, -1) as Point[]), 0)) / 1e6
    if (area < MIN_ROOM_M2) continue
    pieces.push({ poly: pts.map(([x, y]) => [round1(x), round1(y)]), area, mp: [p] })
  }

  // 依重疊面積把舊房間的名稱配給新房間(大的先配)
  const old = scene.rooms.map((r) => ({ room: r, mp: [[ring(r.polygon)]] as MultiPolygon, used: false }))
  pieces.sort((a, b) => b.area - a.area)
  const rooms: Room[] = []
  for (const piece of pieces) {
    let best: (typeof old)[number] | null = null, bestArea = 0
    for (const o of old) {
      if (o.used) continue
      let a = 0
      try {
        a = polygonClipping.intersection(piece.mp, o.mp).reduce((s, p) => s + polygonArea(p[0].slice(0, -1) as Point[]), 0)
      } catch { /* 退化的多邊形就當作沒重疊 */ }
      if (a > bestArea) { best = o; bestArea = a }
    }
    const matched = best && bestArea / 1e6 > 0.3 * Math.min(piece.area, best.room.area || piece.area)
    if (matched && best) best.used = true
    const id = matched && best ? best.room.id : newId('r', [...scene.rooms, ...rooms])
    rooms.push({
      id,
      name: matched && best ? best.room.name : unusedName([...scene.rooms, ...rooms]),
      polygon: piece.poly,
      area: Math.round(piece.area * 100) / 100,
      floor_color: matched && best ? best.room.floor_color : DEFAULT_FLOOR,
    })
  }
  return rooms
}
