import { useCallback, useEffect, useRef, useState } from 'react'
import { listSamples, recognize, type RecognizeInput } from './api'
import { Viewer3D } from './components/Viewer3D'
import type { RecognizeResponse } from './scene/types'
import type { Viewer, ViewName } from './three/Viewer'

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string }

const VIEWS: [ViewName, string][] = [['iso', '等角'], ['front', '前'], ['top', '上'], ['right', '右']]

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [samples, setSamples] = useState<string[]>([])
  const [width, setWidth] = useState<number | ''>(12000)
  const [height, setHeight] = useState(3000)
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '上傳平面圖圖片,或點選範例' })
  const [result, setResult] = useState<RecognizeResponse | null>(null)
  const [name, setName] = useState('floorplan')
  const [view, setView] = useState<ViewName>('iso')
  const [display, setDisplay] = useState({ wire: false, xray: false, furniture: true })
  const [doorsOpen, setDoorsOpen] = useState(false)
  const [doorCount, setDoorCount] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const lastInput = useRef<Omit<RecognizeInput, 'width' | 'height'> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => { listSamples().then(setSamples) }, [])

  const onViewerReady = useCallback((v: Viewer | null) => setViewer(v), [])

  useEffect(() => {
    if (!viewer) return
    viewer.onDoorsChange = () => {
      setDoorsOpen(viewer.allDoorsOpen)
      setDoorCount(viewer.doors.length)
    }
    if (result) {
      viewer.setScene(result.scene)
      viewer.setDisplay(display)
      setView('iso')
    }
    // display 刻意不放進相依清單:只在載入新結果時套用一次,之後的切換由按鈕直接呼叫 setDisplay
  }, [viewer, result])

  async function run(input: Omit<RecognizeInput, 'width' | 'height'>) {
    lastInput.current = input
    setStatus({ kind: 'busy', text: '辨識中…' })
    try {
      const r = await recognize({ ...input, width: width || undefined, height })
      setResult(r)
      setName((input.file?.name ?? input.sample ?? 'floorplan').replace(/\.\w+$/, ''))
      setStatus({ kind: 'ok', text: width ? '已產生 3D 空間。尺寸依「外牆總寬」換算,請核對' : '已產生 3D 空間。尺寸是依牆厚估的,請核對並填入外牆總寬' })
    } catch (e) {
      setStatus({ kind: 'error', text: '✗ ' + (e as Error).message })
    }
  }

  function toggle(key: keyof typeof display) {
    const next = { ...display, [key]: !display[key] }
    setDisplay(next)
    viewer?.setDisplay(next)
  }

  const scene = result?.scene
  const counts = scene && {
    windows: scene.openings.filter((o) => o.kind === 'window').length,
    doors: scene.openings.filter((o) => o.kind === 'door').length,
    passages: scene.openings.filter((o) => o.kind === 'passage').length,
  }

  return (
    <div className="app">
      <header>
        <h1>平面圖 → 3D 空間</h1>
        <span className="sub">上傳平面圖圖片,自動辨識牆、門窗、房間與家具</span>
      </header>
      <main>
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
                if (f) run({ file: f })
              }}
            >
              把<b>平面圖圖片</b>拖到這裡,或點一下選檔
              <input ref={fileInput} type="file" accept=".png,.jpg,.jpeg,.webp,.bmp" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) run({ file: f }); e.target.value = '' }} />
            </div>
            {samples.length > 0 && (
              <div className="row">
                <span className="muted">範例:</span>
                {samples.map((s) => <button key={s} onClick={() => run({ sample: s })}>{s.replace(/\.\w+$/, '')}</button>)}
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
            </div>
            <p className="note">比例尺依「外牆總寬」換算:圖上最左到最右外牆外緣的實際長度。不知道可以留空,會依牆厚自動估算(較不準)。</p>
            <button disabled={!lastInput.current || status.kind === 'busy'} onClick={() => lastInput.current && run(lastInput.current)}>
              用新數字重新辨識
            </button>
          </section>

          <section><div className={'status ' + status.kind}>{status.text}</div></section>

          {result && scene && counts && (
            <>
              <section>
                <h2>辨識結果(疊在原圖上)</h2>
                <img className="overlay" src={result.overlay} alt="辨識結果" />
                <div className="legend">
                  <span><i style={{ background: '#dc2828' }} />牆</span>
                  <span><i style={{ background: '#1e8cdc' }} />窗</span>
                  <span><i style={{ background: '#3cb43c' }} />門 / 開口</span>
                  <span><i style={{ background: '#c83cc8' }} />家具</span>
                </div>
              </section>
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
                <h2>房間({scene.rooms.length})</h2>
                <table>
                  <tbody>
                    {scene.rooms.map((r) => (
                      <tr key={r.id}>
                        <td><i className="swatch" style={{ background: r.floor_color }} />{r.name}</td>
                        <td className="num">{r.area.toFixed(1)} m²</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section>
                <h2>辨識紀錄</h2>
                <pre className="log">{result.log.join('\n')}</pre>
              </section>
            </>
          )}
        </aside>

        <div className="stage">
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
          </div>
          {result && viewer && (
            <div className="downloads">
              <button onClick={async () => download(await viewer.exportGLB(), `${name}.glb`)}>下載 GLB</button>
              <button onClick={() => download(new Blob([JSON.stringify(result.scene)], { type: 'application/json' }), `${name}.scene.json`)}>
                下載場景檔
              </button>
            </div>
          )}
          {!result && <div className="empty">左邊上傳平面圖圖片,或點選範例</div>}
          {status.kind === 'busy' && <div className="spinner">辨識中…</div>}
          <Viewer3D onReady={onViewerReady} />
          <div className="hint">左鍵旋轉 · 右鍵平移 · 滾輪縮放 · 點門可以開關</div>
        </div>
      </main>
    </div>
  )
}
