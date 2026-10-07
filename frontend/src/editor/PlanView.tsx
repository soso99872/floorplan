// 2D 平面編輯視圖(SVG)。模型座標 mm、y 向上;畫面用一個 y 翻轉的 <g> 直接畫 mm,文字另外畫在螢幕座標。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import polygonClipping, { type Polygon } from 'polygon-clipping'
import type { Opening, Point, Scene, Wall } from '../scene/types'
import { CATALOG } from '../scene/catalog'
import { FLOOR_MATERIALS, floorMaterialId } from '../scene/materials'
import {
  addFurniture, addOpening, addWall, moveEndpoint, moveOpening, moveWall, updateFurniture, type Sel,
} from './commands'
import {
  add, centroid, dist, distToWall, dot, furnitureCorners, mul, openingCenter, project, sceneBounds, strip, sub,
  wallFrame,
} from './geometry'
import type { Editor } from './store'

export type Tool = 'select' | 'wall' | 'door' | 'window' | 'passage' | 'furniture' | 'measure'

interface Props {
  editor: Editor
  tool: Tool
  furnitureType: string
  /** 換了新的場景(載入、開檔)時改變,畫面會重新縮放到整張圖 */
  fitKey: number
  onTool: (t: Tool) => void
  onMeasure: (a: Point, b: Point) => void
}

interface View { cx: number; cy: number; k: number }

type Drag =
  | { mode: 'pan'; sx: number; sy: number; view: View }
  | { mode: 'endpoint'; base: Scene; id: string; end: 'a' | 'b'; key: string }
  | { mode: 'wall'; base: Scene; id: string; start: Point; key: string }
  | { mode: 'opening'; base: Scene; id: string; key: string }
  | { mode: 'furniture'; base: Scene; id: string; start: Point; key: string }
  | { mode: 'rotate'; base: Scene; id: string; key: string }

const SNAP_PX = 12
const GRID_MM = 10
const ORTHO_DEG = 6
let dragSeq = 0

/** 向量是否接近水平或垂直 */
function isOrtho(d: Point) {
  const ang = Math.abs((Math.atan2(d[1], d[0]) * 180) / Math.PI) % 90
  return ang < ORTHO_DEG || ang > 90 - ORTHO_DEG
}

const pts = (p: Point[]) => p.map(([x, y]) => `${x},${y}`).join(' ')
const ring = (p: Point[]): [number, number][] => [...p, p[0]].map(([x, y]) => [x, y])

export function PlanView({ editor, tool, furnitureType, fitKey, onTool, onMeasure }: Props) {
  const { scene, sel } = editor
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState<View>({ cx: 5000, cy: 5000, k: 0.05 })
  const [hover, setHover] = useState<Point | null>(null)
  const [chain, setChain] = useState<Point | null>(null) // 畫牆:上一個點
  const [measureA, setMeasureA] = useState<Point | null>(null)
  const drag = useRef<Drag | null>(null)

  // 視窗大小
  useLayoutEffect(() => {
    const el = svgRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 新場景:縮放到整張圖
  useEffect(() => {
    if (!scene) return
    const b = sceneBounds(scene)
    const k = Math.min(size.w / (b.x1 - b.x0 + 1), size.h / (b.y1 - b.y0 + 1)) * 0.9
    setView({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, k })
    // size 刻意不放進相依:只有換場景時重新縮放,不因為拉視窗大小跳動
  }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 換工具時清掉進行到一半的動作
  useEffect(() => { setChain(null); setMeasureA(null) }, [tool])

  // Esc:結束畫牆 / 量尺
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setChain(null); setMeasureA(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 滾輪縮放(以游標為中心);要能 preventDefault,不能用 React 的 onWheel
  useEffect(() => {
    const el = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setView((v) => {
        const sx = e.clientX - r.left, sy = e.clientY - r.top
        const mx = (sx - size.w / 2) / v.k + v.cx, my = v.cy - (sy - size.h / 2) / v.k
        const k = Math.min(5, Math.max(0.002, v.k * Math.pow(1.0015, -e.deltaY)))
        return { k, cx: mx - (sx - size.w / 2) / k, cy: my + (sy - size.h / 2) / k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [size])

  const toModel = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left - size.w / 2) / view.k + view.cx, view.cy - (e.clientY - r.top - size.h / 2) / view.k]
  }
  const toScreen = (p: Point): Point => [(p[0] - view.cx) * view.k + size.w / 2, size.h / 2 - (p[1] - view.cy) * view.k]

  /** 吸附:牆端點 → 牆中心線 → 水平/垂直(相對 ref)→ 10 mm 格點 */
  function snap(p: Point, ref?: Point | null, skipWall?: string): Point {
    if (!scene) return p
    const tol = SNAP_PX / view.k
    let best: Point | null = null, bestD = tol
    for (const w of scene.walls) {
      if (w.id === skipWall) continue
      for (const q of [w.a, w.b]) {
        const d = dist(p, q)
        // 畫牆時,吸到端點會讓牆歪掉的話,只有游標幾乎正對端點才吸
        if (ref && !isOrtho(sub(q, ref)) && d > tol / 3) continue
        if (d < bestD) { best = q; bestD = d }
      }
    }
    if (best) return best
    if (ref) {
      const d = sub(p, ref)
      const ang = Math.abs((Math.atan2(d[1], d[0]) * 180) / Math.PI) % 90
      if (ang < ORTHO_DEG) p = [p[0], ref[1]]
      else if (ang > 90 - ORTHO_DEG) p = [ref[0], p[1]]
    }
    for (const w of scene.walls) {
      if (w.id === skipWall) continue
      if (distToWall(w, p) < tol) {
        const { along } = project(w, p)
        const { u } = wallFrame(w)
        const onLine = add(w.a, mul(u, along))
        // 保留水平/垂直的那個座標,只把另一個座標吸到牆上
        if (ref && (p[0] === ref[0] || p[1] === ref[1])) {
          if (Math.abs(u[0]) > 0.99 && p[0] === ref[0]) return [p[0], onLine[1]]
          if (Math.abs(u[1]) > 0.99 && p[1] === ref[1]) return [onLine[0], p[1]]
        }
        return onLine
      }
    }
    return [Math.round(p[0] / GRID_MM) * GRID_MM, Math.round(p[1] / GRID_MM) * GRID_MM]
  }

  function nearestWall(p: Point): Wall | null {
    if (!scene) return null
    let best: Wall | null = null, bestD = Infinity
    for (const w of scene.walls) {
      const d = distToWall(w, p)
      if (d < Math.max(w.thickness * 1.5, SNAP_PX / view.k) && d < bestD) { best = w; bestD = d }
    }
    return best
  }

  // ---------- 滑鼠 ----------

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!scene) return
    const p = toModel(e)
    const el = e.target as Element
    const target = el.closest('[data-kind]') as SVGElement | null
    const kind = target?.dataset.kind as Sel['kind'] | 'handle' | undefined
    const id = target?.dataset.id ?? ''
    try { svgRef.current!.setPointerCapture(e.pointerId) } catch { /* 合成事件沒有真的指標,拖到外面就收不到,不影響 */ }

    if (e.button === 1 || e.button === 2 || (tool === 'select' && !kind)) {
      if (e.button === 2 && tool === 'wall') { setChain(null); return }
      if (tool === 'select' && e.button === 0) editor.select(null)
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, view }
      return
    }
    if (e.button !== 0) return
    const key = `drag${++dragSeq}`

    switch (tool) {
      case 'select': {
        if (kind === 'handle') {
          const h = target!.dataset.handle!
          if (h === 'rotate') drag.current = { mode: 'rotate', base: scene, id, key }
          else drag.current = { mode: 'endpoint', base: scene, id, end: h as 'a' | 'b', key }
          return
        }
        if (!kind) return
        editor.select({ kind, id })
        if (kind === 'wall') drag.current = { mode: 'wall', base: scene, id, start: p, key }
        else if (kind === 'opening') drag.current = { mode: 'opening', base: scene, id, key }
        else if (kind === 'furniture') drag.current = { mode: 'furniture', base: scene, id, start: p, key }
        return
      }
      case 'wall': {
        const q = snap(p, chain)
        if (chain && dist(chain, q) > 50) {
          const r = addWall(scene, chain, q)
          editor.apply(r.scene)
        }
        setChain(q)
        return
      }
      case 'door': case 'window': case 'passage': {
        const w = nearestWall(p)
        if (!w) return
        const r = addOpening(scene, w.id, project(w, p).along, tool)
        editor.apply(r.scene)
        editor.select({ kind: 'opening', id: r.id })
        return
      }
      case 'furniture': {
        const r = addFurniture(scene, furnitureType, snap(p))
        editor.apply(r.scene)
        editor.select({ kind: 'furniture', id: r.id })
        onTool('select')
        return
      }
      case 'measure': {
        const q = snap(p, measureA)
        if (!measureA) setMeasureA(q)
        else { onMeasure(measureA, q); setMeasureA(null); onTool('select') }
        return
      }
    }
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = toModel(e)
    setHover(p)
    const d = drag.current
    if (!d) return
    switch (d.mode) {
      case 'pan':
        setView({ ...d.view, cx: d.view.cx - (e.clientX - d.sx) / d.view.k, cy: d.view.cy + (e.clientY - d.sy) / d.view.k })
        return
      case 'endpoint': {
        const w = d.base.walls.find((x) => x.id === d.id)!
        const other = d.end === 'a' ? w.b : w.a
        editor.apply(moveEndpoint(d.base, d.id, d.end, snap(p, other, d.id)), d.key)
        return
      }
      case 'wall': {
        const w = d.base.walls.find((x) => x.id === d.id)!
        const along = Math.round(dot(sub(p, d.start), wallFrame(w).n) / GRID_MM) * GRID_MM
        if (along) editor.apply(moveWall(d.base, d.id, along), d.key)
        return
      }
      case 'opening':
        editor.apply(moveOpening(d.base, d.id, p), d.key)
        return
      case 'furniture': {
        const f = d.base.furniture.find((x) => x.id === d.id)!
        const delta = sub(p, d.start)
        editor.apply(updateFurniture(d.base, d.id, {
          x: Math.round((f.x + delta[0]) / GRID_MM) * GRID_MM, y: Math.round((f.y + delta[1]) / GRID_MM) * GRID_MM,
        }), d.key)
        return
      }
      case 'rotate': {
        const f = d.base.furniture.find((x) => x.id === d.id)!
        // 把手在背面(+y);家具的 +x 方向 = 把手方向轉 -90°
        let ang = (Math.atan2(p[1] - f.y, p[0] - f.x) * 180) / Math.PI - 90
        if (!e.shiftKey) ang = Math.round(ang / 15) * 15 // 按住 Shift 可以自由旋轉
        editor.apply(updateFurniture(d.base, d.id, { angle: ((ang + 540) % 360) - 180 }), d.key)
        return
      }
    }
  }

  function onPointerUp() {
    if (drag.current && drag.current.mode !== 'pan') editor.endMerge()
    drag.current = null
  }

  // ---------- 畫面 ----------

  const wallPath = useMemo(() => (scene ? wallOutline(scene) : ''), [scene])
  if (!scene) return <svg ref={svgRef} className="plan" />

  const k = view.k
  const matrix = `matrix(${k},0,0,${-k},${size.w / 2 - view.cx * k},${size.h / 2 + view.cy * k})`
  const bg = scene.meta.background
  const walls = new Map(scene.walls.map((w) => [w.id, w]))
  const selWall = sel?.kind === 'wall' ? walls.get(sel.id) : undefined
  const selFurn = sel?.kind === 'furniture' ? scene.furniture.find((f) => f.id === sel.id) : undefined
  const px = (n: number) => n / k // 螢幕像素 → mm
  const ghostWall = (tool === 'door' || tool === 'window' || tool === 'passage') && hover ? nearestWall(hover) : null
  const wallEnd = tool === 'wall' && hover ? snap(hover, chain) : null
  const measureEnd = tool === 'measure' && hover ? snap(hover, measureA) : null

  const labels: { p: Point; text: string; sub?: string; cls?: string }[] = []
  for (const r of scene.rooms) labels.push({ p: centroid(r.polygon), text: r.name, sub: `${r.area.toFixed(1)} m²` })
  if (selWall) labels.push({ p: add(selWall.a, mul(sub(selWall.b, selWall.a), 0.5)), text: `${Math.round(wallFrame(selWall).length)} mm`, cls: 'dim' })
  if (chain && wallEnd) labels.push({ p: add(chain, mul(sub(wallEnd, chain), 0.5)), text: `${Math.round(dist(chain, wallEnd))} mm`, cls: 'dim' })
  if (measureA && measureEnd) labels.push({ p: add(measureA, mul(sub(measureEnd, measureA), 0.5)), text: `${Math.round(dist(measureA, measureEnd))} mm(圖上)`, cls: 'dim' })

  return (
    <svg ref={svgRef} className={`plan tool-${tool}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)} onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => setChain(null)}>
      <g transform={matrix}>
        {bg && <image href={bg.src} width={bg.width} height={bg.height} opacity={0.35}
          transform={`translate(0,${bg.height}) scale(1,-1)`} style={{ pointerEvents: 'none' }} />}

        {scene.rooms.map((r) => (
          <polygon key={r.id} data-kind="room" data-id={r.id} points={pts(r.polygon)}
            className={'room' + (sel?.kind === 'room' && sel.id === r.id ? ' sel' : '')}
            style={{ fill: FLOOR_MATERIALS[floorMaterialId(r)].swatch }} />
        ))}

        {scene.furniture.map((f) => {
          const c = furnitureCorners(f)
          return (
            <g key={f.id} data-kind="furniture" data-id={f.id}
              className={'furn' + (selFurn?.id === f.id ? ' sel' : '')}>
              <polygon points={pts(c)} style={{ fill: f.color }} />
              <line x1={c[2][0]} y1={c[2][1]} x2={c[3][0]} y2={c[3][1]} className="back" />
            </g>
          )
        })}

        <path d={wallPath} className="walls" fillRule="evenodd" />
        {scene.walls.map((w) => (
          <polygon key={w.id} data-kind="wall" data-id={w.id} points={pts(strip(w, 0, wallFrame(w).length, w.thickness))}
            className={'wallhit' + (selWall?.id === w.id ? ' sel' : '')} />
        ))}

        {scene.openings.map((o) => {
          const w = walls.get(o.wall)
          return w && <OpeningShape key={o.id} o={o} w={w} sel={sel?.kind === 'opening' && sel.id === o.id} />
        })}

        {ghostWall && hover && (() => {
          const { along, length } = project(ghostWall, hover)
          const width = Math.min(tool === 'window' ? 1200 : tool === 'door' ? 900 : 1800, length)
          const s = Math.max(width / 2, Math.min(length - width / 2, along))
          return <polygon points={pts(strip(ghostWall, s - width / 2, s + width / 2, ghostWall.thickness + px(6)))} className="ghost" />
        })()}

        {chain && wallEnd && <line x1={chain[0]} y1={chain[1]} x2={wallEnd[0]} y2={wallEnd[1]} className="draft"
          style={{ strokeWidth: scene.meta.wall_thickness }} />}
        {measureA && measureEnd && <line x1={measureA[0]} y1={measureA[1]} x2={measureEnd[0]} y2={measureEnd[1]} className="measure" />}

        {selWall && (['a', 'b'] as const).map((end) => (
          <circle key={end} data-kind="handle" data-handle={end} data-id={selWall.id}
            cx={selWall[end][0]} cy={selWall[end][1]} r={px(7)} className="handle" />
        ))}
        {selFurn && (() => {
          const r = (selFurn.angle * Math.PI) / 180
          const back: Point = [-Math.sin(r), Math.cos(r)]
          const h = add([selFurn.x, selFurn.y], mul(back, selFurn.depth / 2 + px(22)))
          const edge = add([selFurn.x, selFurn.y], mul(back, selFurn.depth / 2))
          return (
            <>
              <line x1={edge[0]} y1={edge[1]} x2={h[0]} y2={h[1]} className="rotline" />
              <circle data-kind="handle" data-handle="rotate" data-id={selFurn.id} cx={h[0]} cy={h[1]} r={px(7)} className="handle rot" />
            </>
          )
        })()}
        {(wallEnd || measureEnd) && (() => {
          const q = (wallEnd ?? measureEnd)!
          return <circle cx={q[0]} cy={q[1]} r={px(4)} className="cursor" />
        })()}
      </g>

      {labels.map((l, i) => {
        const [x, y] = toScreen(l.p)
        return (
          <text key={i} x={x} y={y} className={'label ' + (l.cls ?? '')}>
            <tspan x={x} dy={l.sub ? '-0.2em' : '0.35em'}>{l.text}</tspan>
            {l.sub && <tspan x={x} dy="1.2em" className="sub">{l.sub}</tspan>}
          </text>
        )
      })}
      {selFurn && (() => {
        const [x, y] = toScreen([selFurn.x, selFurn.y])
        return <text x={x} y={y + 4} className="label furnname">{CATALOG[selFurn.type]?.name ?? selFurn.type}</text>
      })()}
    </svg>
  )
}

/** 牆:所有牆段聯集、扣掉門窗開口後的外框(SVG path) */
function wallOutline(scene: Scene): string {
  if (!scene.walls.length) return ''
  const walls = new Map(scene.walls.map((w) => [w.id, w]))
  const strips: Polygon[] = scene.walls.map((w) => [ring(strip(w, 0, wallFrame(w).length, w.thickness))])
  let solid = polygonClipping.union(strips[0], ...strips.slice(1))
  const holes: Polygon[] = []
  for (const o of scene.openings) {
    const w = walls.get(o.wall)
    if (w) holes.push([ring(strip(w, o.offset - o.width / 2, o.offset + o.width / 2, w.thickness + 2))])
  }
  if (holes.length) solid = polygonClipping.difference(solid, ...holes)
  return solid.map((poly) => poly.map((r) => 'M' + r.map(([x, y]) => `${x},${y}`).join('L') + 'Z').join('')).join('')
}

function OpeningShape({ o, w, sel }: { o: Opening; w: Wall; sel: boolean }) {
  const { u, n } = wallFrame(w)
  const c = openingCenter(o, w)
  const body = strip(w, o.offset - o.width / 2, o.offset + o.width / 2, w.thickness)
  const lines: [Point, Point][] = []
  const arcs: Point[][] = []
  if (o.kind === 'window') {
    for (const k of [-w.thickness / 2, 0, w.thickness / 2]) {
      const p = add(c, mul(n, k))
      lines.push([add(p, mul(u, -o.width / 2)), add(p, mul(u, o.width / 2))])
    }
  } else if (o.kind === 'door') {
    const out = mul(n, o.swing)
    const face = add(c, mul(out, w.thickness / 2))
    const hinges: [number, number][] = o.leaves === 2 ? [[-1, o.width / 2], [1, o.width / 2]] : [[o.hinge === 'start' ? -1 : 1, o.width]]
    for (const [side, leaf] of hinges) {
      const h = add(face, mul(u, (side * o.width) / 2))
      lines.push([h, add(h, mul(out, leaf))])
      const closed = mul(u, -side)
      const arc: Point[] = []
      for (let i = 0; i <= 12; i++) {
        const t = (i / 12) * (Math.PI / 2)
        arc.push(add(h, add(mul(closed, leaf * Math.cos(t)), mul(out, leaf * Math.sin(t)))))
      }
      arcs.push(arc)
    }
  }
  return (
    <g data-kind="opening" data-id={o.id} className={`opening ${o.kind}` + (sel ? ' sel' : '')}>
      <polygon points={pts(body)} />
      {lines.map(([a, b], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)}
      {arcs.map((a, i) => <polyline key={i} points={pts(a)} />)}
    </g>
  )
}
