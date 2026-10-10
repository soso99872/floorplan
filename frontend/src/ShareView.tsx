// 客戶打開分享連結(/s/<id>)看到的唯讀畫面:只有 3D 和面積,沒有任何編輯功能。
import { useCallback, useEffect, useState } from 'react'
import { getLang, setLang, t, type Lang } from './i18n'
import { getShare, type SharedScene } from './api'
import { Viewer3D } from './components/Viewer3D'
import { PING_M2, roomRows } from './export/tables'
import { FLOOR_MATERIALS, floorMaterialId } from './scene/materials'
import type { Viewer, ViewName } from './three/Viewer'

// 手機、平板沒有鍵盤,不能用 W A S D 走路
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

const VIEWS: [ViewName, string][] = [['iso', '等角'], ['top', '平面'], ['front', '前'], ['right', '側']]

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default function ShareView({ id }: { id: string }) {
  const [data, setData] = useState<SharedScene | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [view, setView] = useState<ViewName>('iso')
  const [doorsOpen, setDoorsOpen] = useState(false)
  const [ceiling, setCeiling] = useState(false)
  const [walking, setWalking] = useState(false)
  const [cut, setCut] = useState(false)
  const [night, setNight] = useState(false)
  const [panel, setPanel] = useState(true)
  const [, setLangState] = useState<Lang>(getLang())

  useEffect(() => {
    getShare(id).then((d) => { setData(d); document.title = `${d.name} · 3D 空間` }).catch((e: Error) => setError(e.message))
  }, [id])

  const onReady = useCallback((v: Viewer | null) => setViewer(v), [])

  useEffect(() => {
    if (!viewer || !data) return
    viewer.onWalkChange = setWalking
    viewer.onDoorsChange = () => setDoorsOpen(viewer.allDoorsOpen)
    viewer.setScene(data.scene)
  }, [viewer, data])

  if (error) return <div className="share-error"><h1>{t("無法開啟")}</h1><p>{error}</p></div>

  const rooms = data ? roomRows(data.scene) : []
  const total = rooms.reduce((s, r) => s + r.area, 0)

  return (
    <div className="share-page">
      <header>
        <h1>{data?.name ?? t('載入中…')}</h1>
        {data && <span className="sub">更新於 {new Date(data.updated * 1000).toLocaleDateString()} · 室內 {total.toFixed(1)} m²({(total / PING_M2).toFixed(1)} 坪)</span>}
        <span className="spacer" />
        <button onClick={() => { const l = getLang() === 'zh' ? 'en' : 'zh'; setLang(l); setLangState(l) }}>{getLang() === 'zh' ? 'EN' : '中文'}</button>
        <button onClick={() => setPanel(!panel)}>{t(panel ? '隱藏面積' : '面積表')}</button>
      </header>
      <main className={panel ? 'with-panel' : ''}>
        <div className="pane view-pane">
          <div className="toolbar">
            {VIEWS.map(([v, label]) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => { setView(v); viewer?.setView(v) }}>{t(label)}</button>
            ))}
            {viewer && viewer.doors.length > 0 && (
              <button className={doorsOpen ? 'on' : ''} onClick={() => viewer.setAllDoors(!doorsOpen)}>{t(doorsOpen ? '關門' : '開門')}</button>
            )}
            <button className={ceiling ? 'on' : ''} onClick={() => { setCeiling(!ceiling); viewer?.setDisplay({ ceiling: !ceiling }) }}>{t("天花板")}</button>
            <button className={cut ? 'on' : ''} onClick={() => { setCut(!cut); viewer?.setDisplay({ cut: !cut }) }}>{t("剖切")}</button>
            <button className={night ? 'on' : ''} onClick={() => { setNight(!night); viewer?.setDisplay({ night: !night }) }}>{t("夜景")}</button>
            <button className={walking ? 'on' : ''} onClick={() => (walking ? viewer?.stopWalk() : viewer?.startWalk())}>{t(walking ? '離開' : '走進去')}</button>
            <button onClick={async () => viewer && download(await viewer.screenshotHiRes(), `${data?.name ?? '3D'}.png`)}>{t("存圖")}</button>
          </div>
          {!data && <div className="empty">{t("載入中…")}</div>}
          <Viewer3D onReady={onReady} />
          <div className={'hint' + (walking ? ' walk' : '')}>
            {walking ? (TOUCH ? '左下搖桿移動 · 拖曳畫面轉頭 · 點門開關' : 'W A S D / 方向鍵移動 · 滑鼠轉頭 · E 開門 · Esc 離開') : TOUCH ? '單指旋轉 · 雙指縮放、平移 · 點門可以開關' : '拖曳旋轉 · 右鍵平移 · 滾輪縮放 · 點門可以開關'}
          </div>
        </div>
        {panel && data && (
          <aside>
            <h2>{t("房間面積")}</h2>
            <table className="rooms">
              <tbody>
                {data.scene.rooms.map((r, i) => (
                  <tr key={r.id} onClick={() => viewer?.flyToRoom(r.polygon)} title={t("點一下鏡頭飛過去")}>
                    <td><i className="swatch" style={{ background: FLOOR_MATERIALS[floorMaterialId(r)].swatch }} />{r.name}</td>
                    <td className="num">{rooms[i].area.toFixed(1)} m²</td>
                    <td className="num muted">{rooms[i].ping.toFixed(1)} {t('坪')}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>{t("合計")}</td><td className="num">{total.toFixed(1)} m²</td><td className="num muted">{(total / PING_M2).toFixed(1)} {t('坪')}</td></tr>
              </tfoot>
            </table>
            <p className="note">{t("面積為牆內淨面積,僅供參考,實際以現場丈量為準。")}</p>
          </aside>
        )}
      </main>
    </div>
  )
}
