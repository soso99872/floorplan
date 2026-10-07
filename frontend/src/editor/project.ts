// 專案檔(.fp3d.json)與瀏覽器自動存檔
import type { Scene } from '../scene/types'

const APP = 'floorplan-3d'
const SUPPORTED_VERSION = 1
const AUTOSAVE_KEY = 'fp3d.autosave'

export interface Project {
  name: string
  scene: Scene
  savedAt?: string
}

export function projectBlob(p: Project): Blob {
  const data = { app: APP, name: p.name, savedAt: new Date().toISOString(), scene: p.scene }
  return new Blob([JSON.stringify(data)], { type: 'application/json' })
}

/** 讀專案檔;也接受之前「下載場景檔」存的純 Scene JSON */
export function parseProject(text: string, fallbackName: string): Project {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('不是有效的專案檔(JSON 格式錯誤)')
  }
  const obj = data as { app?: string; name?: string; savedAt?: string; scene?: Scene } & Partial<Scene>
  const scene = (obj.app === APP ? obj.scene : obj) as Scene | undefined
  if (!scene || !Array.isArray(scene.walls) || !Array.isArray(scene.openings) || !scene.meta) {
    throw new Error('不是平面圖專案檔')
  }
  if (scene.version > SUPPORTED_VERSION) throw new Error('這個專案檔是較新版本的程式存的,請更新後再開')
  return {
    name: obj.app === APP && obj.name ? obj.name : fallbackName,
    savedAt: obj.savedAt,
    scene: { ...scene, rooms: scene.rooms ?? [], furniture: scene.furniture ?? [] },
  }
}

/** 自動存到瀏覽器;原圖太大存不下時,改成不含原圖再存一次 */
export function autosave(p: Project) {
  const write = (scene: Scene) =>
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ app: APP, name: p.name, savedAt: new Date().toISOString(), scene }))
  try {
    write(p.scene)
  } catch {
    try {
      write({ ...p.scene, meta: { ...p.scene.meta, background: null } })
    } catch { /* 瀏覽器不讓存就算了,不影響編輯 */ }
  }
}

export function loadAutosave(): Project | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY)
    return text ? parseProject(text, 'floorplan') : null
  } catch {
    return null
  }
}

export function clearAutosave() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY)
  } catch { /* 忽略 */ }
}
