import { useCallback, useEffect, useRef, useState } from 'react'
import { exportDwg, exportDxf, getCapabilities, listSamples, recognize, type Engine, type RecognizeInput } from './api'
import { ExportMenu, type ExportItem } from './components/ExportMenu'
import { ShareDialog } from './components/ShareDialog'
import { openReport } from './export/report'
import { tablesCsv } from './export/tables'
import { Viewer3D } from './components/Viewer3D'
import { calibrationFactor, scaleScene, updateFurniture, remove } from './editor/commands'
import { dist } from './editor/geometry'
import { Inspector } from './editor/Inspector'
import { PlanView, type Tool } from './editor/PlanView'
import { autosave, clearAutosave, loadAutosave, parseProject, projectBlob, type Project } from './editor/project'
import { useEditor } from './editor/store'
import { FLOOR_MATERIALS, floorMaterialId } from './scene/materials'
import type { CadLayer, LayerRole, Point, RecognizeResponse } from './scene/types'
import type { Viewer, ViewName } from './three/Viewer'

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string }
type Layout = 'plan' | '3d' | 'split'
type Source = Omit<RecognizeInput, 'width' | 'height' | 'layers'>

const VIEWS: [ViewName, string][] = [['iso', '等角'], ['front', '前'], ['top', '上'], ['right', '右']]
const TOOLS: [Tool, string, string][] = [
  ['select', '選取', 'V'], ['wall', '畫牆', 'W'], ['door', '門', 'D'], ['window', '窗', 'N'],
  ['passage', '通道', ''], ['furniture', '家具', 'F'], ['measure', '比例尺', 'M'],
]
const ROLE_NAMES: Record<LayerRole, string> = {
  wall: '牆', door: '門', window: '窗', furniture: '家具', text: '房間名稱', other: '只當底圖', ignore: '忽略',
}
const ACCEPT = '.png,.jpg,.jpeg,.webp,.bmp,.dxf,.dwg'
const isCad = (name?: string) => !!name && /\.(dxf|dwg)$/i.test(name)

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default function App() {
  const editor = useEditor()
  const { scene } = editor
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [samples, setSamples] = useState<string[]>([])
  const [width, setWidth] = useState<number | ''>(12000)
  const [height, setHeight] = useState(3000)
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '上傳平面圖圖片或 AutoCAD 檔(DXF / DWG),或點選範例' })
  const [info, setInfo] = useState<Pick<RecognizeResponse, 'overlay' | 'log' | 'cad'> | null>(null)
  const [layers, setLayers] = useState<CadLayer[]>([])
  const [name, setName] = useState('floorplan')
  const [layout, setLayout] = useState<Layout>('split')
  const [tool, setTool] = useState<Tool>('select')
  const [furnitureType, setFurnitureType] = useState('sofa')
  const [fitKey, setFitKey] = useState(0)
  const [view, setView] = useState<ViewName>('iso')
  const [display, setDisplay] = useState({ wire: false, xray: false, furniture: true, plan: false, ceiling: false })
  const [walking, setWalking] = useState(false)
  const [caps, setCaps] = useState({ dwg: false, ml: false })
  const [engine, setEngine] = useState<Engine>('auto')
  const [sharing, setSharing] = useState(false)
  const [doorsOpen, setDoorsOpen] = useState(false)
  const [doorCount, setDoorCount] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [measure, setMeasure] = useState<{ a: Point; b: Point; value: string } | null>(null)
  const [restore, setRestore] = useState<Project | null>(() => loadAutosave())
  const [lastInput, setLastInput] = useState<Source | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const freshLoad = useRef(false)

  useEffect(() => { listSamples().then(setSamples); getCapabilities().then(setCaps) }, [])
  const onViewerReady = useCallback((v: Viewer | null) => setViewer(v), [])

  function loadScene(p: Project, extra: typeof info) {
    freshLoad.current = true
    editor.load(p.scene)
    setName(p.name)
    setInfo(extra)
    setLayers(extra?.cad?.layers ?? [])
    setFitKey((k) => k + 1)
    setTool('select')
    setRestore(null)
  }

  // Scene → 3D:載入時重設視角;編輯時保留視角,並用 requestAnimationFrame 合併連續的更新(拖曳中)
  useEffect(() => {
    if (!viewer) return
    viewer.onWalkChange = setWalking
    viewer.onDoorsChange = () => {
      setDoorsOpen(viewer.allDoorsOpen)
      setDoorCount(viewer.doors.length)
    }
    if (!scene) return
    const fresh = freshLoad.current
    const id = requestAnimationFrame(() => {
      viewer.setScene(scene, !fresh)
      viewer.setDisplay(display)
      if (fresh) setView('iso')
    })
    freshLoad.current = false
    return () => cancelAnimationFrame(id)
    // display 刻意不放進相依清單:切換由按鈕直接呼叫 setDisplay
  }, [viewer, scene]) // eslint-disable-line react-hooks/exhaustive-deps

  // 自動存檔(停手 1 秒後)
  useEffect(() => {
    if (!scene) return
    const t = setTimeout(() => autosave({ name, scene }), 1000)
    return () => clearTimeout(t)
  }, [scene, name])

  async function run(input: Source, layerRoles?: Record<string, LayerRole>) {
    setLastInput(input)
    setStatus({ kind: 'busy', text: '辨識中…' })
    try {
      const cad = isCad(input.file?.name ?? input.sample)
      const r = await recognize({ ...input, width: cad ? undefined : width || undefined, height, layers: layerRoles, engine })
      loadScene({ name: (input.file?.name ?? input.sample ?? 'floorplan').replace(/\.\w+$/, ''), scene: r.scene }, r)
      setStatus({
        kind: 'ok',
        text: cad ? '已從 AutoCAD 檔產生 3D 空間。尺寸依檔案單位,可在左邊調整圖層對應'
          : width ? '已產生 3D 空間。尺寸依「外牆總寬」換算,請核對;不對可以用「比例尺」工具校正'
            : '已產生 3D 空間。尺寸是依牆厚估的,請用「比例尺」工具量一道已知長度的牆校正',
      })
    } catch (e) {
      setStatus({ kind: 'error', text: '✗ ' + (e as Error).message })
    }
  }

  async function openProject(file: File) {
    try {
      const p = parseProject(await file.text(), file.name.replace(/(\.fp3d)?\.json$/i, ''))
      setLastInput(null)
      loadScene(p, null)
      setStatus({ kind: 'ok', text: `已開啟專案「${p.name}」` })
    } catch (e) {
      setStatus({ kind: 'error', text: '✗ ' + (e as Error).message })
    }
  }

  function pickFile(f: File) {
    if (/\.json$/i.test(f.name)) openProject(f)
    else run({ file: f })
  }

  // 快捷鍵(在輸入框裡打字時不觸發)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewer?.walking) return // 走動模式的按鍵由 3D 檢視器處理
      const t = e.target as HTMLElement
      if (t?.closest?.('input, select, textarea') || !scene) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return }
      if (ctrl) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && editor.sel) { e.preventDefault(); editor.apply(remove(scene, editor.sel)); return }
      if (e.key === 'Escape') { editor.select(null); setTool('select'); return }
      if (e.key.toLowerCase() === 'r' && editor.sel?.kind === 'furniture') {
        const f = scene.furniture.find((x) => x.id === editor.sel!.id)
        if (f) editor.apply(updateFurniture(scene, f.id, { angle: ((f.angle + 90 + 180) % 360) - 180 }))
        return
      }
      const hit = TOOLS.find(([, , k]) => k && k.toLowerCase() === e.key.toLowerCase())
      if (hit) setTool(hit[0])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scene, editor, viewer])

  function applyMeasure() {
    if (!scene || !measure) return
    const actual = Number(measure.value)
    if (!(actual > 0)) return
    const k = calibrationFactor(measure.a, measure.b, actual)
    editor.apply(scaleScene(scene, k))
    setStatus({ kind: 'ok', text: `比例尺已校正:整張圖縮放為原本的 ${k.toFixed(3)} 倍` })
    setMeasure(null)
  }

  function startWalk() {
    if (layout !== 'plan') return viewer?.startWalk()
    setLayout('3d') // 3D 畫面原本是隱藏的,等版面換好再進去
    setTimeout(() => viewer?.startWalk(), 50)
  }

  function toggle(key: keyof typeof display) {
    const next = { ...display, [key]: !display[key] }
    setDisplay(next)
    viewer?.setDisplay(next)
  }

  const counts = scene && {
    windows: scene.openings.filter((o) => o.kind === 'window').length,
    doors: scene.openings.filter((o) => o.kind === 'door').length,
    passages: scene.openings.filter((o) => o.kind === 'passage').length,
  }
  const totalArea = scene?.rooms.reduce((s, r) => s + r.area, 0) ?? 0
  const sourceIsCad = isCad(lastInput?.file?.name ?? lastInput?.sample)

  return (
    <div className="app">
      <header>
        <h1>平面圖 → 3D 空間</h1>
        <span className="sub">圖片或 AutoCAD 平面圖 → 可編輯的 3D 空間</span>
        <span className="spacer" />
        <button onClick={() => projectInput.current?.click()}>開啟專案</button>
        <input ref={projectInput} type="file" accept=".json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) openProject(f); e.target.value = '' }} />
        <button disabled={!scene} onClick={() => scene && download(projectBlob({ name, scene }), `${name}.fp3d.json`)}>儲存專案</button>
        <button className="primary" disabled={!scene} onClick={() => setSharing(true)}>分享</button>
      </header>
      {restore && (
        <div className="banner">
          有上次沒存的編輯「{restore.name}」{restore.savedAt && `(${new Date(restore.savedAt).toLocaleString()})`},要還原嗎?
          <button onClick={() => { loadScene(restore, null); setStatus({ kind: 'ok', text: '已還原上次的編輯' }) }}>還原</button>
          <button onClick={() => { clearAutosave(); setRestore(null) }}>捨棄</button>
        </div>
      )}
      <main className={scene ? 'with-inspector' : ''}>
        <aside>
          <section>
            <div
              className={'drop' + (dragOver ? ' over' : '')}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                const f = e.dataTransfer.files[0]
                if (f) pickFile(f)
              }}
            >
              把<b>平面圖圖片</b>或 <b>AutoCAD 檔(DXF / DWG)</b>拖到這裡,或點一下選檔
              <input ref={fileInput} type="file" accept={ACCEPT} hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = '' }} />
            </div>
            {samples.length > 0 && (
              <div className="row">
                <span className="muted">範例:</span>
                {samples.map((s) => (
                  <button key={s} onClick={() => run({ sample: s })} title={s}>
                    {s.replace(/\.\w+$/, '')}{isCad(s) && <small className="tag">DXF</small>}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2>尺寸</h2>
            <div className="field">
              <label htmlFor="width">外牆總寬</label>
              <span><input id="width" type="number" min={1} step={100} value={width} placeholder="自動估算"
                onChange={(e) => setWidth(e.target.value === '' ? '' : Number(e.target.value))} /> mm</span>
              <label htmlFor="height">牆高</label>
              <span><input id="height" type="number" min={1} step={100} value={height} onChange={(e) => setHeight(Number(e.target.value))} /> mm</span>
              <label htmlFor="engine">辨識方式</label>
              <span>
                <select id="engine" value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
                  <option value="auto">自動{caps.ml ? '(機器學習)' : '(規則)'}</option>
                  <option value="ml" disabled={!caps.ml}>機器學習{caps.ml ? '' : '(沒有模型)'}</option>
                  <option value="rules">規則(深色粗線是牆)</option>
                </select>
              </span>
            </div>
            <p className="note">
              圖片的比例尺依「外牆總寬」換算(最左到最右外牆外緣的實際長度),留空會依牆厚估算。
              AutoCAD 檔直接用檔案裡的尺寸。辨識後也可以用「比例尺」工具量一道已知長度的牆來校正。
            </p>
            <button disabled={!lastInput || status.kind === 'busy'} onClick={() => lastInput && run(lastInput)}>
              用新數字重新辨識
            </button>
          </section>

          <section><div className={'status ' + status.kind}>{status.text}</div></section>

          {layers.length > 0 && sourceIsCad && (
            <section>
              <h2>CAD 圖層對應</h2>
              <table className="layers">
                <tbody>
                  {layers.map((l, i) => (
                    <tr key={l.name}>
                      <td title={l.name}>{l.name}</td>
                      <td className="num muted">{l.count}</td>
                      <td>
                        <select value={l.role} onChange={(e) => setLayers(layers.map((x, j) => (j === i ? { ...x, role: e.target.value as LayerRole } : x)))}>
                          {Object.entries(ROLE_NAMES).map(([r, n]) => <option key={r} value={r}>{n}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">圖層角色是依名稱自動判斷的;判斷錯了可以改,再重新匯入(會蓋掉目前的編輯)。</p>
              <button disabled={status.kind === 'busy'} onClick={() => lastInput && run(lastInput, Object.fromEntries(layers.map((l) => [l.name, l.role])))}>
                依這個對應重新匯入
              </button>
            </section>
          )}

          {scene && counts && (
            <>
              <section>
                <h2>摘要</h2>
                <table>
                  <tbody>
                    <tr><th>牆</th><td>{scene.walls.length} 段,厚約 {Math.round(scene.meta.wall_thickness)} mm</td></tr>
                    <tr><th>門窗</th><td>窗 {counts.windows}、門 {counts.doors}、開放通道 {counts.passages}</td></tr>
                    <tr><th>家具</th><td>{scene.furniture.length} 件</td></tr>
                  </tbody>
                </table>
              </section>
              <section>
                <h2>房間({scene.rooms.length},共 {totalArea.toFixed(1)} m²)</h2>
                <table className="rooms">
                  <tbody>
                    {scene.rooms.map((r) => (
                      <tr key={r.id} className={editor.sel?.kind === 'room' && editor.sel.id === r.id ? 'sel' : ''}
                        onClick={() => editor.select({ kind: 'room', id: r.id })}>
                        <td><i className="swatch" style={{ background: FLOOR_MATERIALS[floorMaterialId(r)].swatch }} />{r.name}</td>
                        <td className="num">{r.area.toFixed(1)} m²</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              {info && (
                <details>
                  <summary>辨識結果與紀錄</summary>
                  <img className="overlay" src={info.overlay} alt="辨識結果" />
                  <div className="legend">
                    <span><i style={{ background: '#dc2828' }} />牆</span>
                    <span><i style={{ background: '#1e8cdc' }} />窗 / 通道</span>
                    <span><i style={{ background: '#3cb43c' }} />門</span>
                    <span><i style={{ background: '#c83cc8' }} />家具</span>
                  </div>
                  <pre className="log">{info.log.join('\n')}</pre>
                </details>
              )}
            </>
          )}
        </aside>

        <div className="stage">
          <div className="topbar">
            <div className="seg">
              {([['plan', '2D'], ['split', '並排'], ['3d', '3D']] as const).map(([l, label]) => (
                <button key={l} className={layout === l ? 'on' : ''} onClick={() => setLayout(l)}>{label}</button>
              ))}
            </div>
            {layout !== '3d' && (
              <div className="seg">
                {TOOLS.map(([t, label, k]) => (
                  <button key={t} className={tool === t ? 'on' : ''} disabled={!scene} title={k ? `快捷鍵 ${k}` : undefined}
                    onClick={() => setTool(t)}>{label}</button>
                ))}
              </div>
            )}
            <div className="seg">
              <button disabled={!editor.canUndo} onClick={editor.undo} title="Ctrl+Z">↶ 復原</button>
              <button disabled={!editor.canRedo} onClick={editor.redo} title="Ctrl+Y">↷ 重做</button>
            </div>
            <span className="spacer" />
            {scene && viewer && (
              <ExportMenu items={[
                ['AutoCAD DXF', '平面圖、門窗、家具圖塊、尺寸、面積表', () => exportDxf(scene).then((b) => download(b, `${name}.dxf`))],
                ...(caps.dwg ? [['AutoCAD DWG', '同 DXF,AutoCAD 2018 格式', () => exportDwg(scene).then((b) => download(b, `${name}.dwg`))] as ExportItem] : []),
                ['SketchUp / OBJ', 'OBJ + 材質 + 地板貼圖(zip)', () => viewer.exportOBJ(name).then((b) => download(b, `${name}-obj.zip`))],
                ['GLB', '網頁展示、Blender', () => viewer.exportGLB().then((b) => download(b, `${name}.glb`))],
                ['面積表 CSV', 'Excel 直接開:房間面積(m²、坪)、門窗表', async () => download(tablesCsv(scene, name), `${name}-面積表.csv`)],
                ['客戶報告 PDF', '透視圖、平面圖、面積表、門窗表(在列印視窗選「另存為 PDF」)', () => openReport(scene, name, async () => ({
                  perspective: viewer.renderView('iso', 1800, 1100), plan: viewer.renderView('top', 1600, 1300),
                }))],
                ['高解析截圖', '目前 3D 視角,寬 3840 px', () => viewer.screenshotHiRes().then((b) => download(b, `${name}.png`))],
              ]} onError={(e) => setStatus({ kind: 'error', text: '✗ ' + e.message })} />
            )}
          </div>

          <div className={`panes l-${layout}`}>
            <div className="pane plan-pane">
              <PlanView editor={editor} tool={tool} furnitureType={furnitureType} fitKey={fitKey}
                onTool={setTool} onMeasure={(a, b) => setMeasure({ a, b, value: String(Math.round(dist(a, b))) })} />
              {!scene && <div className="empty light">左邊上傳平面圖或 AutoCAD 檔,或點選範例</div>}
            </div>
            <div className="pane view-pane">
              <div className="toolbar">
                {VIEWS.map(([v, label]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => { setView(v); viewer?.setView(v) }}>{label}</button>
                ))}
                <button className={display.wire ? 'on' : ''} onClick={() => toggle('wire')}>線框</button>
                <button className={display.xray ? 'on' : ''} onClick={() => toggle('xray')}>透視</button>
                {scene && scene.furniture.length > 0 && (
                  <button className={display.furniture ? 'on' : ''} onClick={() => toggle('furniture')}>家具</button>
                )}
                {viewer && doorCount > 0 && (
                  <button className={doorsOpen ? 'on' : ''} title="也可以直接點某一扇門單獨開關"
                    onClick={() => viewer.setAllDoors(!doorsOpen)}>{doorsOpen ? '關門' : '開門'}</button>
                )}
                {scene && <>
                  <button className={display.ceiling ? 'on' : ''} onClick={() => toggle('ceiling')}>天花板</button>
                  {scene.meta.background && (
                    <button className={display.plan ? 'on' : ''} title="地板改成顯示原始平面圖" onClick={() => toggle('plan')}>原圖</button>
                  )}
                  <button className={walking ? 'on' : ''} title="第一人稱走進房子裡看"
                    onClick={() => (walking ? viewer?.stopWalk() : startWalk())}>{walking ? '離開' : '走進去'}</button>
                  <button title="輸出 3840 px 寬的高解析截圖" onClick={async () => {
                    if (viewer) download(await viewer.screenshotHiRes(), `${name}.png`)
                  }}>截圖</button>
                </>}
              </div>
              {!scene && <div className="empty">3D 預覽</div>}
              <Viewer3D onReady={onViewerReady} />
              <div className={'hint' + (walking ? ' walk' : '')}>
                {walking ? 'W A S D / 方向鍵移動 · 滑鼠轉頭(沒鎖定時按住左鍵拖曳)· Shift 走快一點 · Esc 離開'
                  : '左鍵旋轉 · 右鍵平移 · 滾輪縮放 · 點門可以開關'}
              </div>
            </div>
          </div>
          {status.kind === 'busy' && <div className="spinner">辨識中…</div>}
        </div>

        {scene && (
          <aside className="right">
            <Inspector editor={editor} tool={tool} furnitureType={furnitureType}
              onFurnitureType={(t) => { setFurnitureType(t); setTool('furniture') }} onTool={setTool} />
          </aside>
        )}
      </main>

      {sharing && scene && <ShareDialog scene={scene} name={name} onClose={() => setSharing(false)} />}
      {measure && (
        <div className="modal" onClick={() => setMeasure(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); applyMeasure() }}>
            <h2>比例尺校正</h2>
            <p>剛才量的兩點在圖上是 <b>{Math.round(dist(measure.a, measure.b))} mm</b>,實際長度是多少?</p>
            <div className="field">
              <label>實際長度</label>
              <span><input type="number" autoFocus min={1} value={measure.value} onChange={(e) => setMeasure({ ...measure, value: e.target.value })} /> mm</span>
            </div>
            <p className="note">整張圖(牆、門窗、家具、原圖)會等比例縮放,高度不變。</p>
            <div className="row">
              <button type="submit" className="primary">套用</button>
              <button type="button" onClick={() => setMeasure(null)}>取消</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
