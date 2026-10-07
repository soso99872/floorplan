// 編輯指令:一律是「舊 Scene → 新 Scene」的純函式,不改動傳進來的物件(復原/重做靠保留舊的 Scene)。
import type { Furniture, Opening, Point, Room, Scene, Wall } from '../scene/types'
import {
  add, dist, distToWall, mul, newId, openingCenter, project, round1, roundPt, wallFrame,
} from './geometry'
import { computeRooms } from './rooms'

export type SelKind = 'wall' | 'opening' | 'furniture' | 'room'
export interface Sel { kind: SelKind; id: string }

/** 新增家具的預設尺寸(寬 × 深 mm)與顏色;床的寬是床頭那一邊 */
export const FURNITURE_DEFAULTS: Record<string, { width: number; depth: number; color: string }> = {
  bed: { width: 1500, depth: 2000, color: '#d9cdb8' },
  sofa: { width: 2000, depth: 900, color: '#8d8f96' },
  table: { width: 1600, depth: 900, color: '#a47b54' },
  low_table: { width: 1000, depth: 500, color: '#9c7b5c' },
  wardrobe: { width: 1800, depth: 600, color: '#c9b79c' },
  cabinet: { width: 1500, depth: 450, color: '#b9a58a' },
  counter: { width: 2400, depth: 600, color: '#d6d3cc' },
  fixture: { width: 700, depth: 700, color: '#eef1f2' },
  lamp: { width: 400, depth: 400, color: '#e9dcc0' },
  rug: { width: 2000, depth: 1400, color: '#b8a68f' },
  other: { width: 800, depth: 800, color: '#b0a89c' },
}
export const OPENING_DEFAULTS = {
  door: { width: 900, sill: 0, head: 2100, leaves: 1 },
  window: { width: 1200, sill: 900, head: 2100, leaves: 0 },
  passage: { width: 1800, sill: 0, head: 2100, leaves: 0 },
}

// ---------- 牆 ----------

/** 牆動過之後:門窗維持原本的世界位置(投影到新的牆上),房間重新圍 */
function afterWallChange(prev: Scene, walls: Wall[]): Scene {
  const oldWalls = new Map(prev.walls.map((w) => [w.id, w]))
  const newWalls = new Map(walls.map((w) => [w.id, w]))
  const openings: Opening[] = []
  for (const o of prev.openings) {
    const ow = oldWalls.get(o.wall), nw = newWalls.get(o.wall)
    if (!ow || !nw) continue
    const { along, length } = project(nw, openingCenter(o, ow))
    const half = Math.min(o.width / 2, length / 2)
    openings.push({ ...o, offset: round1(Math.max(half, Math.min(length - half, along))) })
  }
  const next = { ...prev, walls, openings }
  return { ...next, rooms: computeRooms(next) }
}

/** 跟某個端點接在一起的牆端點(距離小於牆厚一半) */
function joinedEnds(scene: Scene, p: Point, except?: string): [string, 'a' | 'b'][] {
  const out: [string, 'a' | 'b'][] = []
  for (const w of scene.walls) {
    if (w.id === except) continue
    const tol = w.thickness / 2 + 1
    if (dist(w.a, p) < tol) out.push([w.id, 'a'])
    if (dist(w.b, p) < tol) out.push([w.id, 'b'])
  }
  return out
}

/** 拖曳牆端點:接在同一點的其他牆端點一起動。base 是開始拖曳時的 Scene */
export function moveEndpoint(base: Scene, wallId: string, end: 'a' | 'b', p: Point): Scene {
  const w = base.walls.find((x) => x.id === wallId)
  if (!w) return base
  const moving = new Set([`${wallId}:${end}`, ...joinedEnds(base, w[end], wallId).map(([id, e]) => `${id}:${e}`)])
  const q = roundPt(p)
  const walls = base.walls.map((x) => {
    const a = moving.has(`${x.id}:a`) ? q : x.a
    const b = moving.has(`${x.id}:b`) ? q : x.b
    return a === x.a && b === x.b ? x : { ...x, a, b }
  }).filter((x) => dist(x.a, x.b) > 1)
  return afterWallChange(base, walls)
}

/** 整道牆往法線方向平移 d mm:接在它兩端、或丁字接在它身上的牆會跟著伸縮 */
export function moveWall(base: Scene, wallId: string, d: number): Scene {
  const w = base.walls.find((x) => x.id === wallId)
  if (!w) return base
  const delta = mul(wallFrame(w).n, d)
  const moving = new Set<string>([`${wallId}:a`, `${wallId}:b`])
  for (const [id, e] of [...joinedEnds(base, w.a, wallId), ...joinedEnds(base, w.b, wallId)]) moving.add(`${id}:${e}`)
  for (const x of base.walls) {
    if (x.id === wallId) continue
    for (const e of ['a', 'b'] as const) if (distToWall(w, x[e]) < w.thickness / 2 + 1) moving.add(`${x.id}:${e}`)
  }
  const walls = base.walls.map((x) => {
    const a = moving.has(`${x.id}:a`) ? roundPt(add(x.a, delta)) : x.a
    const b = moving.has(`${x.id}:b`) ? roundPt(add(x.b, delta)) : x.b
    return a === x.a && b === x.b ? x : { ...x, a, b }
  })
  return afterWallChange(base, walls)
}

export function addWall(scene: Scene, a: Point, b: Point): { scene: Scene; id: string } {
  const id = newId('w', scene.walls)
  const wall: Wall = { id, a: roundPt(a), b: roundPt(b), thickness: scene.meta.wall_thickness, height: scene.meta.wall_height }
  return { scene: afterWallChange(scene, [...scene.walls, wall]), id }
}

export function updateWall(scene: Scene, id: string, patch: Partial<Wall> & { length?: number }): Scene {
  const walls = scene.walls.map((w) => {
    if (w.id !== id) return w
    const { length, ...rest } = patch
    const next = { ...w, ...rest }
    if (length && length > 1) next.b = roundPt(add(w.a, mul(wallFrame(w).u, length)))
    return next
  })
  return afterWallChange(scene, walls)
}

// ---------- 門窗 ----------

export function addOpening(scene: Scene, wallId: string, along: number, kind: Opening['kind']): { scene: Scene; id: string } {
  const w = scene.walls.find((x) => x.id === wallId)!
  const { length } = wallFrame(w)
  const def = OPENING_DEFAULTS[kind]
  const width = Math.min(def.width, length - 100)
  const id = newId('o', scene.openings)
  const o: Opening = {
    id, wall: wallId, kind, width, sill: def.sill, head: def.head, leaves: def.leaves, swing: 1, hinge: 'start',
    offset: round1(Math.max(width / 2, Math.min(length - width / 2, along))), exterior: false,
  }
  return { scene: { ...scene, openings: [...scene.openings, o] }, id }
}

/** 門窗沿牆移動(夾在牆的範圍內);拖到別道牆上就換牆 */
export function moveOpening(base: Scene, id: string, p: Point): Scene {
  const o = base.openings.find((x) => x.id === id)
  if (!o) return base
  let wall = base.walls.find((w) => w.id === o.wall)!
  const near = [...base.walls].sort((x, y) => distToWall(x, p) - distToWall(y, p))[0]
  if (near && near.id !== wall.id && distToWall(near, p) < near.thickness && wallFrame(near).length > o.width) wall = near
  const { along, length } = project(wall, p)
  const half = Math.min(o.width / 2, length / 2)
  const offset = round1(Math.max(half, Math.min(length - half, along)))
  return { ...base, openings: base.openings.map((x) => (x.id === id ? { ...x, wall: wall.id, offset } : x)) }
}

export function updateOpening(scene: Scene, id: string, patch: Partial<Opening>): Scene {
  return {
    ...scene,
    openings: scene.openings.map((o) => {
      if (o.id !== id) return o
      const next = { ...o, ...patch }
      if (patch.kind && patch.kind !== o.kind) {
        const def = OPENING_DEFAULTS[patch.kind]
        Object.assign(next, { sill: def.sill, leaves: patch.kind === 'door' ? (next.width > 1200 ? 2 : 1) : 0 })
      }
      const w = scene.walls.find((x) => x.id === next.wall)
      if (w) {
        const { length } = wallFrame(w)
        next.width = Math.min(next.width, length)
        next.offset = round1(Math.max(next.width / 2, Math.min(length - next.width / 2, next.offset)))
      }
      return next
    }),
  }
}

// ---------- 家具 ----------

export function addFurniture(scene: Scene, type: string, p: Point): { scene: Scene; id: string } {
  const def = FURNITURE_DEFAULTS[type] ?? FURNITURE_DEFAULTS.other
  const id = newId('f', scene.furniture)
  const f: Furniture = { id, type, x: round1(p[0]), y: round1(p[1]), angle: 0, width: def.width, depth: def.depth, color: def.color, options: {} }
  return { scene: { ...scene, furniture: [...scene.furniture, f] }, id }
}

export function updateFurniture(scene: Scene, id: string, patch: Partial<Furniture>): Scene {
  return { ...scene, furniture: scene.furniture.map((f) => (f.id === id ? { ...f, ...patch } : f)) }
}

// ---------- 房間 ----------

export function updateRoom(scene: Scene, id: string, patch: Partial<Room>): Scene {
  return { ...scene, rooms: scene.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
}

// ---------- 刪除 ----------

export function remove(scene: Scene, sel: Sel): Scene {
  switch (sel.kind) {
    case 'wall':
      return afterWallChange(
        { ...scene, openings: scene.openings.filter((o) => o.wall !== sel.id) },
        scene.walls.filter((w) => w.id !== sel.id),
      )
    case 'opening':
      return { ...scene, openings: scene.openings.filter((o) => o.id !== sel.id) }
    case 'furniture':
      return { ...scene, furniture: scene.furniture.filter((f) => f.id !== sel.id) }
    case 'room':
      return { ...scene, rooms: scene.rooms.filter((r) => r.id !== sel.id) }
  }
}

// ---------- 比例尺 ----------

/** 平面尺寸全部乘上 k(高度不變):比例尺校正用 */
export function scaleScene(scene: Scene, k: number): Scene {
  const P = (p: Point): Point => roundPt(mul(p, k))
  const bg = scene.meta.background
  return {
    ...scene,
    meta: {
      ...scene.meta,
      mm_per_px: scene.meta.mm_per_px * k,
      wall_thickness: round1(scene.meta.wall_thickness * k),
      background: bg && { ...bg, width: bg.width * k, height: bg.height * k },
    },
    walls: scene.walls.map((w) => ({ ...w, a: P(w.a), b: P(w.b), thickness: round1(w.thickness * k) })),
    openings: scene.openings.map((o) => ({ ...o, offset: round1(o.offset * k), width: round1(o.width * k) })),
    rooms: scene.rooms.map((r) => ({ ...r, polygon: r.polygon.map(P), area: Math.round(r.area * k * k * 100) / 100 })),
    furniture: scene.furniture.map((f) => ({
      ...f, x: round1(f.x * k), y: round1(f.y * k), width: round1(f.width * k), depth: round1(f.depth * k),
      options: f.options.l_depth ? { ...f.options, l_depth: Number(f.options.l_depth) * k } : f.options,
    })),
  }
}

/** 兩點間的實際長度 → 比例係數 */
export function calibrationFactor(a: Point, b: Point, actualMm: number) {
  const measured = dist(a, b)
  return measured > 0 ? actualMm / measured : 1
}

