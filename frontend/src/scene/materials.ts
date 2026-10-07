// 地板材質型錄。紋理用 canvas 程式畫出來(不用下載圖檔、沒有授權問題),同一個材質只畫一次。
// size = 一張紋理在模型裡涵蓋的實際尺寸 mm(例如一片 60 cm 磁磚),UV 依世界座標計算,所以不會因房間大小變形。
import * as THREE from 'three'

export interface FloorMaterial {
  name: string
  /** 2D 平面圖上的代表色 */
  swatch: string
  size: [number, number]
  roughness: number
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) => void
}

/** 固定種子的亂數:每次畫出來都一樣 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function shade(hex: string, k: number) {
  const c = new THREE.Color(hex)
  c.offsetHSL(0, 0, k)
  return '#' + c.getHexString()
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number, n: number, alpha: number, size = 2) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${alpha * rnd()})` : `rgba(255,255,255,${alpha * rnd()})`
    ctx.fillRect(rnd() * w, rnd() * h, size, size)
  }
}

/** 木地板:一排排長條地板,每片顏色略有差異,加上木紋和接縫 */
function planks(base: string, rows: number) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) => {
    const rh = h / rows
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * w * 0.6
      while (x < w) {
        const len = w * (0.35 + rnd() * 0.45)
        ctx.fillStyle = shade(base, (rnd() - 0.5) * 0.08)
        ctx.fillRect(x, r * rh, len, rh)
        // 木紋:幾條細的波浪線
        for (let g = 0; g < 7; g++) {
          ctx.strokeStyle = `rgba(60,35,15,${0.05 + rnd() * 0.08})`
          ctx.lineWidth = 0.6 + rnd() * 1.2
          ctx.beginPath()
          const y0 = r * rh + rnd() * rh
          ctx.moveTo(x, y0)
          for (let t = 0; t <= 1; t += 0.1) ctx.lineTo(x + len * t, y0 + Math.sin(t * 6 + g) * rh * 0.06)
          ctx.stroke()
        }
        ctx.fillStyle = 'rgba(40,25,10,.45)'
        ctx.fillRect(x, r * rh, 2, rh) // 短邊接縫
        x += len
      }
      ctx.fillStyle = 'rgba(40,25,10,.5)'
      ctx.fillRect(0, r * rh, w, 2) // 長邊接縫
    }
    noise(ctx, w, h, rnd, 4000, 0.06)
  }
}

/** 磁磚:一片磁磚加四周的填縫 */
function tile(base: string, grout: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) => {
    ctx.fillStyle = grout
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = base
    ctx.fillRect(3, 3, w - 6, h - 6)
    noise(ctx, w, h, rnd, 3000, 0.05)
  }
}

function marble(ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) {
  ctx.fillStyle = '#ece8e1'
  ctx.fillRect(0, 0, w, h)
  for (let v = 0; v < 9; v++) {
    let x = rnd() * w, y = rnd() * h
    const ang = rnd() * Math.PI
    ctx.strokeStyle = `rgba(110,105,100,${0.08 + rnd() * 0.18})`
    ctx.lineWidth = 0.8 + rnd() * 2.5
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let i = 0; i < 60; i++) {
      x += Math.cos(ang + (rnd() - 0.5) * 1.6) * 14
      y += Math.sin(ang + (rnd() - 0.5) * 1.6) * 14
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  noise(ctx, w, h, rnd, 3000, 0.04)
  ctx.fillStyle = 'rgba(120,115,110,.35)' // 石材接縫(每張紋理 = 2×2 片)
  ctx.fillRect(0, 0, w, 1.5)
  ctx.fillRect(0, h / 2, w, 1.5)
  ctx.fillRect(0, 0, 1.5, h)
  ctx.fillRect(w / 2, 0, 1.5, h)
}

function concrete(ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) {
  ctx.fillStyle = '#b9b6b0'
  ctx.fillRect(0, 0, w, h)
  for (let i = 0; i < 260; i++) {
    const r = 10 + rnd() * 60
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
    const c = rnd() < 0.5 ? '0,0,0' : '255,255,255'
    g.addColorStop(0, `rgba(${c},${0.03 + rnd() * 0.04})`)
    g.addColorStop(1, `rgba(${c},0)`)
    ctx.save()
    ctx.translate(rnd() * w, rnd() * h)
    ctx.fillStyle = g
    ctx.fillRect(-r, -r, 2 * r, 2 * r)
    ctx.restore()
  }
  noise(ctx, w, h, rnd, 9000, 0.08, 1.5)
}

function carpet(base: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) => {
    ctx.fillStyle = base
    ctx.fillRect(0, 0, w, h)
    noise(ctx, w, h, rnd, 30000, 0.12, 1.5)
  }
}

export const FLOOR_MATERIALS: Record<string, FloorMaterial> = {
  oak: { name: '橡木地板', swatch: '#c9a479', size: [1200, 1080], roughness: 0.6, draw: planks('#c49a6c', 6) },
  walnut: { name: '胡桃木地板', swatch: '#7a5638', size: [1200, 1080], roughness: 0.55, draw: planks('#77512f', 6) },
  ash: { name: '白橡淺木地板', swatch: '#ddc9a8', size: [1200, 1080], roughness: 0.65, draw: planks('#dcc6a2', 6) },
  tile_white: { name: '白色磁磚 60×60', swatch: '#ecebe7', size: [600, 600], roughness: 0.35, draw: tile('#eeede9', '#c9c6c0') },
  tile_gray: { name: '灰色磁磚 60×60', swatch: '#a9a7a3', size: [600, 600], roughness: 0.4, draw: tile('#a9a7a2', '#8a8883') },
  tile_small: { name: '小磁磚 30×30', swatch: '#d9dfe2', size: [300, 300], roughness: 0.3, draw: tile('#dae0e3', '#b5bcbf') },
  marble: { name: '大理石', swatch: '#e8e4dd', size: [1200, 1200], roughness: 0.2, draw: marble },
  concrete: { name: '清水模 / 水泥', swatch: '#b5b2ac', size: [1500, 1500], roughness: 0.85, draw: concrete },
  carpet: { name: '灰色地毯', swatch: '#8f9298', size: [500, 500], roughness: 1, draw: carpet('#8d9097') },
}

/** 房間沒指定材質時,依名稱挑一個合理的 */
export function autoFloor(roomName: string): string {
  if (/衛|卫|浴|廁|厕|bath|wc|toilet|洗/i.test(roomName)) return 'tile_small'
  if (/廚|厨|kitchen/i.test(roomName)) return 'tile_gray'
  if (/陽台|阳台|balcony|露台|玄關|entry/i.test(roomName)) return 'tile_white'
  if (/儲藏|storage|車庫|garage/i.test(roomName)) return 'concrete'
  return 'oak'
}

export function floorMaterialId(room: { name: string; floor_material?: string | null }): string {
  const id = room.floor_material
  return id && FLOOR_MATERIALS[id] ? id : autoFloor(room.name)
}

const textureCache = new Map<string, THREE.CanvasTexture>()

export function floorTexture(id: string): THREE.CanvasTexture {
  let tex = textureCache.get(id)
  if (tex) return tex
  const m = FLOOR_MATERIALS[id] ?? FLOOR_MATERIALS.oak
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = Math.round((1024 * m.size[1]) / m.size[0])
  m.draw(canvas.getContext('2d')!, canvas.width, canvas.height, rng(id.length * 7919 + id.charCodeAt(0)))
  tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  textureCache.set(id, tex)
  return tex
}
