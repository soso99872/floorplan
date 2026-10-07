// 編輯器用的平面幾何小工具(單位 mm,y 向上)
import type { Opening, Point, Scene, Wall } from '../scene/types'

export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]]
export const mul = (a: Point, k: number): Point => [a[0] * k, a[1] * k]
export const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]
export const len = (a: Point) => Math.hypot(a[0], a[1])
export const dist = (a: Point, b: Point) => len(sub(a, b))

export function wallFrame(w: Wall) {
  const d = sub(w.b, w.a)
  const length = len(d) || 1
  const u: Point = [d[0] / length, d[1] / length]
  const n: Point = [-u[1], u[0]] // a→b 的左手邊
  return { length, u, n }
}

/** 點投影到牆中心線:along = 離 a 的距離(沒有夾在牆內),across = 到中心線的距離 */
export function project(w: Wall, p: Point) {
  const { u, n, length } = wallFrame(w)
  const d = sub(p, w.a)
  return { along: dot(d, u), across: Math.abs(dot(d, n)), length }
}

/** 點到牆中心線線段的距離 */
export function distToWall(w: Wall, p: Point) {
  const { along, length } = project(w, p)
  const t = Math.max(0, Math.min(length, along))
  const { u } = wallFrame(w)
  return dist(p, add(w.a, mul(u, t)))
}

/** 沿牆 [s0, s1]、厚度 t 的四個角 */
export function strip(w: Wall, s0: number, s1: number, t: number): Point[] {
  const { u, n } = wallFrame(w)
  const p = (s: number, k: number): Point => [w.a[0] + u[0] * s + n[0] * k, w.a[1] + u[1] * s + n[1] * k]
  return [p(s0, -t / 2), p(s1, -t / 2), p(s1, t / 2), p(s0, t / 2)]
}

export function openingCenter(o: Opening, w: Wall): Point {
  const { u } = wallFrame(w)
  return add(w.a, mul(u, o.offset))
}

/** 家具外框四角(世界座標) */
export function furnitureCorners(f: { x: number; y: number; angle: number; width: number; depth: number }): Point[] {
  const r = (f.angle * Math.PI) / 180
  const ux: Point = [Math.cos(r), Math.sin(r)]
  const uy: Point = [-ux[1], ux[0]]
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [
    f.x + (ux[0] * i * f.width + uy[0] * j * f.depth) / 2,
    f.y + (ux[1] * i * f.width + uy[1] * j * f.depth) / 2,
  ])
}

export function polygonArea(poly: Point[]) {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % poly.length]
    s += x0 * y1 - x1 * y0
  }
  return Math.abs(s) / 2
}

export function centroid(poly: Point[]): Point {
  let cx = 0, cy = 0, a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % poly.length]
    const c = x0 * y1 - x1 * y0
    a += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  if (Math.abs(a) < 1e-9) return poly[0]
  return [cx / (3 * a), cy / (3 * a)]
}

export function pointInPolygon(p: Point, poly: Point[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export function sceneBounds(scene: Scene): Bounds {
  const xs: number[] = [], ys: number[] = []
  for (const w of scene.walls) {
    xs.push(w.a[0], w.b[0])
    ys.push(w.a[1], w.b[1])
  }
  for (const f of scene.furniture) {
    xs.push(f.x)
    ys.push(f.y)
  }
  const bg = scene.meta.background
  if (bg) {
    xs.push(0, bg.width)
    ys.push(0, bg.height)
  }
  if (!xs.length) return { x0: 0, y0: 0, x1: 10000, y1: 10000 }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** 產生沒用過的 id(前綴 + 數字) */
export function newId(prefix: string, used: { id: string }[]) {
  let n = used.length + 1
  const ids = new Set(used.map((x) => x.id))
  while (ids.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export const round1 = (v: number) => Math.round(v * 10) / 10
export const roundPt = (p: Point): Point => [round1(p[0]), round1(p[1])]
