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
  /** 圓角半徑 mm */
  round?: number
  mat?: Mat
}

/** 材質:決定反光程度(粗糙度、金屬感) */
export type Mat = 'wood' | 'fabric' | 'metal' | 'ceramic' | 'glass' | 'plastic' | 'leaf' | 'stone' | 'screen'

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
  mat?: Mat
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
const SHADE = '#f3e3c3'
const WATER = '#cfe3f0'
const FRAME = '#f1efea'
const GLASS = '#9ec9e6'
const DOOR_WOOD = '#a77b52'
const ENTRY_WOOD = '#6e4a31'

export function box(x: number, y: number, z0: number, sx: number, sy: number, sz: number, color: string,
  opt: { rz?: number; opacity?: number; round?: number; mat?: Mat } = {}): BoxPart {
  const p: BoxPart = { kind: 'box', c: [x, y, z0 + sz / 2], s: [sx, sy, sz], color }
  if (opt.rz) p.rz = opt.rz
  if (opt.opacity !== undefined && opt.opacity < 1) p.opacity = opt.opacity
  if (opt.round) p.round = opt.round
  if (opt.mat) p.mat = opt.mat
  return p
}

/** 圓角方塊(軟墊、櫃體、家電) */
export function rbox(x: number, y: number, z0: number, sx: number, sy: number, sz: number, color: string,
  round: number, mat?: Mat): BoxPart {
  return box(x, y, z0, sx, sy, sz, color, { round, mat })
}

export function cyl(x: number, y: number, z0: number, h: number, r0: number, r1: number = r0,
  color: string = METAL, sx = 1, sy = 1, mat?: Mat): CylPart {
  const p: CylPart = { kind: 'cyl', c: [x, y, z0], h, r: [r0, r1], color, sx, sy }
  if (mat) p.mat = mat
  return p
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


function appliance(W: number, D: number): Part[] {
  return [
    box(0, 0, 0, W, D, 850, WHITE),
    box(0, -D / 2 - 1, 120, W - 40, 4, 700, shade(WHITE, 0.92)), // 門板
    box(W / 2 - 80, -D / 2 - 15, 500, 25, 25, 260, METAL), // 把手
  ]
}



// ---------- 家具庫(細緻模型) ----------
// 共用:櫃體 + 門片分縫 + 把手,軟墊用圓角方塊、布料材質;金屬、陶瓷、玻璃有各自的反光。

const HANDLE = '#b8bcc4'
const CERAMIC = '#f7f7f5'
const STEEL = '#c8ccd2'
const DARK = '#2a2b2e'
const LEAF = '#6f9a5b'
const POT = '#c9b8a3'

/** 櫃體:n 片門(或抽屜列),門縫、把手。front 朝 -y */
function carcass(W: number, D: number, H: number, color: string, opt: {
  z0?: number; doors?: number; drawers?: number; handle?: 'bar' | 'knob' | 'none'; plinth?: number
} = {}): Part[] {
  const z0 = opt.z0 ?? 0
  const plinth = opt.plinth ?? 60
  const parts: Part[] = []
  if (plinth > 0) parts.push(box(0, 15, z0, W - 20, D - 30, plinth, shade(color, 0.55), { mat: 'wood' }))
  const bodyZ = z0 + plinth, bodyH = H - plinth
  parts.push(rbox(0, 0, bodyZ, W, D, bodyH, color, 6, 'wood'))
  const gap = 4, f = -D / 2 - 1
  const doors = opt.doors ?? 0, drawers = opt.drawers ?? 0
  const handle = opt.handle ?? 'bar'
  if (drawers) {
    const dh = bodyH / drawers
    for (let i = 1; i < drawers; i++) parts.push(box(0, f, bodyZ + i * dh - gap / 2, W - 20, 3, gap, shade(color, 0.6)))
    for (let i = 0; i < drawers; i++) {
      const z = bodyZ + (i + 0.5) * dh
      if (handle === 'knob') parts.push(cyl(0, f - 6, z - 12, 24, 14, 14, HANDLE, 1, 1, 'metal'))
      else if (handle === 'bar') parts.push(rbox(0, f - 9, z - 7, Math.min(W * 0.4, 260), 14, 14, HANDLE, 5, 'metal'))
    }
  }
  if (doors) {
    const dw = W / doors
    for (let i = 1; i < doors; i++) parts.push(box(-W / 2 + i * dw, f, bodyZ + 20, gap, 3, bodyH - 40, shade(color, 0.6)))
    for (let i = 0; i < doors; i++) {
      const left = i % 2 === 0
      const x = -W / 2 + (i + 0.5) * dw + (dw / 2 - 50) * (left ? 1 : -1)
      if (handle === 'bar') parts.push(rbox(x, f - 9, bodyZ + bodyH * 0.45, 14, 14, Math.min(320, bodyH * 0.3), HANDLE, 5, 'metal'))
      else if (handle === 'knob') parts.push(cyl(x, f - 6, bodyZ + bodyH * 0.55, 24, 14, 14, HANDLE, 1, 1, 'metal'))
    }
  }
  return parts
}

function tableTop(W: number, D: number, H: number, color: string, legColor = WOOD_DARK, round = false): Part[] {
  return [
    rbox(0, 0, H - 35, W, D, 35, color, 8, 'wood'),
    box(0, 0, H - 110, W - 140, D - 140, 75, shade(color, 0.85), { mat: 'wood' }), // 牙板
    ...legs(W, D, H - 35, 60, 50, legColor, round),
  ]
}

function bedPro(W: number, D: number, color: string): Part[] {
  const cover = luminance(color) < 215 ? color : '#d5dee8'
  const head = 90
  const bodyY = -head / 2, bodyD = D - head
  const parts: Part[] = [
    rbox(0, bodyY, 120, W, bodyD, 200, shade(WOOD, 1.1), 20, 'wood'), // 床框
    ...translateParts(legs(W, bodyD, 120, 90, 60, WOOD_DARK, true), 0, bodyY),
    rbox(0, bodyY, 320, W - 50, bodyD - 50, 220, WHITE, 40, 'fabric'), // 床墊
    rbox(0, bodyY - bodyD * 0.13, 530, W - 20, bodyD * 0.68, 50, cover, 22, 'fabric'), // 棉被
    rbox(0, bodyY - bodyD * 0.13 - bodyD * 0.34 + 20, 330, W - 20, 40, 240, cover, 15, 'fabric'),
    rbox(0, D / 2 - head / 2, 0, W + 40, head, 1100, shade(color, 0.92), 30, 'fabric'), // 軟包床頭
  ]
  // 床頭的軟包分格
  const n = Math.max(3, Math.round(W / 300))
  for (let i = 1; i < n; i++) parts.push(box(-W / 2 - 20 + i * (W + 40) / n, D / 2 - head - 1, 450, 6, 4, 600, shade(color, 0.75)))
  const pn = W >= 1200 ? 2 : 1
  const pw = (W - 160) / pn - 40
  for (let i = 0; i < pn; i++) {
    const x = -W / 2 + 80 + (i + 0.5) * (W - 160) / pn
    parts.push(rbox(x, D / 2 - head - 240, 540, pw, 380, 150, LINEN, 60, 'fabric'))
  }
  return parts
}

function crib(W: number, D: number, color: string): Part[] {
  const H = 950
  const parts: Part[] = [rbox(0, 0, 250, W - 40, D - 40, 120, WHITE, 30, 'fabric'), ...legs(W, D, 250, 25, 50, color)]
  for (const y of [-1, 1]) parts.push(box(0, y * (D / 2 - 15), 250, W, 30, 40, color, { mat: 'wood' }), box(0, y * (D / 2 - 15), H - 40, W, 30, 40, color, { mat: 'wood' }))
  for (const x of [-1, 1]) parts.push(box(x * (W / 2 - 15), 0, 250, 30, D, H - 250, color, { mat: 'wood' }))
  const n = Math.round(W / 90)
  for (let i = 1; i < n; i++) for (const y of [-1, 1]) parts.push(cyl(-W / 2 + i * W / n, y * (D / 2 - 15), 290, H - 330, 9, 9, color, 1, 1, 'wood'))
  return parts
}

function nightstand(W: number, D: number, color: string): Part[] {
  return [...carcass(W, D, 520, color, { drawers: 2, handle: 'knob', plinth: 0, z0: 80 }), ...legs(W, D, 80, 30, 30, WOOD_DARK, true),
    cyl(W * 0.15, D * 0.05, 600, 30, 70, 70, '#e8e1d2', 1, 1, 'ceramic'), cyl(W * 0.15, D * 0.05, 630, 200, 12, 12, '#c9a46a', 1, 1, 'metal'),
    cyl(W * 0.15, D * 0.05, 800, 140, 110, 80, SHADE, 1, 1, 'fabric')]
}

function dresser(W: number, D: number, color: string): Part[] {
  return [
    ...carcass(W, D, 760, color, { drawers: 3, handle: 'bar', plinth: 0, z0: 0 }),
    rbox(0, D / 2 - 15, 760, W * 0.6, 20, 700, '#dfe7ec', 20, 'glass'), // 鏡子
    rbox(0, D / 2 - 5, 740, W * 0.66, 30, 760, shade(color, 0.85), 25, 'wood'),
  ]
}

function desk(W: number, D: number, color: string): Part[] {
  const parts = tableTop(W, D, 750, color, '#3b3d42')
  parts.push(...carcass(Math.min(420, W * 0.33), D - 60, 640, shade(color, 0.95), { drawers: 3, handle: 'bar', plinth: 0, z0: 0 }).map((p) => ({ ...p, c: [p.c[0] + W / 2 - Math.min(420, W * 0.33) / 2 - 30, p.c[1], p.c[2]] as [number, number, number] })))
  parts.push(rbox(-W * 0.15, D / 2 - 120, 750, 560, 25, 340, DARK, 10, 'screen'), box(-W * 0.15, D / 2 - 120, 750, 60, 120, 120, DARK, { mat: 'metal' })) // 螢幕
  return parts
}

function chairPro(color: string): Part[] {
  return [
    ...legs(440, 440, 450, 35, 32, WOOD_DARK, true),
    rbox(0, 0, 440, 450, 450, 55, color, 18, 'fabric'),
    rbox(0, 205, 490, 430, 45, 430, color, 18, 'fabric'),
  ]
}

function bookshelf(W: number, D: number, color: string): Part[] {
  const H = W > 1200 ? 2100 : 1800
  const parts: Part[] = [box(0, 0, 0, W, D, 60, shade(color, 0.6), { mat: 'wood' })]
  for (const x of [-1, 1]) parts.push(box(x * (W / 2 - 12), 0, 0, 25, D, H, color, { mat: 'wood' }))
  parts.push(box(0, D / 2 - 6, 0, W, 12, H, shade(color, 0.9), { mat: 'wood' }))
  const shelves = Math.round(H / 360)
  const books = ['#7b4b3a', '#2f5d7c', '#b58b3c', '#4f6b4a', '#8a8f96', '#9c3d3d', '#d8cdb8']
  for (let i = 0; i <= shelves; i++) {
    const z = 60 + i * (H - 85) / shelves
    parts.push(box(0, 0, z, W - 50, D - 12, 25, color, { mat: 'wood' }))
    if (i < shelves) { // 書
      let x = -W / 2 + 40
      let k = i * 3
      while (x < W / 2 - 80) {
        const bw = 25 + ((k * 37) % 30), bh = 200 + ((k * 53) % 90)
        if (((k * 29) % 7) !== 0) parts.push(box(x + bw / 2, 0, z + 25, bw, D * 0.7, bh, books[k % books.length], { mat: 'plastic' }))
        x += bw + 3
        k++
      }
    }
  }
  return parts
}

function armchair(W: number, D: number, color: string): Part[] {
  return sofaPro(W, D, color, [true, true], 1)
}

/** 沙發:圓角軟墊、布料;seats = 座位數(0 = 依寬度) */
function sofaPro(W: number, D: number, color: string, arms: [boolean, boolean] = [true, true], seats = 0): Part[] {
  const arm = Math.min(200, W * 0.13)
  const back = Math.min(230, D * 0.26)
  const parts: Part[] = [
    rbox(0, 0, 120, W, D, 230, shade(color, 0.85), 30, 'fabric'),
    rbox(0, D / 2 - back / 2, 120, W, back, 680, color, 45, 'fabric'),
    ...legs(W, D, 120, 70, 40, '#2d2a26', true),
  ]
  const left = -W / 2 + (arms[0] ? arm : 0)
  const right = W / 2 - (arms[1] ? arm : 0)
  const seatD = D - back
  const n = seats || Math.max(1, Math.round((right - left) / 700))
  const cw = (right - left) / n
  for (let i = 0; i < n; i++) {
    const x = left + (i + 0.5) * cw
    parts.push(rbox(x, -back / 2, 350, cw - 12, seatD - 10, 140, shade(color, 1.06), 45, 'fabric'))
    parts.push(rbox(x, D / 2 - back - 80, 480, cw - 40, 160, 380, shade(color, 1.12), 60, 'fabric'))
  }
  arms.forEach((on, k) => {
    if (on) parts.push(rbox((k ? 1 : -1) * (W / 2 - arm / 2), -back / 2 + 0.5, 120, arm, D - back + 1, 500, color, 50, 'fabric'))
  })
  return parts
}

/** L 型沙發:椅背在 +y 和 +x,貴妃位在右前方 */
function cornerSofa(W: number, D: number, color: string): Part[] {
  const depth = Math.min(950, D * 0.55)
  return lSofaWith(W, D, depth, color)
}

function lSofaWith(W: number, D: number, depth: number, color: string): Part[] {
  const parts = translateParts(sofaPro(W, depth, color, [true, false]), 0, D / 2 - depth / 2)
  const L = D - depth
  for (const p of sofaPro(L, depth, color, [false, true])) {
    const [x, y, z] = p.c
    const q = { ...p, c: [W / 2 - depth / 2 + y, -D / 2 + L / 2 - x, z] as [number, number, number] }
    if (q.kind === 'box') q.s = [q.s[1], q.s[0], q.s[2]]
    parts.push(q)
  }
  return parts
}

function beanbag(W: number, D: number, color: string): Part[] {
  return [cyl(0, 0, 0, 260, W / 2, W / 2.3, color, 1, D / W, 'fabric'), cyl(0, D * 0.15, 260, 300, W / 2.4, W / 4, color, 1, D / W * 0.8, 'fabric')]
}

function coffeeTable(W: number, D: number, color: string): Part[] {
  return [
    rbox(0, 0, 380, W, D, 45, color, 12, 'wood'),
    rbox(0, 0, 100, W - 100, D - 100, 25, shade(color, 0.85), 8, 'wood'),
    ...legs(W, D, 380, 45, 40, '#2d2a26', true),
    cyl(-W * 0.2, 0, 425, 90, 60, 45, '#e8e1d2', 1, 1, 'ceramic'), // 花瓶
    rbox(W * 0.18, -D * 0.1, 425, 280, 200, 30, '#33475b', 4, 'plastic'), // 書
  ]
}

function sideTable(W: number, D: number, color: string): Part[] {
  return [cyl(0, 0, 520, 30, W / 2, W / 2, color, 1, D / W, 'wood'), cyl(0, 0, 0, 520, 25, 25, '#2d2a26', 1, 1, 'metal'),
    cyl(0, 0, 0, 20, W * 0.3, W * 0.3, '#2d2a26', 1, 1, 'metal')]
}

function tvStand(W: number, D: number, color: string): Part[] {
  const parts = carcass(W, D, 450, color, { doors: Math.max(2, Math.round(W / 600)), handle: 'none', plinth: 0, z0: 120 })
  parts.push(...legs(W, D, 120, 60, 35, '#2d2a26', true))
  if (W >= 900) parts.push(...tvParts(Math.min(W * 0.72, 1450), 0, D / 2 - 140, 570, true))
  return parts
}

/** 電視:寬 W;stand = 放在櫃上(有底座),否則掛牆 */
function tvParts(W: number, x: number, y: number, z: number, stand: boolean): Part[] {
  const H = W * 9 / 16
  const parts: Part[] = [rbox(x, y, z + (stand ? 70 : 0), W, 40, H, DARK, 6, 'screen'),
    box(x, y - 21, z + (stand ? 70 : 0) + 15, W - 30, 2, H - 30, '#111317', { mat: 'screen' })]
  if (stand) parts.push(box(x, y, z, W * 0.3, 180, 15, DARK, { mat: 'metal' }), box(x, y + 10, z + 15, 60, 30, 70, DARK, { mat: 'metal' }))
  return parts
}

function tv(W: number, D: number): Part[] {
  return tvParts(W, 0, D / 2 - 20, 1050, false)
}

function rugPro(W: number, D: number, color: string): Part[] {
  return [rbox(0, 0, 0, W, D, 12, color, 4, 'fabric'), box(0, 0, 0, W - 160, D - 160, 14, shade(color, 0.88), { mat: 'fabric' })]
}

function shoeCabinet(W: number, D: number, color: string): Part[] {
  return carcass(W, D, 1000, color, { doors: Math.max(2, Math.round(W / 450)), handle: 'bar', plinth: 150 })
}

function floorLamp(W: number): Part[] {
  const r = Math.max(W / 2, 150)
  return [cyl(0, 0, 0, 25, r * 0.7, r * 0.7, '#2d2a26', 1, 1, 'metal'), cyl(0, 0, 25, 1300, 12, 12, '#c9a46a', 1, 1, 'metal'),
    cyl(0, 0, 1300, 320, r, r * 0.75, SHADE, 1, 1, 'fabric')]
}

function plant(W: number): Part[] {
  const r = W / 2
  const parts: Part[] = [cyl(0, 0, 0, r * 0.9, r * 0.55, r * 0.65, POT, 1, 1, 'ceramic'), cyl(0, 0, r * 0.9, 30, r * 0.62, r * 0.62, '#4a3a2c', 1, 1, 'stone')]
  const tall = W >= 650
  const levels = tall ? 4 : 3
  for (let i = 0; i < levels; i++) {
    const z = r * 0.9 + 150 + i * (tall ? 280 : 180)
    const rr = r * (1.05 - i * 0.15)
    parts.push(cyl(0, 0, z, tall ? 300 : 200, rr * 0.35, rr, shade(LEAF, 1 - i * 0.06), 1, 1, 'leaf'))
  }
  parts.push(cyl(0, 0, r * 0.9, levels * (tall ? 280 : 180), 15, 12, '#5a4632', 1, 1, 'wood'))
  return parts
}

function diningTable(W: number, D: number, color: string, round: boolean, chairs: number): Part[] {
  const parts: Part[] = []
  if (round) {
    parts.push(cyl(0, 0, 720, 35, W / 2, W / 2, color, 1, D / W, 'wood'), cyl(0, 0, 0, 720, 60, 45, '#2d2a26', 1, 1, 'metal'),
      cyl(0, 0, 0, 25, W * 0.25, W * 0.25, '#2d2a26', 1, 1, 'metal'))
  } else {
    parts.push(...tableTop(W, D, 755, color))
  }
  const c = '#cfc6b8'
  if (round) {
    for (let i = 0; i < chairs; i++) {
      const a = (2 * Math.PI * i) / chairs
      const dist = W / 2 + 130
      for (const p of rotateQuarter(chairPro(c), a)) parts.push({ ...p, c: [p.c[0] + Math.cos(a) * dist, p.c[1] + Math.sin(a) * dist, p.c[2]] as [number, number, number] })
    }
  } else {
    const per = Math.max(1, Math.round(chairs / 2))
    for (let i = 0; i < per; i++) {
      const x = -W / 2 + (i + 0.5) * W / per
      for (const side of [-1, 1]) parts.push(...rotateParts(chairPro(c), side > 0 ? 0 : 2, x, side * (D / 2 + 130)))
    }
  }
  return parts
}

/** 繞原點轉任意角度(只用在對稱的零件組,方塊不轉方向):椅背朝外 */
function rotateQuarter(parts: Part[], angle: number): Part[] {
  const q = Math.round((angle - Math.PI / 2) / (Math.PI / 2))
  return rotateParts(parts, q, 0, 0)
}

function island(W: number, D: number): Part[] {
  return [
    ...carcass(W, D - 200, 880, '#e9e5de', { doors: Math.round(W / 450), handle: 'bar', plinth: 80 }).map((p) => ({ ...p, c: [p.c[0], p.c[1] - 100, p.c[2]] as [number, number, number] })),
    rbox(0, 0, 880, W + 30, D, 40, '#f2f0ec', 6, 'stone'), // 石材檯面,後方懸挑當吧台
  ]
}

function barStool(W: number, color: string): Part[] {
  return [cyl(0, 0, 0, 20, W * 0.42, W * 0.42, '#2d2a26', 1, 1, 'metal'), cyl(0, 0, 20, 620, 22, 22, STEEL, 1, 1, 'metal'),
    cyl(0, 0, 300, 15, W * 0.35, W * 0.35, STEEL, 1, 1, 'metal'), cyl(0, 0, 640, 70, W / 2, W / 2, color, 1, 1, 'fabric')]
}

function kitchenCounter(W: number, D: number): Part[] {
  return [
    ...carcass(W, D, 860, '#e9e5de', { doors: Math.max(1, Math.round(W / 450)), handle: 'bar', plinth: 100 }),
    rbox(0, 0, 860, W + 20, D + 20, 40, '#3d3f44', 4, 'stone'),
  ]
}

function stove(W: number, D: number): Part[] {
  const parts: Part[] = [...kitchenCounter(W, D), rbox(0, 0, 900, W - 80, D - 80, 12, '#141517', 6, 'glass')]
  for (const dx of [-0.25, 0.25]) parts.push(cyl(dx * W, 0, 912, 15, Math.min(W, D) * 0.16, Math.min(W, D) * 0.16, '#3a3b3e', 1, 1, 'metal'))
  parts.push(rbox(0, D / 2 - 200, 1500, W, 400, 350, STEEL, 10, 'metal')) // 抽油煙機
  return parts
}

function kitchenSink(W: number, D: number): Part[] {
  return [...kitchenCounter(W, D), rbox(0, -20, 870, W * 0.7, D * 0.6, 30, STEEL, 20, 'metal'),
    cyl(0, D / 2 - 60, 900, 260, 15, 15, STEEL, 1, 1, 'metal'), box(0, D / 2 - 140, 1150, 30, 160, 25, STEEL, { mat: 'metal' })]
}

function fridge(W: number, D: number, color: string): Part[] {
  const H = W > 800 ? 1800 : 1750
  const parts: Part[] = [rbox(0, 0, 0, W, D, H, color, 25, 'metal')]
  const f = -D / 2 - 2
  if (W > 800) { // 對開門
    parts.push(box(0, f, 40, 4, 3, H - 80, shade(color, 0.7)))
    for (const s of [-1, 1]) parts.push(rbox(s * 40, f - 12, H * 0.45, 18, 20, 500, STEEL, 6, 'metal'))
  } else {
    parts.push(box(0, f, H * 0.62, W - 20, 3, 4, shade(color, 0.7)))
    parts.push(rbox(-W / 2 + 60, f - 12, H * 0.68, 18, 20, 350, STEEL, 6, 'metal'), rbox(-W / 2 + 60, f - 12, H * 0.25, 18, 20, 350, STEEL, 6, 'metal'))
  }
  return parts
}

function sideboard(W: number, D: number, color: string): Part[] {
  return [...carcass(W, D, 780, color, { doors: Math.max(2, Math.round(W / 450)), handle: 'bar', plinth: 0, z0: 120 }), ...legs(W, D, 120, 60, 35, '#2d2a26', true)]
}

function toilet(W: number, D: number): Part[] {
  return [
    rbox(0, D / 2 - 90, 380, W, 180, 400, CERAMIC, 40, 'ceramic'), // 水箱
    cyl(0, -D * 0.1, 0, 380, W * 0.32, W * 0.45, CERAMIC, 1, 1.35, 'ceramic'), // 馬桶本體
    cyl(0, -D * 0.1, 380, 30, W * 0.46, W * 0.46, CERAMIC, 1, 1.35, 'ceramic'), // 座圈
    rbox(0, D / 2 - 90, 780, 60, 30, 15, STEEL, 6, 'metal'),
  ]
}

function vanity(W: number, D: number): Part[] {
  const basins = W >= 1100 ? 2 : 1
  const parts: Part[] = [
    ...carcass(W, D, 820, '#eef1f3', { doors: basins * 2, handle: 'bar', plinth: 0, z0: 0 }),
    rbox(0, 0, 820, W + 20, D + 10, 30, CERAMIC, 8, 'ceramic'),
    rbox(0, D / 2 - 15, 1000, W * 0.9, 20, 800, '#dfe7ec', 30, 'glass'), // 鏡
  ]
  for (let i = 0; i < basins; i++) {
    const x = basins === 1 ? 0 : (i ? 1 : -1) * W / 4
    parts.push(rbox(x, -30, 850, 420, D * 0.6, 80, CERAMIC, 40, 'ceramic'), cyl(x, D / 2 - 90, 850, 220, 14, 14, STEEL, 1, 1, 'metal'))
  }
  return parts
}

function shower(W: number, D: number): Part[] {
  const H = 2000
  return [
    rbox(0, 0, 0, W, D, 60, CERAMIC, 15, 'ceramic'), // 淋浴盤
    box(0, -D / 2 + 5, 60, W, 10, H, '#cfe3ec', { opacity: 0.3 }), // 玻璃門
    box(-W / 2 + 5, 0, 60, 10, D, H, '#cfe3ec', { opacity: 0.3 }),
    box(0, -D / 2 + 5, H + 40, W, 30, 30, STEEL, { mat: 'metal' }),
    cyl(W / 2 - 120, D / 2 - 60, 60, 1900, 14, 14, STEEL, 1, 1, 'metal'),
    cyl(W / 2 - 120, D / 2 - 160, 1950, 20, 120, 120, STEEL, 1, 1, 'metal'), // 花灑
  ]
}

function bathtubPro(W: number, D: number): Part[] {
  return [rbox(0, 0, 0, W, D, 560, CERAMIC, 60, 'ceramic'), rbox(0, 0, 450, W - 140, D - 140, 112, '#e9eef0', 120, 'ceramic'),
    box(0, 0, 520, W - 200, D - 200, 6, WATER, { opacity: 0.7, mat: 'glass' }), cyl(-W / 2 + 90, 0, 560, 160, 15, 15, STEEL, 1, 1, 'metal')]
}

function washer(W: number, D: number, dryer = false): Part[] {
  const r = W * 0.3
  return [
    rbox(0, 0, 0, W, D, 850, '#f4f5f6', 25, 'plastic'),
    box(0, -D / 2 - 12, 380 - r, 2 * r, 24, 2 * r, dryer ? '#3a3b3e' : '#7c8794', { round: r * 0.95, mat: 'glass' }), // 圓形門
    rbox(0, -D / 2 - 2, 740, W - 60, 6, 80, '#d8dbe0', 4, 'plastic'),
  ]
}

function waterHeater(W: number, D: number): Part[] {
  return [rbox(0, 0, 1500, W, D, D, '#f4f4f2', D * 0.45, 'plastic'), box(0, D / 2 - 10, 1500, W * 0.8, 20, 20, STEEL, { mat: 'metal' })]
}

function airconFloor(W: number, D: number): Part[] {
  return [rbox(0, 0, 0, W, D, 1800, '#f6f7f8', 30, 'plastic'), box(0, -D / 2 - 2, 1300, W - 80, 4, 350, '#c9cdd2', { mat: 'plastic' })]
}

function airconWall(W: number, D: number): Part[] {
  return [rbox(0, 0, 2200, W, D, 300, '#f6f7f8', 40, 'plastic'), box(0, -D / 2 + 20, 2200, W - 100, 30, 40, '#c9cdd2', { mat: 'plastic' })]
}

function dishwasher(W: number, D: number): Part[] {
  return [...kitchenCounter(W, D), box(0, -D / 2 - 3, 100, W - 20, 6, 740, STEEL, { mat: 'metal' }), rbox(0, -D / 2 - 15, 780, W - 120, 20, 20, '#7d8188', 6, 'metal')]
}

function ovenColumn(W: number, D: number, color: string): Part[] {
  return [
    ...carcass(W, D, 2200, color, { doors: 1, handle: 'bar', plinth: 80 }),
    rbox(0, -D / 2 - 3, 1000, W - 60, 10, 580, '#1a1b1d', 8, 'glass'), // 蒸烤箱
    rbox(0, -D / 2 - 15, 1520, W - 140, 20, 20, STEEL, 6, 'metal'),
  ]
}

function purifier(W: number, D: number): Part[] {
  return [rbox(0, 0, 0, W, D, 700, '#f4f4f2', 60, 'plastic'), cyl(0, 0, 700, 10, W * 0.3, W * 0.3, '#c9cdd2', 1, 1, 'plastic')]
}

function officeChair(W: number, color: string): Part[] {
  const parts: Part[] = []
  for (let i = 0; i < 5; i++) {
    const a = (2 * Math.PI * i) / 5
    parts.push(box(Math.cos(a) * W * 0.22, Math.sin(a) * W * 0.22, 60, W * 0.44, 40, 30, '#2d2a26', { rz: (a * 180) / Math.PI, mat: 'metal' }))
    parts.push(cyl(Math.cos(a) * W * 0.42, Math.sin(a) * W * 0.42, 0, 60, 25, 25, '#1c1c1e', 1, 1, 'plastic'))
  }
  parts.push(cyl(0, 0, 90, 340, 25, 25, STEEL, 1, 1, 'metal'), rbox(0, 0, 430, W * 0.78, W * 0.75, 80, color, 30, 'fabric'),
    rbox(0, W * 0.36, 500, W * 0.7, 60, 600, color, 40, 'fabric'))
  for (const s of [-1, 1]) parts.push(rbox(s * W * 0.38, 0, 600, 50, W * 0.45, 30, '#2d2a26', 10, 'plastic'))
  return parts
}

function piano(W: number, D: number, color: string): Part[] {
  return [
    rbox(0, D * 0.15, 0, W, D * 0.7, 1250, color, 15, 'ceramic'),
    box(0, -D * 0.2, 650, W - 100, D * 0.35, 120, color, { mat: 'ceramic' }),
    box(0, -D * 0.18, 770, W - 140, D * 0.25, 20, '#f7f7f5', { mat: 'plastic' }), // 白鍵
    ...legs(W - 100, D * 0.3, 650, 40, 60, color).map((p) => ({ ...p, c: [p.c[0], p.c[1] - D * 0.25, p.c[2]] as [number, number, number] })),
  ]
}

function treadmill(W: number, D: number): Part[] {
  return [
    rbox(0, 0, 0, W, D, 180, '#3a3a3c', 30, 'plastic'),
    box(0, 0, 180, W - 120, D - 300, 8, '#1c1c1e', { mat: 'fabric' }),
    ...[-1, 1].map((s) => box(s * (W / 2 - 40), D / 2 - 200, 180, 50, 60, 1050, '#3a3a3c', { mat: 'metal' })),
    rbox(0, D / 2 - 220, 1180, W, 200, 160, '#2d2d30', 20, 'screen'),
  ]
}

function baycushion(W: number, D: number, color: string): Part[] {
  return [rbox(0, 0, 450, W, D, 90, color, 30, 'fabric'), rbox(0, D / 2 - 120, 540, W * 0.3, 200, 300, shade(color, 1.1), 60, 'fabric')]
}

/** 家具庫:側欄的分類與預設尺寸(寬 = 正面那一邊,深 = 前後) */
export interface LibraryItem { type: string; name: string; w: number; d: number; color: string; options?: Record<string, number | boolean> }
export const LIBRARY: { cat: string; items: LibraryItem[] }[] = [
  { cat: '臥室', items: [
    { type: 'bed', name: '雙人床 1.8m', w: 1800, d: 2000, color: '#c9d6df' },
    { type: 'bed', name: '雙人床 1.5m', w: 1500, d: 2000, color: '#d8c7dc' },
    { type: 'bed', name: '單人床', w: 1050, d: 1900, color: '#e8d5b5' },
    { type: 'crib', name: '嬰兒床', w: 1250, d: 700, color: '#efe3d0' },
    { type: 'nightstand', name: '床頭櫃', w: 450, d: 400, color: '#e8dccb' },
    { type: 'wardrobe', name: '衣櫃', w: 2000, d: 600, color: '#efe6d8' },
    { type: 'wardrobe', name: '小衣櫃', w: 1200, d: 550, color: '#efe6d8' },
    { type: 'dresser', name: '梳妝台', w: 1000, d: 450, color: '#efe6d8' },
    { type: 'baycushion', name: '臥榻 / 窗台墊', w: 1800, d: 520, color: '#e7dccd' },
  ] },
  { cat: '客廳', items: [
    { type: 'sofa', name: '三人沙發', w: 2400, d: 900, color: '#b7c4b0' },
    { type: 'sofa', name: '雙人沙發', w: 1700, d: 880, color: '#c3cbd6' },
    { type: 'corner_sofa', name: 'L 型沙發', w: 2800, d: 1700, color: '#b7c4b0' },
    { type: 'armchair', name: '單人沙發', w: 850, d: 850, color: '#d6b99a' },
    { type: 'beanbag', name: '懶骨頭', w: 800, d: 800, color: '#e0b98f' },
    { type: 'low_table', name: '茶几', w: 1300, d: 650, color: '#e8dccb' },
    { type: 'side_table', name: '邊几', w: 500, d: 500, color: '#d9c3a3' },
    { type: 'tv_stand', name: '電視櫃', w: 2400, d: 400, color: '#e2cfb4' },
    { type: 'rug', name: '地毯', w: 2400, d: 1700, color: '#d9cbb8' },
    { type: 'shoe_cabinet', name: '鞋櫃', w: 1000, d: 350, color: '#efe6d8' },
    { type: 'lamp', name: '立燈', w: 450, d: 450, color: '#3d3a34' },
    { type: 'plant', name: '盆栽', w: 500, d: 500, color: '#a9c39b' },
    { type: 'plant', name: '大盆栽', w: 700, d: 700, color: '#9dbb8c' },
  ] },
  { cat: '餐廚', items: [
    { type: 'table', name: '四人餐桌', w: 1400, d: 800, color: '#e2cfb4', options: { chairs: 4 } },
    { type: 'table', name: '六人餐桌', w: 1800, d: 900, color: '#d8c2a2', options: { chairs: 6 } },
    { type: 'round_table', name: '圓桌', w: 1000, d: 1000, color: '#e2cfb4', options: { chairs: 4 } },
    { type: 'chair', name: '餐椅', w: 450, d: 480, color: '#cfc6b8' },
    { type: 'island', name: '中島', w: 1800, d: 900, color: '#e9e5de' },
    { type: 'bar_stool', name: '吧檯椅', w: 420, d: 420, color: '#6b5d4c' },
    { type: 'counter', name: '流理台', w: 1600, d: 600, color: '#e9e5de' },
    { type: 'stove', name: '瓦斯爐 / 爐台', w: 750, d: 600, color: '#dcdcdc' },
    { type: 'kitchen_sink', name: '水槽', w: 800, d: 600, color: '#e1e6ea' },
    { type: 'fridge', name: '冰箱', w: 700, d: 700, color: '#dfe4e8' },
    { type: 'sideboard', name: '餐邊櫃', w: 1600, d: 400, color: '#efe6d8' },
  ] },
  { cat: '衛浴', items: [
    { type: 'toilet', name: '馬桶', w: 400, d: 700, color: '#ffffff' },
    { type: 'vanity', name: '浴櫃', w: 800, d: 500, color: '#eef1f3' },
    { type: 'vanity', name: '雙盆浴櫃', w: 1200, d: 500, color: '#eef1f3' },
    { type: 'shower', name: '淋浴間', w: 900, d: 900, color: '#e4edf2' },
    { type: 'bathtub', name: '浴缸', w: 1600, d: 750, color: '#eef3f6' },
    { type: 'washer', name: '洗衣機', w: 600, d: 600, color: '#e6ebee' },
    { type: 'water_heater', name: '電熱水器', w: 800, d: 450, color: '#f4f4f2' },
    { type: 'cabinet', name: '儲物櫃', w: 1000, d: 400, color: '#efe6d8' },
  ] },
  { cat: '家電', items: [
    { type: 'tv', name: '65 吋電視', w: 1450, d: 80, color: '#1d1d1f' },
    { type: 'tv', name: '55 吋電視', w: 1230, d: 80, color: '#1d1d1f' },
    { type: 'fridge', name: '對開門冰箱', w: 910, d: 700, color: '#c9ced3' },
    { type: 'aircon', name: '落地冷氣', w: 500, d: 380, color: '#f6f7f8' },
    { type: 'aircon_wall', name: '壁掛冷氣', w: 900, d: 250, color: '#f6f7f8' },
    { type: 'dishwasher', name: '洗碗機', w: 600, d: 600, color: '#c9ced3' },
    { type: 'oven_column', name: '蒸烤箱高櫃', w: 600, d: 600, color: '#efe6d8' },
    { type: 'dryer', name: '烘衣機', w: 600, d: 600, color: '#e6ebee' },
    { type: 'purifier', name: '空氣清淨機', w: 400, d: 300, color: '#f4f4f2' },
  ] },
  { cat: '書房 · 休閒', items: [
    { type: 'desk', name: '書桌', w: 1200, d: 600, color: '#e2cfb4' },
    { type: 'desk', name: '長書桌', w: 1600, d: 700, color: '#d8c2a2' },
    { type: 'office_chair', name: '辦公椅', w: 620, d: 620, color: '#4a4f55' },
    { type: 'bookshelf', name: '書架', w: 800, d: 300, color: '#e2cfb4' },
    { type: 'bookshelf', name: '大書架', w: 1600, d: 350, color: '#e2cfb4' },
    { type: 'piano', name: '直立式鋼琴', w: 1500, d: 600, color: '#1f1d1b' },
    { type: 'treadmill', name: '跑步機', w: 800, d: 1800, color: '#3a3a3c' },
    { type: 'armchair', name: '閱讀椅', w: 750, d: 800, color: '#c9a98a' },
  ] },
]

type Builder = (W: number, D: number, color: string, opt: Record<string, number | boolean>) => Part[]
/** 新增的家具種類(舊的種類保留,辨識結果會用到) */
export const EXTRA: Record<string, { name: string; build: Builder }> = {
  crib: { name: '嬰兒床', build: (W, D, c) => crib(W, D, c) },
  nightstand: { name: '床頭櫃', build: (W, D, c) => nightstand(W, D, c) },
  dresser: { name: '梳妝台', build: (W, D, c) => dresser(W, D, c) },
  desk: { name: '書桌', build: (W, D, c) => desk(W, D, c) },
  chair: { name: '椅子', build: (_W, _D, c) => chairPro(c) },
  bookshelf: { name: '書架', build: (W, D, c) => bookshelf(W, D, c) },
  baycushion: { name: '臥榻', build: (W, D, c) => baycushion(W, D, c) },
  corner_sofa: { name: 'L 型沙發', build: (W, D, c) => cornerSofa(W, D, c) },
  armchair: { name: '單人沙發', build: (W, D, c) => armchair(W, D, c) },
  beanbag: { name: '懶骨頭', build: (W, D, c) => beanbag(W, D, c) },
  side_table: { name: '邊几', build: (W, D, c) => sideTable(W, D, c) },
  tv_stand: { name: '電視櫃', build: (W, D, c) => tvStand(W, D, c) },
  shoe_cabinet: { name: '鞋櫃', build: (W, D, c) => shoeCabinet(W, D, c) },
  plant: { name: '盆栽', build: (W) => plant(W) },
  round_table: { name: '圓桌', build: (W, D, c, o) => diningTable(W, D, c, true, Number(o.chairs ?? 4)) },
  island: { name: '中島', build: (W, D) => island(W, D) },
  bar_stool: { name: '吧檯椅', build: (W, _D, c) => barStool(W, c) },
  stove: { name: '爐台', build: (W, D) => stove(W, D) },
  kitchen_sink: { name: '水槽', build: (W, D) => kitchenSink(W, D) },
  fridge: { name: '冰箱', build: (W, D, c) => fridge(W, D, c) },
  sideboard: { name: '餐邊櫃', build: (W, D, c) => sideboard(W, D, c) },
  toilet: { name: '馬桶', build: (W, D) => toilet(W, D) },
  vanity: { name: '浴櫃', build: (W, D) => vanity(W, D) },
  shower: { name: '淋浴間', build: (W, D) => shower(W, D) },
  bathtub: { name: '浴缸', build: (W, D) => bathtubPro(W, D) },
  washer: { name: '洗衣機', build: (W, D) => washer(W, D) },
  dryer: { name: '烘衣機', build: (W, D) => washer(W, D, true) },
  water_heater: { name: '電熱水器', build: (W, D) => waterHeater(W, D) },
  tv: { name: '電視', build: (W, D) => tv(W, D) },
  aircon: { name: '落地冷氣', build: (W, D) => airconFloor(W, D) },
  aircon_wall: { name: '壁掛冷氣', build: (W, D) => airconWall(W, D) },
  dishwasher: { name: '洗碗機', build: (W, D) => dishwasher(W, D) },
  oven_column: { name: '蒸烤箱高櫃', build: (W, D, c) => ovenColumn(W, D, c) },
  purifier: { name: '空氣清淨機', build: (W, D) => purifier(W, D) },
  office_chair: { name: '辦公椅', build: (W, _D, c) => officeChair(W, c) },
  piano: { name: '鋼琴', build: (W, D, c) => piano(W, D, c) },
  treadmill: { name: '跑步機', build: (W, D) => treadmill(W, D) },
}

/** 家具型錄:type → 中文名稱 + 模型產生器 */
export const CATALOG: Record<string, { name: string; build: Builder }> = {
  bed: { name: '床', build: (W, D, c) => bedPro(W, D, c) },
  sofa: { name: '沙發', build: (W, D, c, o) => (o.l_depth ? lSofaWith(W, D, Number(o.l_depth), c) : sofaPro(W, D, c)) },
  table: { name: '餐桌椅', build: (W, D, c, o) => (o.chairs ? diningTable(W, D, c, false, Number(o.chairs)) : dining(W, D, c, Boolean(o.oval))) },
  low_table: { name: '茶几', build: (W, D, c) => coffeeTable(W, D, c) },
  wardrobe: { name: '衣櫃', build: (W, D, c) => carcass(W, D, 2050, c, { doors: Math.max(2, Math.round(W / 500)), handle: 'bar', plinth: 60 }) },
  cabinet: { name: '櫃子', build: (W, D, c) => cabinet(W, D, c) },
  counter: { name: '流理台', build: (W, D, _c, o) => (o.stove ? stove(W, D) : kitchenCounter(W, D)) },
  fixture: { name: '設備(衛浴/家電)', build: (W, D, _c, o) => (o.bluish ? bathtubPro(W, D) : appliance(W, D)) },
  lamp: { name: '立燈', build: (W) => floorLamp(W) },
  rug: { name: '地毯', build: (W, D, c) => rugPro(W, D, c) },
  ...EXTRA,
  other: { name: '其他', build: (W, D, c) => [rbox(0, 0, 0, W, D, 700, c, 10)] },
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
