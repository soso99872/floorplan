import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

/** [名稱, 說明, 執行];執行時要同步開始(客戶報告要在點擊當下開新視窗,不然會被擋) */
export type ExportItem = [string, string, () => Promise<unknown>]

export function ExportMenu({ items, onError }: { items: ExportItem[]; onError: (e: Error) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  function run([label, , fn]: ExportItem) {
    setOpen(false)
    setBusy(label)
    fn().catch((e: Error) => onError(e)).finally(() => setBusy(null))
  }

  return (
    <div className="export-menu" ref={ref}>
      <button className="primary" disabled={!!busy} onClick={() => setOpen(!open)}>
        {busy ? `${t('匯出')} ${t(busy)}…` : t('匯出 ▾')}
      </button>
      {open && (
        <div className="menu">
          {items.map((it) => (
            <button key={it[0]} onClick={() => run(it)}>
              <b>{t(it[0])}</b>
              <span>{t(it[1])}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
