// Scene JSON 的型別,必須跟 backend/floorplan/scene.py 保持一致。
// 單位 mm;模型座標 x 向右、y 向上,原點在原圖左下角;角度單位是度、逆時針為正。

export type Point = [number, number]

/** 一段直牆:中心線 a→b,厚度往兩側各一半 */
export interface Wall {
  id: string
  a: Point
  b: Point
  thickness: number
  height: number
}

/** 掛在牆上的門、窗、開放通道。offset = 開口中心離牆起點 a 的距離 */
export interface Opening {
  id: string
  wall: string
  kind: 'door' | 'window' | 'passage'
  offset: number
  width: number
  sill: number
  head: number
  leaves: number
  /** 門往哪側開:+1 = 從 a 往 b 看的左手邊,-1 = 右手邊 */
  swing: 1 | -1
  /** 單開門的鉸鏈在 a 端 (start) 或 b 端 (end) */
  hinge: 'start' | 'end'
  exterior: boolean
}

export interface Room {
  id: string
  name: string
  polygon: Point[]
  area: number
  floor_color: string
}

/** 家具:(x, y) 是外框中心,angle 是局部 +x 的方向;局部 +y 指向背面(靠牆那側) */
export interface Furniture {
  id: string
  type: string
  x: number
  y: number
  angle: number
  width: number
  depth: number
  color: string
  options: Record<string, number | boolean>
}

export interface Background {
  src: string
  width: number
  height: number
}

export interface Scene {
  version: number
  meta: {
    mm_per_px: number
    wall_height: number
    wall_thickness: number
    background: Background | null
  }
  walls: Wall[]
  openings: Opening[]
  rooms: Room[]
  furniture: Furniture[]
}

export type LayerRole = 'wall' | 'door' | 'window' | 'furniture' | 'text' | 'other' | 'ignore'

export interface CadLayer {
  name: string
  count: number
  role: LayerRole
}

export interface RecognizeResponse {
  scene: Scene
  overlay: string
  log: string[]
  /** AutoCAD 檔才有:各圖層與判定的角色 */
  cad: { layers: CadLayer[] } | null
}
