// 右側屬性面板:選到什麼就顯示什麼的設定;沒選東西時顯示工具說明與家具型錄。
import type { ReactNode } from 'react'
import { t } from '../i18n'
import type { Opening, WallKind } from '../scene/types'
import { CATALOG, LIBRARY, type LibraryItem } from '../scene/catalog'
import { useState } from 'react'
import { DRAG_TYPE } from './PlanView'
import { FLOOR_MATERIALS, autoFloor, floorMaterialId } from '../scene/materials'
import { DEFAULT_WALL_COLOR } from '../three/sceneBuilder'
import { isBearing, remove, updateFurniture, updateMeta, updateOpening, updateRoom, updateWall, type Sel } from './commands'
import { wallFrame } from './geometry'
import type { Tool } from './PlanView'
import type { Editor } from './store'

interface Props {
  editor: Editor
  tool: Tool
  furnitureType: LibraryItem
  onFurnitureType: (t: LibraryItem) => void
}

const TOOL_HELP: Record<Tool, string> = {
  select: '點選牆、門窗、家具或房間來修改。拖曳牆可以整道平移,拖曳端點改長度;門窗沿著牆拖;家具拖曳移動、拉上方圓點旋轉(按住 Shift 不吸附角度)。空白處拖曳平移畫面,滾輪縮放。',
  wall: '點一下開始,再點一下完成一段牆,會接著畫下一段。會吸附到端點、牆的中心線、水平/垂直。按 Esc、右鍵或連點兩下結束。',
  door: '點在牆上放一扇門(寬 900 mm)。放好後可以在右邊改寬度、開門方向。',
  window: '點在牆上放一扇窗(寬 1200 mm)。',
  passage: '點在牆上開一個開放通道(寬 1800 mm,沒有門片)。',
  furniture: '在下面的家具庫點一件,再到平面圖上點一下放置;也可以直接把家具拖進平面圖。靠近牆會自動貼牆(按住 Alt 不貼)。',
  demolish: '拆牆:點一道牆就拆掉(連同上面的門窗)。承重牆(紅色)不能拆;牆的種類在選取牆後設定。',
  measure: '比例尺校正:在平面圖上點兩點(例如一道已知長度的牆兩端),再輸入實際長度,整張圖會等比例縮放。',
}

export function Inspector({ editor, tool, furnitureType, onFurnitureType }: Props) {
  const { scene, sel } = editor
  if (!scene) return null
  const key = (field: string) => `${sel?.kind}:${sel?.id}:${field}`

  if (!sel) {
    return (
      <div className="inspector">
        <h2>{t("操作說明")}</h2>
        <p className="note">{t(TOOL_HELP[tool])}</p>
        <Library current={tool === 'furniture' ? furnitureType : null} onPick={onFurnitureType} />
        <h2>{t("整體設定")}</h2>
        <div className="field">
          <label>{t("牆面顏色")}</label>
          <span className="row tight">
            <input type="color" value={scene.meta.wall_color ?? DEFAULT_WALL_COLOR}
              onChange={(e) => editor.apply(updateMeta(scene, { wall_color: e.target.value }), 'meta:wall_color')} onBlur={editor.endMerge} />
            {WALL_COLORS.map(([c, n]) => (
              <button key={c} className="chip" title={t(n)} style={{ background: c }}
                onClick={() => editor.apply(updateMeta(scene, { wall_color: c }))} />
            ))}
          </span>
        </div>
        <p className="note">{t("每個房間的地板材質:點選房間後在這裡選。")}</p>
        <h2>{t("快捷鍵")}</h2>
        <table className="keys">
          <tbody>
            <tr><th>V</th><td>{t("選取")}</td></tr>
            <tr><th>W</th><td>{t("畫牆")}</td></tr>
            <tr><th>D / N</th><td>{t("放門 / 放窗")}</td></tr>
            <tr><th>Delete</th><td>{t("刪除選取的東西")}</td></tr>
            <tr><th>R</th><td>{t("家具旋轉 90°")}</td></tr>
            <tr><th>{t("方向鍵")}</th><td>{t("家具微調 10 mm(Shift 100 mm)")}</td></tr>
            <tr><th>Ctrl+D</th><td>{t("複製家具")}</td></tr>
            <tr><th>Ctrl+Z / Y</th><td>{t("復原 / 重做")}</td></tr>
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
        <div className="seg wall-kind">
          {WALL_KINDS.map(([k, label]) => (
            <button key={k} className={(w.kind ?? 'partition') === k ? 'on' : ''}
              onClick={() => editor.apply(updateWall(scene, w.id, {
                kind: k, height: k === 'low' ? LOW_WALL_MM : w.kind === 'low' ? scene.meta.wall_height : w.height,
              }))}>{t(label)}</button>
          ))}
        </div>
        {w.kind === 'bearing' && <p className="note warn">{t("承重牆:不能拆除或移動,要改請先改回其他種類。")}</p>}
        <Num label="長度" value={wallFrame(w).length} min={50} onChange={(v) => editor.apply(updateWall(scene, w.id, { length: v }), key('len'))} onDone={editor.endMerge} />
        <Num label="厚度" value={w.thickness} min={20} onChange={(v) => editor.apply(updateWall(scene, w.id, { thickness: v }), key('t'))} onDone={editor.endMerge} />
        <Num label="高度" value={w.height} min={100} onChange={(v) => editor.apply(updateWall(scene, w.id, { height: v }), key('h'))} onDone={editor.endMerge} />
        <p className="note">這道牆上有 {n} 個門窗。刪掉牆會連門窗一起刪除。改長度時起點不動。</p>
        <button onClick={() => editor.apply(updateWall(scene, w.id, { a: w.b, b: w.a }))}>{t("對調起點與終點")}</button>
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
            <button key={k} className={o.kind === k ? 'on' : ''} onClick={() => set({ kind: k })}>{t({ door: '門', window: '窗', passage: '通道' }[k])}</button>
          ))}
        </div>
        <Num label="寬度" value={o.width} min={300} onChange={(v) => set({ width: v }, 'w')} onDone={editor.endMerge} />
        {o.kind === 'window' && <Num label="窗台高" value={o.sill} min={0} onChange={(v) => set({ sill: v }, 's')} onDone={editor.endMerge} />}
        <Num label={o.kind === 'window' ? '窗頂高' : '門高'} value={o.head} min={500} onChange={(v) => set({ head: v }, 'hd')} onDone={editor.endMerge} />
        {o.kind === 'door' && (
          <>
            <div className="seg">
              <button className={o.leaves === 1 ? 'on' : ''} onClick={() => set({ leaves: 1 })}>{t("單開")}</button>
              <button className={o.leaves === 2 ? 'on' : ''} onClick={() => set({ leaves: 2 })}>{t("雙開")}</button>
            </div>
            <div className="row">
              <button onClick={() => set({ swing: o.swing === 1 ? -1 : 1 })}>{t("翻轉開門方向")}</button>
              {o.leaves === 1 && <button onClick={() => set({ hinge: o.hinge === 'start' ? 'end' : 'start' })}>{t("換鉸鏈邊")}</button>}
            </div>
            <label className="check"><input type="checkbox" checked={o.exterior} onChange={(e) => set({ exterior: e.target.checked })} /> {t("大門(深色門片)")}</label>
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
          {Object.entries(CATALOG).map(([ty, c]) => <option key={ty} value={ty}>{t(c.name)}</option>)}
        </select>
        <p className="note">{t("拖曳移動(靠牆自動貼齊,按住 Alt 不貼)· 方向鍵微調 10 mm(Shift 100 mm)· Ctrl+D 複製")}</p>
        <Num label="寬" value={f.width} min={50} onChange={(v) => set({ width: v }, 'w')} onDone={editor.endMerge} />
        <Num label="深" value={f.depth} min={50} onChange={(v) => set({ depth: v }, 'd')} onDone={editor.endMerge} />
        <Num label="角度" unit="°" value={f.angle} step={15} onChange={(v) => set({ angle: v }, 'a')} onDone={editor.endMerge} />
        <div className="field">
          <label>{t("顏色")}</label>
          <input type="color" value={f.color} onChange={(e) => set({ color: e.target.value }, 'c')} onBlur={editor.endMerge} />
        </div>
        <div className="row">
          <button onClick={() => set({ angle: ((f.angle + 90 + 180) % 360) - 180 })}>{t("旋轉 90°")}</button>
          <button onClick={() => set({ width: f.depth, depth: f.width })}>{t("寬深對調")}</button>
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
          <label>{t("名稱")}</label>
          <input type="text" value={r.name} onChange={(e) => editor.apply(updateRoom(scene, r.id, { name: e.target.value }), key('n'))} onBlur={editor.endMerge} />
          <label>{t("面積")}</label>
          <span>{r.area.toFixed(2)} m²</span>
        </div>
        <h2>{t("地板材質")}</h2>
        <div className="materials">
          <button className={!r.floor_material ? 'on' : ''} onClick={() => editor.apply(updateRoom(scene, r.id, { floor_material: null }))}>
            <i style={{ background: FLOOR_MATERIALS[autoFloor(r.name)].swatch }} />{t("自動(依房名)")}
          </button>
          {Object.entries(FLOOR_MATERIALS).map(([id, m]) => (
            <button key={id} className={r.floor_material === id ? 'on' : ''} onClick={() => editor.apply(updateRoom(scene, r.id, { floor_material: id }))}>
              <i style={{ background: m.swatch }} />{t(m.name)}
            </button>
          ))}
        </div>
        <p className="note">目前:{FLOOR_MATERIALS[floorMaterialId(r)].name}。房間由牆自動圍出,改牆之後會重新計算面積,名稱和材質會保留。</p>
      </>
    )
  }

  return (
    <div className="inspector">
      <h2>{t(title)}</h2>
      {body}
      <div className="row">
        <button className="danger" disabled={sel.kind === 'wall' && isBearing(scene, sel.id)}
          title={sel.kind === 'wall' && isBearing(scene, sel.id) ? '承重牆不能拆除' : undefined}
          onClick={() => editor.apply(remove(scene, sel as Sel))}>{t("刪除")}</button>
        <button onClick={() => editor.select(null)}>{t("取消選取")}</button>
      </div>
    </div>
  )
}

const WALL_COLORS: [string, string][] = [
  ['#f2efe9', '米白'], ['#ffffff', '純白'], ['#e4ddd0', '奶茶'], ['#cfd6d2', '灰綠'], ['#c9cfd8', '霧藍'], ['#8a8f96', '深灰'],
]

/** 家具庫:分類、搜尋;點一下選取後到平面圖上點放置,或直接拖進平面圖 */
function Library({ current, onPick }: { current: LibraryItem | null; onPick: (it: LibraryItem) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(LIBRARY[0].cat)
  const hit = (it: LibraryItem) => !q || it.name.includes(q) || t(it.name).toLowerCase().includes(q.toLowerCase()) || (CATALOG[it.type]?.name ?? '').includes(q)
  return (
    <div className="library">
      <h2>{t("家具庫")}</h2>
      <input type="search" placeholder={t("搜尋家具…")} value={q} onChange={(e) => setQ(e.target.value)} />
      {LIBRARY.map((g) => {
        const items = g.items.filter(hit)
        if (!items.length) return null
        const expanded = q !== '' || open === g.cat
        return (
          <div key={g.cat} className="lib-cat">
            <button className="lib-head" onClick={() => setOpen(open === g.cat ? null : g.cat)}>
              {expanded ? '▾' : '▸'} {t(g.cat)} <span className="muted">{items.length}</span>
            </button>
            {expanded && (
              <div className="lib-items">
                {items.map((it) => (
                  <button key={it.name} draggable title={`${it.w} × ${it.d} mm · ${t('可以拖進平面圖')}`}
                    className={current?.name === it.name ? 'on' : ''}
                    onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(it)); e.dataTransfer.effectAllowed = 'copy' }}
                    onClick={() => onPick(it)}>
                    <i style={{ background: it.color }} />
                    <span>{t(it.name)}<small>{it.w / 10}×{it.d / 10}</small></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const WALL_KINDS: [WallKind, string][] = [['partition', '隔間'], ['bearing', '承重'], ['exterior', '外牆'], ['low', '矮牆']]
const LOW_WALL_MM = 1000

function Num({ label, value, onChange, onDone, min, step = 10, unit = 'mm' }: {
  label: string; value: number; onChange: (v: number) => void; onDone: () => void; min?: number; step?: number; unit?: string
}) {
  return (
    <div className="field">
      <label>{t(label)}</label>
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
