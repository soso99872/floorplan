// Scene JSON → three.js 物件。編輯後重新呼叫 buildScene 即可更新 3D。
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping'
import type { Opening, Point, Scene, Wall } from '../scene/types'
import { doorParts, furnitureParts, windowParts, type Leaf, type Part } from '../scene/catalog'

/** 一扇可以開關的門:pivots 是門片的鉸鏈群組,t 是目前打開的比例 0~1 */
export interface DoorHandle {
  openingId: string
  pivots: THREE.Group[]
  open: boolean
  t: number
}

/**
 * 門片 mesh → 它屬於哪一扇門(點門時用)。不放在 userData 裡:userData 會在 clone / 匯出時
 * 被 JSON 序列化,門物件裡又指回門片,會變成循環參照。
 */
export const doorOfMesh = new WeakMap<THREE.Object3D, DoorHandle>()

export interface BuiltScene {
  root: THREE.Group
  walls: THREE.Mesh
  wallEdges: THREE.LineSegments
  furniture: THREE.Group
  doors: DoorHandle[]
  bounds: THREE.Box3
}

// ---------- 牆的幾何 ----------

export function wallFrame(w: Wall) {
  const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1]
  const length = Math.hypot(dx, dy)
  const u: Point = [dx / length, dy / length]
  const n: Point = [-u[1], u[0]] // a→b 的左手邊
  return { length, u, n, angle: Math.atan2(dy, dx) }
}

/** 沿牆 [s0, s1] 這一段、厚度 t 的矩形(平面多邊形) */
function wallStrip(w: Wall, s0: number, s1: number, t: number): Polygon {
  const { u, n } = wallFrame(w)
  const p = (s: number, k: number): [number, number] => [w.a[0] + u[0] * s + n[0] * k, w.a[1] + u[1] * s + n[1] * k]
  return [[p(s0, -t / 2), p(s1, -t / 2), p(s1, t / 2), p(s0, t / 2), p(s0, -t / 2)]]
}

function extrudeMulti(mp: MultiPolygon, z0: number, z1: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  for (const poly of mp) {
    const ring = (r: [number, number][]) => r.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y))
    const shape = new THREE.Shape(ring(poly[0]))
    for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(ring(hole)))
    const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false })
    g.translate(0, 0, z0)
    out.push(g.index ? g.toNonIndexed() : g)
  }
  return out
}

/**
 * 牆:所有牆段的平面聯集扣掉開口,擠出到牆高;開口上方的過樑、窗台下的矮牆另外擠出。
 * 先做平面聯集,轉角和 T 字接頭才不會有重疊的面和多餘的稜線。
 */
function buildWalls(scene: Scene): THREE.BufferGeometry {
  const walls = new Map(scene.walls.map((w) => [w.id, w]))
  const strips = scene.walls.map((w) => wallStrip(w, 0, wallFrame(w).length, w.thickness))
  const holes: Polygon[] = []
  const parts: THREE.BufferGeometry[] = []
  for (const o of scene.openings) {
    const w = walls.get(o.wall)
    if (!w) continue
    const s0 = o.offset - o.width / 2, s1 = o.offset + o.width / 2
    holes.push(wallStrip(w, s0, s1, w.thickness + 2))
    const strip: MultiPolygon = [wallStrip(w, s0, s1, w.thickness)]
    if (o.head < w.height) parts.push(...extrudeMulti(strip, o.head, w.height)) // 過樑
    if (o.kind === 'window' && o.sill > 0) parts.push(...extrudeMulti(strip, 0, o.sill)) // 窗台下的牆
  }
  if (strips.length) {
    const solid = polygonClipping.union(strips[0], ...strips.slice(1))
    const cut = holes.length ? polygonClipping.difference(solid, ...holes) : solid
    const height = Math.max(...scene.walls.map((w) => w.height))
    parts.push(...extrudeMulti(cut, 0, height))
  }
  const merged = mergeGeometries(parts)
  merged.computeVertexNormals()
  return merged
}

// ---------- 零件 → mesh ----------

const matCache = new Map<string, THREE.MeshStandardMaterial>()
export function partMaterial(color: string, opacity = 1): THREE.MeshStandardMaterial {
  const key = `${color}/${opacity}`
  let m = matCache.get(key)
  if (!m) {
    const glass = opacity < 1
    m = new THREE.MeshStandardMaterial({
      color, roughness: glass ? 0.05 : 0.72, metalness: glass ? 0.1 : 0.04,
      transparent: glass, opacity, depthWrite: !glass, side: glass ? THREE.DoubleSide : THREE.FrontSide,
    })
    matCache.set(key, m)
  }
  return m
}

function partMesh(p: Part): THREE.Mesh {
  if (p.kind === 'box') {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.s), partMaterial(p.color, p.opacity ?? 1))
    mesh.position.set(...p.c)
    if (p.rz) mesh.rotation.z = THREE.MathUtils.degToRad(p.rz)
    return mesh
  }
  // CylinderGeometry 預設沿 Y 軸、以中心為原點;轉成沿 Z、底面在 c 的高度
  const geo = new THREE.CylinderGeometry(p.r[1], p.r[0], p.h, 40)
  geo.rotateX(Math.PI / 2)
  geo.translate(0, 0, p.h / 2)
  geo.scale(p.sx, p.sy, 1)
  const mesh = new THREE.Mesh(geo, partMaterial(p.color))
  mesh.position.set(...p.c)
  return mesh
}

function placed(parts: Part[], x: number, y: number, angleRad: number, z = 0): THREE.Group {
  const g = new THREE.Group()
  for (const p of parts) g.add(partMesh(p))
  g.position.set(x, y, z)
  g.rotation.z = angleRad
  return g
}

function leafPivot(lf: Leaf, door: DoorHandle): THREE.Group {
  const pivot = new THREE.Group()
  pivot.position.set(lf.hinge[0], lf.hinge[1], 0)
  pivot.userData.side = lf.side
  for (const p of lf.parts) {
    const m = partMesh(p)
    doorOfMesh.set(m, door)
    pivot.add(m)
  }
  door.pivots.push(pivot)
  return pivot
}

/**
 * 門窗的局部座標:x 沿牆、門往局部 -y 開。
 * swing = +1(往 a→b 的左手邊開)時,局部 -y 要指向左手邊,所以局部 x 取 b→a 方向(轉 180°)。
 */
function buildOpening(o: Opening, w: Wall, doors: DoorHandle[]): THREE.Group {
  const { u, angle } = wallFrame(w)
  const cx = w.a[0] + u[0] * o.offset, cy = w.a[1] + u[1] * o.offset
  if (o.kind === 'window') return placed(windowParts(o.width, w.thickness, o.sill, o.head), cx, cy, angle)
  const flipped = o.swing === 1
  // 鉸鏈在 a 端:沒翻轉時 a 端是局部 -x;翻轉後 a 端變成局部 +x
  const hingeAtPlusX = (o.hinge === 'start') === flipped
  const { frame, leaves } = doorParts(o.width, w.thickness, o.head, o.leaves, o.exterior, hingeAtPlusX)
  const g = placed(frame, cx, cy, angle + (flipped ? Math.PI : 0))
  if (leaves.length) {
    const door: DoorHandle = { openingId: o.id, pivots: [], open: false, t: 0 }
    for (const lf of leaves) g.add(leafPivot(lf, door))
    doors.push(door)
  }
  return g
}

export function buildScene(scene: Scene): BuiltScene {
  const root = new THREE.Group()
  const doors: DoorHandle[] = []

  const wallGeo = buildWalls(scene)
  const walls = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({
    color: 0xf2efe9, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }))
  root.add(walls)
  // 只畫真正的轉角(夾角大於 25°),共平面的接縫不畫
  const wallEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeo, 25), new THREE.LineBasicMaterial({ color: 0x14202e }))
  root.add(wallEdges)

  const wallById = new Map(scene.walls.map((w) => [w.id, w]))
  for (const o of scene.openings) {
    const w = wallById.get(o.wall)
    if (w) root.add(buildOpening(o, w, doors))
  }

  const furniture = new THREE.Group()
  for (const f of scene.furniture) {
    const g = placed(furnitureParts(f.type, f.width, f.depth, f.color, f.options), f.x, f.y,
      THREE.MathUtils.degToRad(f.angle), 2) // 浮起 2 mm,避免底面跟地板閃爍
    g.userData.furnitureId = f.id
    furniture.add(g)
  }
  root.add(furniture)

  wallGeo.computeBoundingBox()
  const bounds = wallGeo.boundingBox!.clone()
  return { root, walls, wallEdges, furniture, doors, bounds }
}
