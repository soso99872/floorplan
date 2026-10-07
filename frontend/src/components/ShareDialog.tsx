// 分享對話框:建立分享連結、用目前的編輯更新既有連結(客戶手上的網址不變)、停止分享。
// 沒有帳號,所以「我建立過的分享」和管理用的 token 存在這台電腦的瀏覽器裡。
import { useState } from 'react'
import { createShare, deleteShare, updateShare } from '../api'
import type { Scene } from '../scene/types'

const KEY = 'fp3d.shares'

interface MyShare { id: string; token: string; name: string; created: string; updated: string }

function load(): MyShare[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

function save(list: MyShare[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch { /* 存不下就算了,連結本身還是有效 */ }
}

const shareUrl = (id: string) => `${location.origin}/s/${id}`

export function ShareDialog({ scene, name, onClose }: { scene: Scene; name: string; onClose: () => void }) {
  const [list, setList] = useState<MyShare[]>(load)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const update = (next: MyShare[]) => { setList(next); save(next) }

  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setMsg(null)
    try { await fn() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(shareUrl(id))
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setMsg({ ok: false, text: '無法自動複製,請手動選取連結複製' })
    }
  }

  const now = () => new Date().toISOString()
  const fmt = (iso: string) => new Date(iso).toLocaleString()

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h2>分享給客戶</h2>
        <p className="note">
          拿到連結的人可以看 3D(旋轉、走進去、開門、看面積),但不能修改。之後改了設計,按「更新」就會套用到同一個連結,客戶不用換網址。
        </p>
        <button className="primary" disabled={busy} onClick={() => act(async () => {
          const r = await createShare(name, scene)
          update([{ id: r.id, token: r.token, name, created: now(), updated: now() }, ...list])
          await copy(r.id)
          setMsg({ ok: true, text: '已建立分享連結,並複製到剪貼簿' })
        })}>建立新的分享連結</button>

        {list.length > 0 && <h2 className="sub">我建立的分享(這台電腦)</h2>}
        <div className="shares">
          {list.map((s) => (
            <div key={s.id} className="share">
              <div className="share-head">
                <b>{s.name}</b>
                <span className="muted">更新於 {fmt(s.updated)}</span>
              </div>
              <input readOnly value={shareUrl(s.id)} onFocus={(e) => e.target.select()} />
              <div className="row">
                <button onClick={() => copy(s.id)}>{copied === s.id ? '已複製 ✓' : '複製連結'}</button>
                <a href={shareUrl(s.id)} target="_blank" rel="noreferrer"><button>開啟</button></a>
                <button disabled={busy} title={`把目前的編輯「${name}」套用到這個連結`} onClick={() => act(async () => {
                  await updateShare(s.id, s.token, name, scene)
                  update(list.map((x) => (x.id === s.id ? { ...x, name, updated: now() } : x)))
                  setMsg({ ok: true, text: `已更新「${name}」,客戶重新整理就會看到` })
                })}>用目前的編輯更新</button>
                <button className="danger" disabled={busy} onClick={() => act(async () => {
                  await deleteShare(s.id, s.token)
                  update(list.filter((x) => x.id !== s.id))
                  setMsg({ ok: true, text: '已停止分享,這個連結不能再開啟' })
                })}>停止分享</button>
              </div>
            </div>
          ))}
        </div>
        {msg && <div className={'status ' + (msg.ok ? 'ok' : 'error')}>{msg.text}</div>}
        <div className="row right">
          <button onClick={onClose}>關閉</button>
        </div>
      </div>
    </div>
  )
}
