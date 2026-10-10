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
const CUT_HEIGHT = 1200 // 剖切牆的高度 mm
const DOOR_REACH = 1800 // 走動時按 E 能開的門的距離
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
  /** 觸控搖桿的方向(-1~1),沒在推就是 null */
  stick: [number, number] | null
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
  private hemi = new THREE.HemisphereLight(0xffffff, 0x445066, 0.45)
  private headlight = new THREE.DirectionalLight(0xffffff, 0.6)
  private sunHour = 15
  private night = false
  private cut = false
  private nightLights = new THREE.Group()
  private fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null
  private dragF: { id: string; off: [number, number]; sx: number; sy: number; moved: boolean } | null = null
  private lastTouch: [number, number] | null = null
  private stickEl: HTMLDivElement | null = null
  /** 在 3D 裡拖家具:done = 放開滑鼠 */
  onFurnitureDrag: ((id: string, x: number, y: number, done: boolean) => void) | null = null
  /** 在 3D 裡點一下家具(選取) */
  onFurnitureClick: ((id: string) => void) | null = null
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

    this.scene3d.add(this.hemi, this.nightLights)
    this.sun.intensity = 2.4
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.normalBias = 12
    this.sun.shadow.bias = -0.0002
    this.scene3d.add(this.sun, this.sun.target)
    this.camera.add(this.headlight)
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
      else {
        if (this.fly) this.stepFly(dt)
        this.controls.update()
      }
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
    this.applyLighting()
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
    // 日照時間:6 點從東邊(+x)升起、18 點落到西邊;下午三點左右的影子落在等角視角看得到的那一側
    const th = (Math.PI * (Math.min(18.5, Math.max(5.5, this.sunHour)) - 6)) / 12
    const elev = Math.max(0.05, Math.sin(th))
    const dir = new THREE.Vector3(Math.cos(th), Math.sin(th) * 0.8 + 0.6, elev * 1.6 + 0.25).normalize()
    this.sun.position.copy(c).add(dir.multiplyScalar(r * 3))
    this.sun.color.setRGB(1, 0.75 + 0.25 * elev, 0.5 + 0.5 * elev) // 太陽低的時候偏暖
    this.sun.intensity = this.night ? 0 : 0.6 + 1.8 * elev
    this.sun.target.position.copy(c)
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -r * 1.1
    cam.right = cam.top = r * 1.1
    cam.near = r
    cam.far = r * 5
    cam.updateProjectionMatrix()
  }

  /** 夜景:關掉陽光、環境光調暗,每個房間天花板下放一盞暖色燈 */
  private applyLighting() {
    this.nightLights.clear()
    const env = this.night ? 0.06 : 0.4
    this.scene3d.environmentIntensity = env
    this.hemi.intensity = this.night ? 0.06 : 0.45
    this.headlight.intensity = this.night ? 0.05 : 0.6
    this.renderer.toneMappingExposure = this.night ? 1.25 : 0.9
    this.scene3d.background = new THREE.Color(this.night ? '#0b1020' : '#20252e')
    if (this.night && this.built) {
      const h = this.built.bounds.max.z
      for (const r of this.built.rooms) {
        const lamp = new THREE.PointLight(0xffd8a8, 0, 0, 2)
        const size = Math.sqrt(r.area) * 1000
        lamp.intensity = 2.2e6 * Math.max(1, r.area / 12) // 依房間大小調亮度(單位是 mm)
        lamp.distance = size * 2.5
        lamp.position.set(r.center[0], r.center[1], h - 250)
        this.nightLights.add(lamp)
      }
    }
    this.fitSun()
  }

  /** 鏡頭飛到某個房間上方斜看 */
  flyToRoom(poly: Point[]) {
    if (!this.built || this.walk || poly.length < 3) return
    const box = new THREE.Box2().setFromPoints(poly.map(([x, y]) => new THREE.Vector2(x, y)))
    const c = box.getCenter(new THREE.Vector2())
    const size = box.getSize(new THREE.Vector2()).length()
    const target = new THREE.Vector3(c.x, c.y, 600)
    // 和 setView 一樣依比較窄的視野決定距離(並排時畫面是直的);角度偏俯視,牆才不會擋住房間
    const halfV = THREE.MathUtils.degToRad(this.camera.fov / 2)
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * this.camera.aspect))
    const dist = Math.max((size / 2 / Math.sin(half)) * 1.1, 4500)
    const pos = target.clone().add(new THREE.Vector3(0.3, -0.7, 1.6).normalize().multiplyScalar(dist))
    this.fly = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: target, t: 0 }
    this.camera.up.set(0, 0, 1)
    this.autoView = null
  }

  private stepFly(dt: number) {
    const f = this.fly!
    f.t = Math.min(1, f.t + dt / 0.7)
    const e = f.t * f.t * (3 - 2 * f.t)
    this.camera.position.lerpVectors(f.from, f.to, e)
    this.controls.target.lerpVectors(f.tFrom, f.tTo, e)
    if (f.t >= 1) this.fly = null
  }

  setView(name: ViewName) {
    if (!this.built || this.walk) return
    this.fly = null
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

  setDisplay(opt: { wire?: boolean; xray?: boolean; furniture?: boolean; plan?: boolean; ceiling?: boolean;
    cut?: boolean; night?: boolean; sunHour?: number }) {
    if (opt.cut !== undefined) {
      this.cut = opt.cut
      // 剖切:把 1.2 m 以上的東西切掉,從上面看得到房間裡面
      this.renderer.clippingPlanes = this.cut ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), CUT_HEIGHT)] : []
    }
    if (opt.sunHour !== undefined) this.sunHour = opt.sunHour
    if (opt.night !== undefined || opt.sunHour !== undefined) {
      if (opt.night !== undefined) this.night = opt.night
      this.applyLighting()
    }
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

  /** 滑鼠位置投到地板(z = 0)上的點 */
  private floorPoint(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3())
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
    el.addEventListener('pointerdown', (e) => {
      this.downAt = [e.clientX, e.clientY]
      if (this.walk || e.button !== 0) return
      const hit = this.pick(e)
      const fg = hit && furnitureOf(hit.object)
      const p = fg && this.floorPoint(e)
      if (fg && p) { // 按在家具上:拖家具,不轉鏡頭
        this.dragF = { id: fg.userData.furnitureId, off: [fg.position.x - p.x, fg.position.y - p.y], sx: e.clientX, sy: e.clientY, moved: false }
        this.controls.enabled = false
      }
    })
    // 點一下門片只開關那一扇;拖曳旋轉視角時不觸發
    el.addEventListener('pointerup', (e) => {
      const d = this.dragF
      if (d) {
        this.dragF = null
        this.controls.enabled = !this.walk
        const p = this.floorPoint(e)
        if (d.moved && p) this.onFurnitureDrag?.(d.id, p.x + d.off[0], p.y + d.off[1], true)
        else if (!d.moved) this.onFurnitureClick?.(d.id)
        return
      }
      if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return
      const hit = this.pick(e)
      const door = hit && doorOfMesh.get(hit.object)
      if (door) { door.open = !door.open; this.onDoorsChange?.() }
    })
    el.addEventListener('pointermove', (e) => {
      const d = this.dragF
      if (d) {
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return
        d.moved = true
        const p = this.floorPoint(e)
        if (p) this.onFurnitureDrag?.(d.id, p.x + d.off[0], p.y + d.off[1], false)
        return
      }
      if (e.buttons || this.walk) return
      const hit = this.pick(e)
      el.style.cursor = hit && doorOfMesh.has(hit.object) ? 'pointer' : hit && furnitureOf(hit.object) ? 'move' : ''
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
      pos: [start[0], start[1]], yaw: Math.PI / 2, pitch: -0.08, keys: new Set(), locked: false, stick: null,
      saved: { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() },
    }
    this.controls.enabled = false
    this.camera.up.set(0, 0, 1)
    this.camera.near = 50
    this.camera.far = 200000
    this.camera.updateProjectionMatrix()
    this.built.ceilings.visible = true
    this.applyMaterialMode()
    if (TOUCH) this.showStick()
    else this.renderer.domElement.requestPointerLock?.()
    this.stepWalk(0)
    this.onWalkChange?.(true)
  }

  stopWalk() {
    const w = this.walk
    if (!w) return
    this.walk = null
    this.stickEl?.remove()
    this.stickEl = null
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
      if (e.code === 'KeyE') { this.toggleNearestDoor(); return }
      if (keys.includes(e.code)) { this.walk.keys.add(e.code); e.preventDefault() }
    })
    window.addEventListener('keyup', (e) => this.walk?.keys.delete(e.code))
    window.addEventListener('blur', () => this.walk?.keys.clear())
    document.addEventListener('mousemove', (e) => {
      if (this.walk && document.pointerLockElement === el) this.look(e.movementX, e.movementY)
    })
    // 沒有鎖定滑鼠時(瀏覽器不允許或按過 Esc 一次),按住左鍵拖曳也可以看
    el.addEventListener('pointermove', (e) => {
      if (!this.walk || document.pointerLockElement === el || e.buttons !== 1) return
      // 觸控的 movementX 不一定有值,自己算位移
      const last = this.lastTouch ?? [e.clientX, e.clientY]
      this.look((e.clientX - last[0]) * (e.pointerType === 'touch' ? 2 : 1), (e.clientY - last[1]) * (e.pointerType === 'touch' ? 2 : 1))
      this.lastTouch = [e.clientX, e.clientY]
    })
    el.addEventListener('pointerdown', (e) => { this.lastTouch = [e.clientX, e.clientY] })
    el.addEventListener('pointerup', () => { this.lastTouch = null })
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
    let f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    let s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    if (w.stick && Math.hypot(...w.stick) > 0.15) { f = -w.stick[1]; s = w.stick[0] }
    if (f || s) {
      const analog = w.stick ? Math.min(1, Math.hypot(...w.stick)) : 1
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.2 : 1) * WALK_SPEED * dt * analog
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

  /** 走動時按 E:開關面前最近的那扇門 */
  private toggleNearestDoor() {
    const w = this.walk
    if (!w) return
    const fwd = new THREE.Vector2(Math.cos(w.yaw), Math.sin(w.yaw))
    let best: DoorHandle | null = null, bestD = DOOR_REACH
    const v = new THREE.Vector3()
    for (const d of this.doors) {
      for (const pv of d.pivots) {
        pv.getWorldPosition(v)
        const rel = new THREE.Vector2(v.x - w.pos[0], v.y - w.pos[1])
        const dist = rel.length()
        if (dist < bestD && rel.dot(fwd) > -200) { best = d; bestD = dist }
      }
    }
    if (best) { best.open = !best.open; this.onDoorsChange?.() }
  }

  /** 觸控的虛擬搖桿(左下角) */
  private showStick() {
    const base = document.createElement('div')
    base.className = 'stick'
    const knob = document.createElement('div')
    base.appendChild(knob)
    this.host.appendChild(base)
    this.stickEl = base
    const R = 50
    const move = (e: PointerEvent) => {
      const r = base.getBoundingClientRect()
      let x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2)
      const n = Math.hypot(x, y)
      if (n > R) { x = (x / n) * R; y = (y / n) * R }
      knob.style.transform = `translate(${x}px, ${y}px)`
      if (this.walk) this.walk.stick = [x / R, y / R]
    }
    const end = () => { knob.style.transform = ''; if (this.walk) this.walk.stick = null }
    base.addEventListener('pointerdown', (e) => { base.setPointerCapture(e.pointerId); move(e); e.stopPropagation() })
    base.addEventListener('pointermove', (e) => { if (e.buttons) move(e) })
    base.addEventListener('pointerup', end)
    base.addEventListener('pointercancel', end)
  }

  private blocked(p: Point) {
    return (this.built?.blockers ?? []).some(([a, b]) => distToSegment(p, a, b) < BODY_RADIUS)
  }
}

const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

/** 往上找到家具的群組(建模時在群組上記了 furnitureId) */
function furnitureOf(o: THREE.Object3D): THREE.Object3D | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.furnitureId) return p
  return null
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  const m = (o as THREE.Mesh).material as THREE.Material | undefined
  return !m || m.visible !== false
}
