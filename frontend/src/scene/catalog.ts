// 程序化家具、門窗模型:依種類和外框尺寸,用方塊 / 圓柱 / 圓錐組出看起來像真的家具。
// (由原型的 legacy/furniture.py 移植過來;之後的修改以這份為準。)
//
// 座標是物件自己的局部座標(mm):原點在外框中心、地面 z=0,
// +x 沿寬度,+y 指向「背面」(床頭、沙發椅背、櫃子靠牆那側),-y 是正面。

export interface BoxPart {
  kind: 'box'
  /** 方塊中心 */
  c: [number, number, number]
  s: [number, number, number]
  color: string
  /** 繞自己中心的水平旋轉(度) */
  rz?: number
  /** < 1 是玻璃 */
  opacity?: number
}

export interface CylPart {
  kind: 'cyl'
  /** 底面中心 */
  c: [number, number, number]
  h: number
  /** [底半徑, 頂半徑];不同就是圓錐 */
  r: [number, number]
  color: string
  /** 水平方向縮放,用來做橢圓桌面 */
  sx: number
  sy: number
}

export type Part = BoxPart | CylPart

/** 可以繞鉸鏈轉的門片:parts 是以鉸鏈為原點、關門狀態的座標 */
export interface Leaf {
  hinge: [number, number]
  /** +1 門片從鉸鏈往 +x 延伸,-1 往 -x;打開時繞鉸鏈轉 -side × 角度(一律往局部 -y 那側開) */
  side: 1 | -1
  parts: Part[]
}

export const WOOD = '#8a6240'
export const WOOD_DARK = '#5c4030'
const WHITE = '#f3f1ec'
const LINEN = '#e9e4d8'
const BLACK = '#1c1c1e'
const METAL = '#9a9ea6'
const STONE = '#3d3f44'
const SHADE = '#f3e3c3'
const WATER = '#cfe3f0'
const FRAME = '#f1efea'
const GLASS = '#9ec9e6'
const DOOR_WOOD = '#a77b52'
const ENTRY_WOOD = '#6e4a31'

export function box(x: number, y: number, z0: number, sx: number, sy: number, sz: number, color: string,
  opt: { rz?: number; opacity?: number } = {}): BoxPart {
  const p: BoxPart = { kind: 'box', c: [x, y, z0 + sz / 2], s: [sx, sy, sz], color }
  if (opt.rz) p.rz = opt.rz
  if (opt.opacity !== undefined && opt.opacity < 1) p.opacity = opt.opacity
  return p
}

export function cyl(x: number, y: number, z0: number, h: number, r0: number, r1: number = r0,
  color: string = METAL, sx = 1, sy = 1): CylPart {
  return { kind: 'cyl', c: [x, y, z0], h, r: [r0, r1], color, sx, sy }
}

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 把顏色調暗 (f<1) 或調亮 (f>1) */
export function shade(hex: string, f: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const out = c.map((v) => (f < 1 ? v * f : v + (255 - v) * (f - 1)))
  return '#' + out.map((v) => Math.max(0, Math.min(255, Math.trunc(v))).toString(16).padStart(2, '0')).join('')
}

function legs(w: number, d: number, h: number, inset = 60, size = 40, color = WOOD_DARK, round = false): Part[] {
  const out: Part[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * (w / 2 - inset), y = sy * (d / 2 - inset)
      out.push(round ? cyl(x, y, 0, h, size / 2, size / 2, color) : box(x, y, 0, size, size, h, color))
    }
  }
  return out
}

function rotateParts(parts: Part[], quarterTurns: number, dx: number, dy: number): Part[] {
  return parts.map((p) => {
    let [x, y] = p.c
    for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) [x, y] = [-y, x]
    const q = { ...p, c: [x + dx, y + dy, p.c[2]] as [number, number, number] }
    if (q.kind === 'box' && quarterTurns % 2) q.s = [q.s[1], q.s[0], q.s[2]]
    return q
  })
}

function translateParts(parts: Part[], dx: number, dy: number): Part[] {
  return parts.map((p) => ({ ...p, c: [p.c[0] + dx, p.c[1] + dy, p.c[2]] as [number, number, number] }))
}

// ---------- 各種家具 ----------

/** W = 床頭那一邊的寬度,D = 床長 */
function bed(W: number, D: number, color: string): Part[] {
  // 平面圖上的床多半畫成白色;整張白的床看不出棉被,改用淺灰藍的被套
  const cover = luminance(color) < 215 ? color : '#d5dee8'
  const head = 60
  const bodyY = -head / 2, bodyD = D - head
  const parts: Part[] = [
    box(0, bodyY, 80, W, bodyD, 200, WOOD), // 床架
    ...translateParts(legs(W, bodyD, 80, 80, 60, WOOD_DARK), 0, bodyY),
    box(0, bodyY, 280, W - 40, bodyD - 40, 200, WHITE), // 床墊
    box(0, bodyY - bodyD * 0.12, 480, W - 10, bodyD * 0.68, 35, cover), // 棉被
    box(0, bodyY - bodyD * 0.12 - bodyD * 0.34 + 15, 300, W - 10, 30, 210, cover), // 棉被垂下來的那一截
    box(0, D / 2 - head / 2, 0, W, head, 1050, shade(WOOD, 0.85)), // 床頭板
  ]
  const n = W >= 1200 ? 2 : 1
  const pw = (W - 140) / n - 40
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + 70 + (i + 0.5) * (W - 140) / n
    parts.push(box(x, D / 2 - head - 230, 480, pw, 360, 130, LINEN)) // 枕頭
  }
  return parts
}

function sofa(W: number, D: number, color: string, arms: [boolean, boolean] = [true, true]): Part[] {
  const arm = Math.min(180, W * 0.12)
  const back = Math.min(220, D * 0.25)
  const parts: Part[] = [
    box(0, 0, 100, W, D, 240, shade(color, 0.85)), // 底座
    box(0, D / 2 - back / 2, 100, W, back, 700, color), // 椅背
    ...legs(W, D, 100, 60, 50, WOOD_DARK, true),
  ]
  const left = -W / 2 + (arms[0] ? arm : 0)
  const right = W / 2 - (arms[1] ? arm : 0)
  const seatD = D - back
  const n = Math.max(1, Math.round((right - left) / 700))
  const cw = (right - left) / n
  for (let i = 0; i < n; i++) { // 坐墊、靠墊
    const x = left + (i + 0.5) * cw
    parts.push(box(x, -back / 2, 340, cw - 15, seatD - 20, 120, shade(color, 1.08)))
    parts.push(box(x, D / 2 - back - 70, 460, cw - 40, 140, 360, shade(color, 1.12)))
  }
  arms.forEach((on, k) => { // 扶手
    if (on) parts.push(box((k ? 1 : -1) * (W / 2 - arm / 2), -back / 2 + 0.5, 100, arm, D - back + 1, 520, color))
  })
  return parts
}

/** L 形沙發:背靠 +y 和 +x 兩邊,轉角在右後方 */
function lSofa(W: number, D: number, depth: number, color: string): Part[] {
  const parts = translateParts(sofa(W, depth, color, [true, false]), 0, D / 2 - depth / 2) // 沿 +y 那條,左邊有扶手
  // 沿 +x 那條(轉角以外的長度),轉 -90°:椅背朝 +x,局部右端是遠離轉角的那頭
  const L = D - depth
  for (const p of sofa(L, depth, color, [false, true])) {
    const [x, y, z] = p.c
    const q = { ...p, c: [W / 2 - depth / 2 + y, -D / 2 + L / 2 - x, z] as [number, number, number] }
    if (q.kind === 'box') q.s = [q.s[1], q.s[0], q.s[2]]
    parts.push(q)
  }
  return parts
}

/** 餐椅,正面朝 -y */
function chair(color: string): Part[] {
  return [
    ...legs(420, 420, 440, 30, 35, WOOD_DARK),
    box(0, 0, 440, 440, 440, 40, color),
    box(0, 200, 480, 420, 40, 420, color),
  ]
}

/** 外框通常連椅子一起框進來(椅子一半塞在桌下),桌面取內圈,椅子沿長邊排一圈 */
function dining(W: number, D: number, color: string, oval: boolean): Part[] {
  const withChairs = Math.min(W, D) > 1100
  const tw = Math.max(withChairs ? W - 600 : W, 700)
  const td = Math.max(withChairs ? D - 600 : D, 700)
  const parts: Part[] = []
  if (oval) {
    parts.push(cyl(0, 0, 710, 40, 1, 1, color, tw / 2, td / 2))
    parts.push(cyl(0, 0, 0, 710, 70, 60, WOOD_DARK))
    parts.push(cyl(0, 0, 0, 25, Math.min(tw, td) * 0.25, Math.min(tw, td) * 0.25, WOOD_DARK))
  } else {
    parts.push(box(0, 0, 710, tw, td, 40, color))
    parts.push(...legs(tw, td, 710, 70, 60, WOOD_DARK))
  }
  if (withChairs) {
    const longX = tw >= td
    const [L, S] = longX ? [tw, td] : [td, tw]
    const n = Math.max(1, Math.round(L / 600))
    const c = shade(color, 0.9)
    for (let i = 0; i < n; i++) {
      const a = -L / 2 + (i + 0.5) * L / n
      for (const side of [-1, 1]) { // 椅背朝外
        const dist = S / 2 + 110
        parts.push(...(longX
          ? rotateParts(chair(c), side > 0 ? 0 : 2, a, side * dist)
          : rotateParts(chair(c), side > 0 ? 3 : 1, side * dist, a)))
      }
    }
    if (L > 1000) { // 長桌兩端各一張
      for (const side of [-1, 1]) {
        const dist = L / 2 + 110
        parts.push(...(longX
          ? rotateParts(chair(c), side > 0 ? 3 : 1, side * dist, 0)
          : rotateParts(chair(c), side > 0 ? 0 : 2, 0, side * dist)))
      }
    }
  }
  return parts
}

function lowTable(W: number, D: number, color: string): Part[] {
  return [
    box(0, 0, 390, W, D, 50, color),
    box(0, 0, 120, W - 120, D - 120, 25, shade(color, 0.85)), // 下層板
    ...legs(W, D, 390, 40, 45, WOOD_DARK),
  ]
}

function wardrobe(W: number, D: number, color: string): Part[] {
  const H = 2000
  const parts: Part[] = [box(0, 0, 0, W, D, 60, WOOD_DARK), box(0, 0, 60, W, D, H - 60, color)]
  const n = Math.max(2, Math.round(W / 500))
  for (let i = 1; i < n; i++) parts.push(box(-W / 2 + i * W / n, -D / 2 - 1, 80, 6, 4, H - 100, shade(color, 0.6))) // 門縫
  for (let i = 0; i < n; i++) { // 把手
    const x = -W / 2 + (i + 0.5) * W / n + (W / n / 2 - 60) * (i % 2 === 0 ? 1 : -1)
    parts.push(box(x, -D / 2 - 12, 900, 20, 20, 300, METAL))
  }
  return parts
}

/** 矮櫃 / 電視櫃;夠長的話上面放一台電視 */
function cabinet(W: number, D: number, color: string): Part[] {
  if (luminance(color) < 70) color = WOOD // 顏色取自電視本身(黑色),櫃子改用木色
  const parts: Part[] = [box(0, 0, 120, W, D, 400, color), ...legs(W, D, 120, 50, 40, WOOD_DARK)]
  const n = Math.max(1, Math.round(W / 600))
  for (let i = 1; i < n; i++) parts.push(box(-W / 2 + i * W / n, -D / 2 - 1, 140, 5, 4, 360, shade(color, 0.6)))
  if (W >= 800) {
    const tw = Math.min(W * 0.75, 1450)
    const th = tw * 9 / 16
    parts.push(
      box(0, D / 2 - 150, 520, 300, 180, 20, BLACK), // 電視底座
      box(0, D / 2 - 150, 540, 60, 40, 80, BLACK),
      box(0, D / 2 - 150, 600, tw, 45, th, BLACK), // 螢幕
    )
  }
  return parts
}

function counter(W: number, D: number, stove: boolean): Part[] {
  const parts: Part[] = [
    box(0, 0, 0, W, D, 80, STONE), // 踢腳
    box(0, 10, 80, W, D - 20, 780, WHITE),
    box(0, 0, 860, W + 20, D + 20, 40, STONE), // 檯面
  ]
  if (stove) {
    for (const dx of [-0.25, 0.25]) {
      for (const dy of [-0.22, 0.22]) {
        const r = Math.min(W, D) * 0.12
        parts.push(cyl(dx * W, dy * D, 900, 12, r, r, BLACK))
      }
    }
  }
  return parts
}

function appliance(W: number, D: number): Part[] {
  return [
    box(0, 0, 0, W, D, 850, WHITE),
    box(0, -D / 2 - 1, 120, W - 40, 4, 700, shade(WHITE, 0.92)), // 門板
    box(W / 2 - 80, -D / 2 - 15, 500, 25, 25, 260, METAL), // 把手
  ]
}

function bathtub(W: number, D: number): Part[] {
  return [box(0, 0, 0, W, D, 550, WHITE), box(0, 0, 545, W - 140, D - 140, 8, WATER)]
}

function lamp(W: number, D: number): Part[] {
  const r = Math.max(Math.min(W, D) / 2, 120)
  return [
    cyl(0, 0, 0, 25, r * 0.8, r * 0.8, BLACK),
    cyl(0, 0, 25, 1150, 12, 12, METAL),
    cyl(0, 0, 1150, 300, r * 1.1, r * 0.75, SHADE),
  ]
}

/** 家具型錄:type → 中文名稱 + 模型產生器 */
export const CATALOG: Record<string, { name: string; build: (W: number, D: number, color: string, opt: Record<string, number | boolean>) => Part[] }> = {
  bed: { name: '床', build: (W, D, c) => bed(W, D, c) },
  sofa: { name: '沙發/椅', build: (W, D, c, o) => (o.l_depth ? lSofa(W, D, Number(o.l_depth), c) : sofa(W, D, c)) },
  table: { name: '餐桌椅', build: (W, D, c, o) => dining(W, D, c, Boolean(o.oval)) },
  low_table: { name: '茶几/矮櫃', build: (W, D, c) => lowTable(W, D, c) },
  wardrobe: { name: '衣櫃', build: (W, D, c) => wardrobe(W, D, c) },
  cabinet: { name: '櫃子/電視櫃', build: (W, D, c) => cabinet(W, D, c) },
  counter: { name: '流理台/爐具', build: (W, D, _c, o) => counter(W, D, Boolean(o.stove)) },
  fixture: { name: '設備(衛浴/家電)', build: (W, D, _c, o) => (o.bluish ? bathtub(W, D) : appliance(W, D)) },
  lamp: { name: '立燈', build: (W, D) => lamp(W, D) },
  rug: { name: '地毯', build: (W, D, c) => [box(0, 0, 0, W, D, 12, c)] },
  other: { name: '其他', build: (W, D, c) => [box(0, 0, 0, W, D, 700, c)] },
}

export function furnitureParts(type: string, W: number, D: number, color: string, opt: Record<string, number | boolean>): Part[] {
  return (CATALOG[type] ?? CATALOG.other).build(W, D, color, opt)
}

// ---------- 門窗 ----------
// 局部座標:x 沿著牆,y 是牆厚方向(門往 -y 那一側開),z 從地面算起。W = 開口寬,T = 牆厚

export function windowParts(W: number, T: number, sill: number, head: number): Part[] {
  const f = 55 // 窗框寬
  const d = Math.min(T * 0.6, 90) // 窗框深
  const h = head - sill
  const parts: Part[] = [
    box(-W / 2 + f / 2, 0, sill, f, d, h, FRAME),
    box(W / 2 - f / 2, 0, sill, f, d, h, FRAME),
    box(0, 0, sill, W, d, f, FRAME),
    box(0, 0, head - f, W, d, f, FRAME),
    box(0, -T / 2 - 15, sill - 30, W + 80, 70, 30, FRAME), // 室內窗台板
    box(0, 0, sill + f, W - 2 * f, 8, h - 2 * f, GLASS, { opacity: 0.35 }),
  ]
  if (W > 1000) parts.push(box(0, 0, sill + f, 45, d, h - 2 * f, FRAME)) // 寬窗中間加一根直料
  return parts
}

const LEAF_T = 40

function leaf(hingeX: number, length: number, head: number, side: 1 | -1, color: string, T: number): Leaf {
  const parts: Part[] = [box(side * length / 2, 0, 0, length, LEAF_T, head - 15, color)]
  for (const y of [-35, 35]) parts.push(box(side * (length - 80), y, 1000, 120, 18, 22, METAL)) // 把手,兩面各一支
  return { hinge: [hingeX, -T / 2 + LEAF_T / 2], side, parts } // 關門時貼齊開門那側的牆面
}

/**
 * 門框 + 門片。leaves = 0 是開放通道(只有門框),1 單開,2 雙開。
 * hingeAtPlusX:單開門的鉸鏈在局部 +x 端(門片往 -x 延伸)。
 */
export function doorParts(W: number, T: number, head: number, leaves: number, entry: boolean,
  hingeAtPlusX: boolean): { frame: Part[]; leaves: Leaf[] } {
  const color = entry ? ENTRY_WOOD : DOOR_WOOD
  const f = 50, d = T + 20
  const frame: Part[] = [
    box(-W / 2 + f / 2, 0, 0, f, d, head, FRAME),
    box(W / 2 - f / 2, 0, 0, f, d, head, FRAME),
    box(0, 0, head - f, W, d, f, FRAME),
  ]
  const clear = W - 2 * f
  if (leaves === 0) return { frame, leaves: [] }
  if (leaves === 2) {
    return { frame, leaves: [leaf(-clear / 2, clear / 2, head - f, 1, color, T), leaf(clear / 2, clear / 2, head - f, -1, color, T)] }
  }
  return {
    frame,
    leaves: [hingeAtPlusX ? leaf(clear / 2, clear, head - f, -1, color, T) : leaf(-clear / 2, clear, head - f, 1, color, T)],
  }
}
