// 右側屬性面板:選到什麼就顯示什麼的設定;沒選東西時顯示工具說明與家具型錄。
import type { ReactNode } from 'react'
import type { Opening } from '../scene/types'
import { CATALOG } from '../scene/catalog'
import { FLOOR_MATERIALS, autoFloor, floorMaterialId } from '../scene/materials'
import { DEFAULT_WALL_COLOR } from '../three/sceneBuilder'
import { remove, updateFurniture, updateMeta, updateOpening, updateRoom, updateWall, type Sel } from './commands'
import { wallFrame } from './geometry'
import type { Tool } from './PlanView'
import type { Editor } from './store'

interface Props {
  editor: Editor
  tool: Tool
  furnitureType: string
  onFurnitureType: (t: string) => void
  onTool: (t: Tool) => void
}

const TOOL_HELP: Record<Tool, string> = {
  select: '點選牆、門窗、家具或房間來修改。拖曳牆可以整道平移,拖曳端點改長度;門窗沿著牆拖;家具拖曳移動、拉上方圓點旋轉(按住 Shift 不吸附角度)。空白處拖曳平移畫面,滾輪縮放。',
  wall: '點一下開始,再點一下完成一段牆,會接著畫下一段。會吸附到端點、牆的中心線、水平/垂直。按 Esc、右鍵或連點兩下結束。',
  door: '點在牆上放一扇門(寬 900 mm)。放好後可以在右邊改寬度、開門方向。',
  window: '點在牆上放一扇窗(寬 1200 mm)。',
  passage: '點在牆上開一個開放通道(寬 1800 mm,沒有門片)。',
  furniture: '從下面選種類,再到平面圖上點一下放置。',
  measure: '比例尺校正:在平面圖上點兩點(例如一道已知長度的牆兩端),再輸入實際長度,整張圖會等比例縮放。',
}

export function Inspector({ editor, tool, furnitureType, onFurnitureType, onTool }: Props) {
  const { scene, sel } = editor
  if (!scene) return null
  const key = (field: string) => `${sel?.kind}:${sel?.id}:${field}`

  if (!sel) {
    return (
      <div className="inspector">
        <h2>操作說明</h2>
        <p className="note">{TOOL_HELP[tool]}</p>
        {tool === 'furniture' && (
          <div className="catalog">
            {Object.entries(CATALOG).map(([t, c]) => (
              <button key={t} className={furnitureType === t ? 'on' : ''} onClick={() => onFurnitureType(t)}>{c.name}</button>
            ))}
          </div>
        )}
        {tool !== 'furniture' && (
          <button onClick={() => onTool('furniture')}>新增家具…</button>
        )}
        <h2>整體設定</h2>
        <div className="field">
          <label>牆面顏色</label>
          <span className="row tight">
            <input type="color" value={scene.meta.wall_color ?? DEFAULT_WALL_COLOR}
              onChange={(e) => editor.apply(updateMeta(scene, { wall_color: e.target.value }), 'meta:wall_color')} onBlur={editor.endMerge} />
            {WALL_COLORS.map(([c, n]) => (
              <button key={c} className="chip" title={n} style={{ background: c }}
                onClick={() => editor.apply(updateMeta(scene, { wall_color: c }))} />
            ))}
          </span>
        </div>
        <p className="note">每個房間的地板材質:點選房間後在這裡選。</p>
        <h2>快捷鍵</h2>
        <table className="keys">
          <tbody>
            <tr><th>V</th><td>選取</td></tr>
            <tr><th>W</th><td>畫牆</td></tr>
            <tr><th>D / N</th><td>放門 / 放窗</td></tr>
            <tr><th>Delete</th><td>刪除選取的東西</td></tr>
            <tr><th>R</th><td>家具旋轉 90°</td></tr>
            <tr><th>Ctrl+Z / Y</th><td>復原 / 重做</td></tr>
          </tbody>
        </table>
      </div>
    )
  }

  let body: ReactNode = null
  let title = ''
  if (sel.kind === 'wall') {
    const w = scene.walls.find((x) => x.id === sel.id)
    if (!w) return null
    title = '牆'
    const n = scene.openings.filter((o) => o.wall === w.id).length
    body = (
      <>
        <Num label="長度" value={wallFrame(w).length} min={50} onChange={(v) => editor.apply(updateWall(scene, w.id, { length: v }), key('len'))} onDone={editor.endMerge} />
        <Num label="厚度" value={w.thickness} min={20} onChange={(v) => editor.apply(updateWall(scene, w.id, { thickness: v }), key('t'))} onDone={editor.endMerge} />
        <Num label="高度" value={w.height} min={100} onChange={(v) => editor.apply(updateWall(scene, w.id, { height: v }), key('h'))} onDone={editor.endMerge} />
        <p className="note">這道牆上有 {n} 個門窗。刪掉牆會連門窗一起刪除。改長度時起點不動。</p>
        <button onClick={() => editor.apply(updateWall(scene, w.id, { a: w.b, b: w.a }))}>對調起點與終點</button>
      </>
    )
  } else if (sel.kind === 'opening') {
    const o = scene.openings.find((x) => x.id === sel.id)
    if (!o) return null
    title = { door: '門', window: '窗', passage: '開放通道' }[o.kind]
    const set = (patch: Partial<Opening>, field?: string) => editor.apply(updateOpening(scene, o.id, patch), field && key(field))
    body = (
      <>
        <div className="seg">
          {(['door', 'window', 'passage'] as const).map((k) => (
            <button key={k} className={o.kind === k ? 'on' : ''} onClick={() => set({ kind: k })}>{{ door: '門', window: '窗', passage: '通道' }[k]}</button>
          ))}
        </div>
        <Num label="寬度" value={o.width} min={300} onChange={(v) => set({ width: v }, 'w')} onDone={editor.endMerge} />
        {o.kind === 'window' && <Num label="窗台高" value={o.sill} min={0} onChange={(v) => set({ sill: v }, 's')} onDone={editor.endMerge} />}
        <Num label={o.kind === 'window' ? '窗頂高' : '門高'} value={o.head} min={500} onChange={(v) => set({ head: v }, 'hd')} onDone={editor.endMerge} />
        {o.kind === 'door' && (
          <>
            <div className="seg">
              <button className={o.leaves === 1 ? 'on' : ''} onClick={() => set({ leaves: 1 })}>單開</button>
              <button className={o.leaves === 2 ? 'on' : ''} onClick={() => set({ leaves: 2 })}>雙開</button>
            </div>
            <div className="row">
              <button onClick={() => set({ swing: o.swing === 1 ? -1 : 1 })}>翻轉開門方向</button>
              {o.leaves === 1 && <button onClick={() => set({ hinge: o.hinge === 'start' ? 'end' : 'start' })}>換鉸鏈邊</button>}
            </div>
            <label className="check"><input type="checkbox" checked={o.exterior} onChange={(e) => set({ exterior: e.target.checked })} /> 大門(深色門片)</label>
          </>
        )}
      </>
    )
  } else if (sel.kind === 'furniture') {
    const f = scene.furniture.find((x) => x.id === sel.id)
    if (!f) return null
    title = '家具'
    const set = (patch: Parameters<typeof updateFurniture>[2], field?: string) => editor.apply(updateFurniture(scene, f.id, patch), field && key(field))
    body = (
      <>
        <select value={f.type} onChange={(e) => set({ type: e.target.value, options: {} })}>
          {Object.entries(CATALOG).map(([t, c]) => <option key={t} value={t}>{c.name}</option>)}
        </select>
        <Num label="寬" value={f.width} min={50} onChange={(v) => set({ width: v }, 'w')} onDone={editor.endMerge} />
        <Num label="深" value={f.depth} min={50} onChange={(v) => set({ depth: v }, 'd')} onDone={editor.endMerge} />
        <Num label="角度" unit="°" value={f.angle} step={15} onChange={(v) => set({ angle: v }, 'a')} onDone={editor.endMerge} />
        <div className="field">
          <label>顏色</label>
          <input type="color" value={f.color} onChange={(e) => set({ color: e.target.value }, 'c')} onBlur={editor.endMerge} />
        </div>
        <div className="row">
          <button onClick={() => set({ angle: ((f.angle + 90 + 180) % 360) - 180 })}>旋轉 90°</button>
          <button onClick={() => set({ width: f.depth, depth: f.width })}>寬深對調</button>
        </div>
      </>
    )
  } else {
    const r = scene.rooms.find((x) => x.id === sel.id)
    if (!r) return null
    title = '房間'
    body = (
      <>
        <div className="field">
          <label>名稱</label>
          <input type="text" value={r.name} onChange={(e) => editor.apply(updateRoom(scene, r.id, { name: e.target.value }), key('n'))} onBlur={editor.endMerge} />
          <label>面積</label>
          <span>{r.area.toFixed(2)} m²</span>
        </div>
        <h2>地板材質</h2>
        <div className="materials">
          <button className={!r.floor_material ? 'on' : ''} onClick={() => editor.apply(updateRoom(scene, r.id, { floor_material: null }))}>
            <i style={{ background: FLOOR_MATERIALS[autoFloor(r.name)].swatch }} />自動(依房名)
          </button>
          {Object.entries(FLOOR_MATERIALS).map(([id, m]) => (
            <button key={id} className={r.floor_material === id ? 'on' : ''} onClick={() => editor.apply(updateRoom(scene, r.id, { floor_material: id }))}>
              <i style={{ background: m.swatch }} />{m.name}
            </button>
          ))}
        </div>
        <p className="note">目前:{FLOOR_MATERIALS[floorMaterialId(r)].name}。房間由牆自動圍出,改牆之後會重新計算面積,名稱和材質會保留。</p>
      </>
    )
  }

  return (
    <div className="inspector">
      <h2>{title}</h2>
      {body}
      <div className="row">
        <button className="danger" onClick={() => editor.apply(remove(scene, sel as Sel))}>刪除</button>
        <button onClick={() => editor.select(null)}>取消選取</button>
      </div>
    </div>
  )
}

const WALL_COLORS: [string, string][] = [
  ['#f2efe9', '米白'], ['#ffffff', '純白'], ['#e4ddd0', '奶茶'], ['#cfd6d2', '灰綠'], ['#c9cfd8', '霧藍'], ['#8a8f96', '深灰'],
]

function Num({ label, value, onChange, onDone, min, step = 10, unit = 'mm' }: {
  label: string; value: number; onChange: (v: number) => void; onDone: () => void; min?: number; step?: number; unit?: string
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <span>
        <input type="number" value={Math.round(value * 10) / 10} min={min} step={step}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (e.target.value !== '' && Number.isFinite(v) && (min === undefined || v >= min)) onChange(v)
          }}
          onBlur={onDone} /> {unit}
      </span>
    </div>
  )
}
