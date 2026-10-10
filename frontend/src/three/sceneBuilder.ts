// Scene JSON → three.js 物件。編輯後重新呼叫 buildScene 即可更新 3D。
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping'
import type { Opening, Point, Room, Scene, Wall } from '../scene/types'
import { doorParts, furnitureParts, windowParts, type Leaf, type Mat, type Part } from '../scene/catalog'
import { FLOOR_MATERIALS, floorMaterialId, floorTexture } from '../scene/materials'

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
  floors: THREE.Group
  ceilings: THREE.Group
  doors: DoorHandle[]
  bounds: THREE.Box3
  /** 第一人稱走動時擋路的線段(牆的平面外框,門和開放通道是開著的) */
  blockers: [Point, Point][]
  /** 走進去時的起點:最大房間的中心 */
  walkStart: Point | null
  /** 各房間的中心與面積(夜景燈) */
  rooms: { center: Point; area: number }[]
}

export const DEFAULT_WALL_COLOR = '#f2efe9'

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
function buildWalls(scene: Scene): { geo: THREE.BufferGeometry; blockers: [Point, Point][] } {
  const walls = new Map(scene.walls.map((w) => [w.id, w]))
  const strips = scene.walls.map((w) => wallStrip(w, 0, wallFrame(w).length, w.thickness))
  const holes: Polygon[] = []
  const passable: Polygon[] = []
  const parts: THREE.BufferGeometry[] = []
  const blockers: [Point, Point][] = []
  for (const o of scene.openings) {
    const w = walls.get(o.wall)
    if (!w) continue
    const s0 = o.offset - o.width / 2, s1 = o.offset + o.width / 2
    holes.push(wallStrip(w, s0, s1, w.thickness + 2))
    if (o.kind !== 'window') passable.push(wallStrip(w, s0, s1, w.thickness + 2))
    const strip: MultiPolygon = [wallStrip(w, s0, s1, w.thickness)]
    if (o.head < w.height) parts.push(...extrudeMulti(strip, o.head, w.height)) // 過樑
    if (o.kind === 'window' && o.sill > 0) parts.push(...extrudeMulti(strip, 0, o.sill)) // 窗台下的牆
  }
  if (strips.length) {
    const solid = polygonClipping.union(strips[0], ...strips.slice(1))
    const cut = holes.length ? polygonClipping.difference(solid, ...holes) : solid
    const height = Math.max(...scene.walls.map((w) => w.height))
    parts.push(...extrudeMulti(cut, 0, height))
    const walk = passable.length ? polygonClipping.difference(solid, ...passable) : solid
    for (const poly of walk) for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) blockers.push([ring[i] as Point, ring[i + 1] as Point])
    }
  }
  const merged = parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry()
  merged.computeVertexNormals()
  return { geo: merged, blockers }
}

// ---------- 地板、天花板 ----------

function roomShape(r: Room): THREE.Shape {
  return new THREE.Shape(r.polygon.map(([x, y]) => new THREE.Vector2(x, y)))
}

const floorMatCache = new Map<string, THREE.MeshStandardMaterial>()
function floorMaterial(id: string) {
  let m = floorMatCache.get(id)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: floorTexture(id), roughness: FLOOR_MATERIALS[id].roughness, metalness: 0 })
    floorMatCache.set(id, m)
  }
  return m
}

/** 每個房間一塊地板,UV 用世界座標除以紋理尺寸,紋理才不會因房間大小變形 */
function buildFloors(scene: Scene): THREE.Group {
  const g = new THREE.Group()
  for (const r of scene.rooms) {
    if (r.polygon.length < 3) continue
    const id = floorMaterialId(r)
    const [sx, sy] = FLOOR_MATERIALS[id].size
    const geo = new THREE.ShapeGeometry(roomShape(r))
    const pos = geo.attributes.position
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      uv[2 * i] = pos.getX(i) / sx
      uv[2 * i + 1] = pos.getY(i) / sy
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    const mesh = new THREE.Mesh(geo, floorMaterial(id))
    mesh.position.z = 1
    mesh.receiveShadow = true
    mesh.userData.roomId = r.id
    g.add(mesh)
  }
  return g
}

const ceilingMat = new THREE.MeshStandardMaterial({ color: 0xf7f6f3, roughness: 0.95, side: THREE.DoubleSide })

function buildCeilings(scene: Scene, height: number): THREE.Group {
  const g = new THREE.Group()
  for (const r of scene.rooms) {
    if (r.polygon.length < 3) continue
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(roomShape(r)), ceilingMat)
    mesh.position.z = height - 1
    mesh.receiveShadow = true
    g.add(mesh)
  }
  g.visible = false
  return g
}

/** 走進去的起點:最大房間裡離牆最遠的點(L 形房間的外框中心可能落在牆上) */
function walkStartPoint(scene: Scene, blockers: [Point, Point][]): Point | null {
  const r = [...scene.rooms].sort((a, b) => b.area - a.area)[0]
  if (!r) return null
  const box = new THREE.Box2().setFromPoints(r.polygon.map(([x, y]) => new THREE.Vector2(x, y)))
  let best: Point | null = null, bestD = -1
  const N = 24
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const p: Point = [box.min.x + ((box.max.x - box.min.x) * i) / N, box.min.y + ((box.max.y - box.min.y) * j) / N]
    if (!insidePolygon(p, r.polygon)) continue
    const d = Math.min(...blockers.map(([a, b]) => distToSegment(p, a, b)))
    if (d > bestD) { best = p; bestD = d }
  }
  return best
}

function insidePolygon(p: Point, poly: Point[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function distToSegment(p: Point, a: Point, b: Point) {
  const abx = b[0] - a[0], aby = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby || 1)))
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t)
}

// ---------- 零件 → mesh ----------

/** 各材質的粗糙度 / 金屬感:布料霧面、陶瓷和烤漆會反光、金屬有金屬感 */
const MAT_PROPS: Record<Mat, { roughness: number; metalness: number }> = {
  wood: { roughness: 0.62, metalness: 0 },
  fabric: { roughness: 0.95, metalness: 0 },
  metal: { roughness: 0.28, metalness: 0.9 },
  ceramic: { roughness: 0.12, metalness: 0 },
  glass: { roughness: 0.05, metalness: 0.1 },
  plastic: { roughness: 0.38, metalness: 0 },
  leaf: { roughness: 0.75, metalness: 0 },
  stone: { roughness: 0.3, metalness: 0 },
  screen: { roughness: 0.15, metalness: 0.2 },
}

const matCache = new Map<string, THREE.MeshStandardMaterial>()
export function partMaterial(color: string, opacity = 1, mat?: Mat): THREE.MeshStandardMaterial {
  const key = `${color}/${opacity}/${mat ?? ''}`
  let m = matCache.get(key)
  if (!m) {
    const glass = opacity < 1
    const props = mat ? MAT_PROPS[mat] : glass ? MAT_PROPS.glass : { roughness: 0.72, metalness: 0.04 }
    m = new THREE.MeshStandardMaterial({
      color, ...props,
      transparent: glass, opacity, depthWrite: !glass, side: glass ? THREE.DoubleSide : THREE.FrontSide,
    })
    matCache.set(key, m)
  }
  return m
}

const geoCache = new Map<string, THREE.BufferGeometry>()
function boxGeometry(s: [number, number, number], round = 0): THREE.BufferGeometry {
  const r = Math.min(round, Math.min(...s) / 2 - 0.5)
  const key = `${s.map((v) => v.toFixed(1)).join(',')}/${r > 1 ? r.toFixed(1) : 0}`
  let g = geoCache.get(key)
  if (!g) {
    g = r > 1 ? new RoundedBoxGeometry(s[0], s[1], s[2], 3, r) : new THREE.BoxGeometry(...s)
    geoCache.set(key, g)
  }
  return g
}

function partMesh(p: Part): THREE.Mesh {
  if (p.kind === 'box') {
    const mesh = new THREE.Mesh(boxGeometry(p.s, p.round), partMaterial(p.color, p.opacity ?? 1, p.mat))
    mesh.position.set(...p.c)
    if (p.rz) mesh.rotation.z = THREE.MathUtils.degToRad(p.rz)
    return mesh
  }
  // CylinderGeometry 預設沿 Y 軸、以中心為原點;轉成沿 Z、底面在 c 的高度
  const geo = new THREE.CylinderGeometry(p.r[1], p.r[0], p.h, 40)
  geo.rotateX(Math.PI / 2)
  geo.translate(0, 0, p.h / 2)
  geo.scale(p.sx, p.sy, 1)
  const mesh = new THREE.Mesh(geo, partMaterial(p.color, 1, p.mat))
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

  const { geo: wallGeo, blockers } = buildWalls(scene)
  const walls = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({
    color: scene.meta.wall_color ?? DEFAULT_WALL_COLOR, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }))
  walls.castShadow = true
  walls.receiveShadow = true
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

  // 門窗、家具會投下陰影,也會接收陰影(玻璃不擋光)
  root.traverse((m) => {
    if (m instanceof THREE.Mesh && m !== walls) {
      m.castShadow = !(m.material as THREE.Material).transparent
      m.receiveShadow = true
    }
  })

  // 家具也擋路(地毯可以踩過去)
  for (const f of scene.furniture) {
    if (f.type === 'rug') continue
    const r = THREE.MathUtils.degToRad(f.angle)
    const ux: Point = [Math.cos(r), Math.sin(r)], uy: Point = [-ux[1], ux[0]]
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]): Point => [
      f.x + (ux[0] * i * f.width + uy[0] * j * f.depth) / 2, f.y + (ux[1] * i * f.width + uy[1] * j * f.depth) / 2])
    for (let i = 0; i < 4; i++) blockers.push([c[i], c[(i + 1) % 4]])
  }

  const floors = buildFloors(scene)
  root.add(floors)
  const height = scene.walls.length ? Math.max(...scene.walls.map((w) => w.height)) : scene.meta.wall_height
  const ceilings = buildCeilings(scene, height)
  root.add(ceilings)

  wallGeo.computeBoundingBox()
  const box = wallGeo.boundingBox
  const bounds = box && !box.isEmpty() ? box.clone() : new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1000, 1000, 1000))
  return { root, walls, wallEdges, furniture, floors, ceilings, doors, bounds, blockers, walkStart: walkStartPoint(scene, blockers),
    rooms: scene.rooms.map((r) => {
      const b = new THREE.Box2().setFromPoints(r.polygon.map(([x, y]) => new THREE.Vector2(x, y)))
      const c = b.getCenter(new THREE.Vector2())
      return { center: [c.x, c.y] as Point, area: r.area }
    }) }
}
