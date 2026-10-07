// 編輯器狀態:目前的 Scene、選取、復原/重做堆疊。
// apply(next, mergeKey):同一個 mergeKey 連續套用只算一筆歷史(拖曳過程、在輸入框連續打字)。
import { useCallback, useMemo, useReducer } from 'react'
import type { Scene } from '../scene/types'
import type { Sel } from './commands'

const HISTORY_LIMIT = 100

interface State {
  scene: Scene | null
  past: Scene[]
  future: Scene[]
  sel: Sel | null
  lastKey: string | null
}

type Action =
  | { type: 'load'; scene: Scene }
  | { type: 'apply'; scene: Scene; key?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; sel: Sel | null }
  | { type: 'endMerge' }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'load':
      return { scene: a.scene, past: [], future: [], sel: null, lastKey: null }
    case 'apply': {
      if (!s.scene || a.scene === s.scene) return s
      const merge = a.key !== undefined && a.key === s.lastKey
      const past = merge ? s.past : [...s.past, s.scene].slice(-HISTORY_LIMIT)
      return { ...s, scene: a.scene, past, future: [], lastKey: a.key ?? null, sel: validSel(a.scene, s.sel) }
    }
    case 'undo': {
      if (!s.scene || !s.past.length) return s
      const scene = s.past[s.past.length - 1]
      return { ...s, scene, past: s.past.slice(0, -1), future: [s.scene, ...s.future], lastKey: null, sel: validSel(scene, s.sel) }
    }
    case 'redo': {
      if (!s.scene || !s.future.length) return s
      const scene = s.future[0]
      return { ...s, scene, past: [...s.past, s.scene], future: s.future.slice(1), lastKey: null, sel: validSel(scene, s.sel) }
    }
    case 'select':
      return { ...s, sel: a.sel, lastKey: null }
    case 'endMerge':
      return { ...s, lastKey: null }
  }
}

/** 選取的東西被刪掉(或復原後不存在)就取消選取 */
function validSel(scene: Scene, sel: Sel | null): Sel | null {
  if (!sel) return null
  const list = { wall: scene.walls, opening: scene.openings, furniture: scene.furniture, room: scene.rooms }[sel.kind]
  return list.some((x) => x.id === sel.id) ? sel : null
}

export function useEditor() {
  const [state, dispatch] = useReducer(reducer, { scene: null, past: [], future: [], sel: null, lastKey: null })
  const load = useCallback((scene: Scene) => dispatch({ type: 'load', scene }), [])
  const apply = useCallback((scene: Scene, key?: string) => dispatch({ type: 'apply', scene, key }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  const select = useCallback((sel: Sel | null) => dispatch({ type: 'select', sel }), [])
  /** 結束一段合併(放開滑鼠、離開輸入框):下一次修改會是新的一筆歷史 */
  const endMerge = useCallback(() => dispatch({ type: 'endMerge' }), [])
  return useMemo(() => ({
    scene: state.scene, sel: state.sel,
    canUndo: state.past.length > 0, canRedo: state.future.length > 0,
    load, apply, undo, redo, select, endMerge,
  }), [state, load, apply, undo, redo, select, endMerge])
}

export type Editor = ReturnType<typeof useEditor>
