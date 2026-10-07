import { useEffect, useRef } from 'react'
import { Viewer } from '../three/Viewer'

/** 把 Viewer(three.js)掛到畫面上;onReady 把實例交給父元件操作 */
export function Viewer3D({ onReady }: { onReady: (v: Viewer | null) => void }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const v = new Viewer(host.current!)
    onReady(v)
    ;(window as unknown as { viewer: Viewer }).viewer = v // 方便在瀏覽器主控台檢查
    return () => {
      onReady(null)
      v.dispose()
    }
  }, [onReady])
  return <div ref={host} className="view3d" />
}
