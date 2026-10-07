// 3D 檢視器:相機、燈光、視角、顯示模式、開關門、匯出。跟 React 無關,由 Viewer3D 元件掛到畫面上。
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { exportObjZip } from '../export/obj'
import type { Point, Scene } from '../scene/types'
import { buildScene, distToSegment, doorOfMesh, type BuiltScene, type DoorHandle } from './sceneBuilder'

export type ViewName = 'iso' | 'front' | 'top' | 'right'

const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [0.45, -1, 0.8], // 平面圖又扁又寬:視角放低一點才看得出牆高和房間
  front: [0, -1, 0],
  top: [0, 0, 1],
  right: [1, 0, 0],
}
const OPEN_DEG = 80
const EYE_HEIGHT = 1600 // 第一人稱的眼睛高度 mm
const WALK_SPEED = 1400 // mm/s,按住 Shift 加快
const BODY_RADIUS = 220 // 走動時離牆至少這麼遠
const SCREENSHOT_WIDTH = 3840

/** 第一人稱走動的狀態 */
interface Walk {
  pos: Point
  yaw: number
  pitch: number
  keys: Set<string>
  /** 滑鼠曾經鎖定成功過 */
  locked: boolean
  saved: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 }
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer
  readonly camera = new THREE.PerspectiveCamera(35, 1, 10, 1e6)
  readonly controls: OrbitControls
  private scene3d = new THREE.Scene()
  private built: BuiltScene | null = null
  private floor: THREE.Mesh | null = null
  private sun = new THREE.DirectionalLight(0xffffff, 1.6)
  private raycaster = new THREE.Raycaster()
  private downAt: [number, number] | null = null
  private resizeObserver: ResizeObserver
  private wire = false
  private xray = false
  /** 最近一次自動對準的視角;使用者動過相機就清掉,之後畫面大小改變時不再自動重新對準 */
  private autoView: ViewName | null = null
  private showPlan = false
  private showCeiling = false
  private walk: Walk | null = null
  private lastFrame = performance.now()
  /** 門的狀態改變時通知外面(更新按鈕文字) */
  onDoorsChange: (() => void) | null = null
  /** 進入 / 離開第一人稱時通知外面 */
  onWalkChange: ((walking: boolean) => void) | null = null

  private host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.9
    host.appendChild(this.renderer.domElement)
    this.scene3d.background = new THREE.Color('#20252e')
    // 室內環境光(反射、柔和的補光),比單純的半球光更像真的房間
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene3d.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene3d.environmentIntensity = 0.4
    this.camera.up.set(0, 0, 1) // 建築習慣 Z 朝上
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.addEventListener('start', () => { this.autoView = null })

    this.scene3d.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.45))
    this.sun.intensity = 2.4
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.normalBias = 12
    this.sun.shadow.bias = -0.0002
    this.scene3d.add(this.sun, this.sun.target)
    const headlight = new THREE.DirectionalLight(0xffffff, 0.6)
    this.camera.add(headlight)
    this.scene3d.add(this.camera)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.resize()
    this.bindPointer()
    this.bindWalkInput()
    this.renderer.setAnimationLoop(() => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000)
      this.lastFrame = now
      if (this.walk) this.stepWalk(dt)
      else this.controls.update()
      this.animateDoors()
      this.renderer.render(this.scene3d, this.camera)
    })
  }

  dispose() {
    this.stopWalk()
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.renderer.setSize(w, h)
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
    if (this.autoView && w > 0 && h > 0) this.setView(this.autoView)
  }

  /** 載入(或重新載入)場景;keepView = true 時保留目前視角(編輯後更新用) */
  setScene(scene: Scene, keepView = false) {
    const first = !this.built
    const prevDoors = new Map(this.built?.doors.map((d) => [d.openingId, d]) ?? [])
    if (this.built) this.scene3d.remove(this.built.root)
    if (this.floor) this.scene3d.remove(this.floor)
    this.built = buildScene(scene)
    this.scene3d.add(this.built.root)
    for (const d of this.built.doors) { // 重建後保留每扇門原本的開關狀態
      const prev = prevDoors.get(d.openingId)
      if (prev) { d.open = prev.open; d.t = prev.t; this.poseDoor(d) }
    }

    const bg = scene.meta.background
    if (bg) {
      // 原圖當地板貼圖:圖片左下角對齊模型原點
      const tex = new THREE.TextureLoader().load(bg.src)
      tex.colorSpace = THREE.SRGBColorSpace
      this.floor = new THREE.Mesh(new THREE.PlaneGeometry(bg.width, bg.height), new THREE.MeshBasicMaterial({ map: tex }))
      this.floor.position.set(bg.width / 2, bg.height / 2, -1)
      this.floor.visible = this.showPlan || !scene.rooms.length
      this.scene3d.add(this.floor)
    }
    this.built.ceilings.visible = this.showCeiling || !!this.walk
    this.fitSun()
    this.applyMaterialMode()
    if (this.walk) return this.onDoorsChange?.()
    if (!keepView || first) this.setView('iso')
    this.onDoorsChange?.()
  }

  /** 太陽光的陰影範圍罩住整個模型 */
  private fitSun() {
    if (!this.built) return
    const b = this.built.bounds
    const c = b.getCenter(new THREE.Vector3())
    const r = b.getSize(new THREE.Vector3()).length() / 2
    // 陽光從等角視角的另一側斜照進來,牆和家具的影子才會落在看得到的那一側
    this.sun.position.copy(c).add(new THREE.Vector3(-1.2, 1.6, 2.2).normalize().multiplyScalar(r * 3))
    this.sun.target.position.copy(c)
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -r * 1.1
    cam.right = cam.top = r * 1.1
    cam.near = r
    cam.far = r * 5
    cam.updateProjectionMatrix()
  }

  setView(name: ViewName) {
    if (!this.built || this.walk) return
    this.autoView = name
    const b = this.built.bounds
    const c = b.getCenter(new THREE.Vector3())
    const r = b.getSize(new THREE.Vector3()).length() / 2
    const dir = new THREE.Vector3(...VIEW_DIRS[name]).normalize()
    this.camera.near = r / 500
    this.camera.far = r * 40
    this.camera.updateProjectionMatrix()
    this.camera.up.set(0, name === 'top' ? 1 : 0, name === 'top' ? 0 : 1)
    // 依比較窄的那個方向的視野決定距離:並排模式的 3D 畫面常常是直的,只看垂直視野會左右被裁掉
    const halfV = THREE.MathUtils.degToRad(this.camera.fov / 2)
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * this.camera.aspect))
    let dist = r / Math.sin(half) * (name === 'iso' && this.camera.aspect >= 1 ? 0.85 : 1.05)
    if (name === 'top') {
      // 俯視:直接讓平面的長寬貼合畫面(用外接球會留太多白)
      const size = b.getSize(new THREE.Vector3())
      const tanV = Math.tan(halfV), tanH = tanV * this.camera.aspect
      dist = Math.max(size.y / 2 / tanV, size.x / 2 / tanH) * 1.08 + size.z
    }
    this.camera.position.copy(c).addScaledVector(dir, dist)
    this.controls.target.copy(c)
    this.controls.update()
  }

  setDisplay(opt: { wire?: boolean; xray?: boolean; furniture?: boolean; plan?: boolean; ceiling?: boolean }) {
    if (opt.wire !== undefined) this.wire = opt.wire
    if (opt.xray !== undefined) this.xray = opt.xray
    if (opt.plan !== undefined) this.showPlan = opt.plan
    if (opt.ceiling !== undefined) this.showCeiling = opt.ceiling
    if (opt.furniture !== undefined && this.built) this.built.furniture.visible = opt.furniture
    if (this.floor) this.floor.visible = this.showPlan
    if (this.built) this.built.ceilings.visible = this.showCeiling || !!this.walk
    this.applyMaterialMode()
  }

  private applyMaterialMode() {
    if (!this.built) return
    const mat = this.built.walls.material as THREE.MeshStandardMaterial
    mat.visible = !this.wire
    mat.transparent = this.xray
    mat.opacity = this.xray ? 0.35 : 1
    mat.depthWrite = !this.xray
    const edge = this.built.wallEdges.material as THREE.LineBasicMaterial
    edge.depthTest = !this.xray // 透視時看得到被擋住的邊
    edge.color.set(this.wire || this.xray ? 0xe3ebf7 : 0x14202e) // 沒有牆面當底色時,深色邊會跟背景混在一起
  }

  // ---------- 開關門 ----------

  get doors(): DoorHandle[] {
    return this.built?.doors ?? []
  }

  get allDoorsOpen(): boolean {
    return this.doors.length > 0 && this.doors.every((d) => d.open)
  }

  setAllDoors(open: boolean) {
    for (const d of this.doors) d.open = open
    this.onDoorsChange?.()
  }

  private poseDoor(d: DoorHandle) {
    const ease = d.t * d.t * (3 - 2 * d.t)
    for (const pv of d.pivots) pv.rotation.z = -pv.userData.side * THREE.MathUtils.degToRad(OPEN_DEG) * ease
  }

  private animateDoors() {
    for (const d of this.doors) {
      const target = d.open ? 1 : 0
      if (Math.abs(d.t - target) < 1e-3) continue
      d.t += Math.sign(target - d.t) * Math.min(0.06, Math.abs(target - d.t))
      this.poseDoor(d)
    }
  }

  private pick(e: PointerEvent): THREE.Intersection | undefined {
    if (!this.built) return undefined
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster.intersectObjects(this.built.root.children, true).find((h) => isVisible(h.object))
  }

  private bindPointer() {
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', (e) => { this.downAt = [e.clientX, e.clientY] })
    // 點一下門片只開關那一扇;拖曳旋轉視角時不觸發
    el.addEventListener('pointerup', (e) => {
      if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return
      const hit = this.pick(e)
      const door = hit && doorOfMesh.get(hit.object)
      if (door) { door.open = !door.open; this.onDoorsChange?.() }
    })
    el.addEventListener('pointermove', (e) => {
      if (e.buttons || !this.doors.length) return
      const hit = this.pick(e)
      el.style.cursor = hit && doorOfMesh.has(hit.object) ? 'pointer' : ''
    })
  }

  // ---------- 匯出 ----------

  /** 匯出 GLB(含顏色),門一律關著;給 SketchUp、Blender、網頁展示用 */
  async exportGLB(): Promise<Blob> {
    const root = this.exportClone()
    root.scale.setScalar(0.001) // glTF 單位是公尺
    root.rotation.x = -Math.PI / 2 // glTF 是 Y 朝上
    const data = await new GLTFExporter().parseAsync(root, { binary: true })
    return new Blob([data as ArrayBuffer], { type: 'model/gltf-binary' })
  }

  /** OBJ + MTL + 貼圖的 zip(給 SketchUp 等) */
  async exportOBJ(name: string): Promise<Blob> {
    return exportObjZip(this.exportClone(), name)
  }

  /** 匯出用的模型複本:門一律關著、不含顯示用的稜線 */
  private exportClone(): THREE.Object3D {
    if (!this.built) throw new Error('還沒有模型')
    const saved = this.doors.map((d) => d.t)
    for (const d of this.doors) { d.t = 0; this.poseDoor(d) }
    const root = this.built.root.clone()
    root.remove(...root.children.filter((c) => c instanceof THREE.LineSegments))
    this.doors.forEach((d, i) => { d.t = saved[i]; this.poseDoor(d) })
    return root
  }

  /** 用指定視角另外算一張圖(報告用),不影響使用者目前的畫面 */
  renderView(name: ViewName, width: number, height: number): string {
    if (!this.built) throw new Error('還沒有模型')
    const size = this.renderer.getSize(new THREE.Vector2())
    const ratio = this.renderer.getPixelRatio()
    const saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone(), auto: this.autoView }
    const bg = this.scene3d.background
    this.scene3d.background = new THREE.Color('#ffffff') // 報告要列印,白底比較好看
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.setView(name)
    this.renderer.render(this.scene3d, this.camera)
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.9)
    this.scene3d.background = bg
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(size.x, size.y, false)
    this.camera.aspect = size.x / Math.max(size.y, 1)
    this.camera.position.copy(saved.pos)
    this.camera.up.copy(saved.up)
    this.controls.target.copy(saved.target)
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.autoView = saved.auto
    return url
  }

  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png')
  }

  /** 高解析截圖:目前的視角放大到寬 3840 px 重新算一張 */
  async screenshotHiRes(): Promise<Blob> {
    const size = this.renderer.getSize(new THREE.Vector2())
    const ratio = this.renderer.getPixelRatio()
    const scale = Math.min(SCREENSHOT_WIDTH / Math.max(size.x, 1), 8192 / Math.max(size.x, size.y, 1))
    this.renderer.setPixelRatio(scale)
    this.renderer.render(this.scene3d, this.camera)
    const blob = await new Promise<Blob | null>((ok) => this.renderer.domElement.toBlob(ok, 'image/png'))
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(size.x, size.y)
    if (!blob) throw new Error('截圖失敗')
    return blob
  }

  // ---------- 第一人稱 ----------

  get walking() {
    return !!this.walk
  }

  /** 走進去:從最大的房間中間開始;滑鼠看方向,W A S D / 方向鍵移動,Esc 離開 */
  startWalk() {
    if (!this.built || this.walk) return
    const b = this.built.bounds
    const start = this.built.walkStart ?? [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2]
    this.walk = {
      pos: [start[0], start[1]], yaw: Math.PI / 2, pitch: -0.08, keys: new Set(), locked: false,
      saved: { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() },
    }
    this.controls.enabled = false
    this.camera.up.set(0, 0, 1)
    this.camera.near = 50
    this.camera.far = 200000
    this.camera.updateProjectionMatrix()
    this.built.ceilings.visible = true
    this.applyMaterialMode()
    this.renderer.domElement.requestPointerLock?.()
    this.stepWalk(0)
    this.onWalkChange?.(true)
  }

  stopWalk() {
    const w = this.walk
    if (!w) return
    this.walk = null
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock()
    this.controls.enabled = true
    this.camera.up.copy(w.saved.up)
    this.camera.position.copy(w.saved.pos)
    this.controls.target.copy(w.saved.target)
    if (this.built) this.built.ceilings.visible = this.showCeiling
    if (this.autoView) this.setView(this.autoView)
    else this.controls.update()
    this.applyMaterialMode()
    this.onWalkChange?.(false)
  }

  private look(dx: number, dy: number) {
    if (!this.walk) return
    this.walk.yaw -= dx * 0.0025
    this.walk.pitch = Math.max(-1.3, Math.min(1.3, this.walk.pitch - dy * 0.0025))
  }

  private bindWalkInput() {
    const el = this.renderer.domElement
    const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']
    window.addEventListener('keydown', (e) => {
      if (!this.walk) return
      if (e.code === 'Escape') { this.stopWalk(); return }
      if (keys.includes(e.code)) { this.walk.keys.add(e.code); e.preventDefault() }
    })
    window.addEventListener('keyup', (e) => this.walk?.keys.delete(e.code))
    window.addEventListener('blur', () => this.walk?.keys.clear())
    document.addEventListener('mousemove', (e) => {
      if (this.walk && document.pointerLockElement === el) this.look(e.movementX, e.movementY)
    })
    // 沒有鎖定滑鼠時(瀏覽器不允許或按過 Esc 一次),按住左鍵拖曳也可以看
    el.addEventListener('pointermove', (e) => {
      if (this.walk && document.pointerLockElement !== el && e.buttons === 1) this.look(e.movementX, e.movementY)
    })
    // 鎖定滑鼠時按 Esc 會被瀏覽器拿去解除鎖定、頁面收不到按鍵,所以解除鎖定就等於離開
    document.addEventListener('pointerlockchange', () => {
      if (!this.walk) return
      if (document.pointerLockElement === el) this.walk.locked = true
      else if (this.walk.locked) this.stopWalk()
    })
  }

  private stepWalk(dt: number) {
    const w = this.walk!
    const k = w.keys
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    if (f || s) {
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.2 : 1) * WALK_SPEED * dt
      const fx = Math.cos(w.yaw), fy = Math.sin(w.yaw)
      let dx = fx * f + fy * s, dy = fy * f - fx * s
      const n = Math.hypot(dx, dy)
      dx = (dx / n) * speed
      dy = (dy / n) * speed
      // 撞牆就沿著牆滑:先試整步,不行再只走 x 或只走 y
      for (const [mx, my] of [[dx, dy], [dx, 0], [0, dy]]) {
        const next: Point = [w.pos[0] + mx, w.pos[1] + my]
        if (!this.blocked(next)) { w.pos = next; break }
      }
    }
    const cp = Math.cos(w.pitch)
    this.camera.position.set(w.pos[0], w.pos[1], EYE_HEIGHT)
    this.camera.lookAt(w.pos[0] + Math.cos(w.yaw) * cp, w.pos[1] + Math.sin(w.yaw) * cp, EYE_HEIGHT + Math.sin(w.pitch))
  }

  private blocked(p: Point) {
    return (this.built?.blockers ?? []).some(([a, b]) => distToSegment(p, a, b) < BODY_RADIUS)
  }
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  const m = (o as THREE.Mesh).material as THREE.Material | undefined
  return !m || m.visible !== false
}
