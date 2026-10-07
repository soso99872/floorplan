// 3D 檢視器:相機、燈光、視角、顯示模式、開關門、匯出。跟 React 無關,由 Viewer3D 元件掛到畫面上。
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { Scene } from '../scene/types'
import { buildScene, doorOfMesh, type BuiltScene, type DoorHandle } from './sceneBuilder'

export type ViewName = 'iso' | 'front' | 'top' | 'right'

const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [0.45, -1, 0.8], // 平面圖又扁又寬:視角放低一點才看得出牆高和房間
  front: [0, -1, 0],
  top: [0, 0, 1],
  right: [1, 0, 0],
}
const OPEN_DEG = 80

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
  /** 門的狀態改變時通知外面(更新按鈕文字) */
  onDoorsChange: (() => void) | null = null

  private host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    host.appendChild(this.renderer.domElement)
    this.scene3d.background = new THREE.Color('#20252e')
    this.camera.up.set(0, 0, 1) // 建築習慣 Z 朝上
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.addEventListener('start', () => { this.autoView = null })

    this.scene3d.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.0))
    this.scene3d.add(this.sun)
    const headlight = new THREE.DirectionalLight(0xffffff, 0.6)
    this.camera.add(headlight)
    this.scene3d.add(this.camera)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.resize()
    this.bindPointer()
    this.renderer.setAnimationLoop(() => {
      this.controls.update()
      this.animateDoors()
      this.renderer.render(this.scene3d, this.camera)
    })
  }

  dispose() {
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
      this.scene3d.add(this.floor)
    }
    this.applyMaterialMode()
    if (!keepView || first) this.setView('iso')
    this.onDoorsChange?.()
  }

  setView(name: ViewName) {
    if (!this.built) return
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
    const dist = r / Math.sin(half) * (name === 'iso' && this.camera.aspect >= 1 ? 0.85 : 1.05)
    this.camera.position.copy(c).addScaledVector(dir, dist)
    this.sun.position.copy(c).add(new THREE.Vector3(1, -2, 3).multiplyScalar(r * 3))
    this.controls.target.copy(c)
    this.controls.update()
  }

  setDisplay(opt: { wire?: boolean; xray?: boolean; furniture?: boolean }) {
    if (opt.wire !== undefined) this.wire = opt.wire
    if (opt.xray !== undefined) this.xray = opt.xray
    if (opt.furniture !== undefined && this.built) this.built.furniture.visible = opt.furniture
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
    if (!this.built) throw new Error('還沒有模型')
    const saved = this.doors.map((d) => d.t)
    for (const d of this.doors) { d.t = 0; this.poseDoor(d) }
    const root = this.built.root.clone()
    root.remove(...root.children.filter((c) => c instanceof THREE.LineSegments)) // 稜線是顯示用的,不輸出
    root.scale.setScalar(0.001) // glTF 單位是公尺
    root.rotation.x = -Math.PI / 2 // glTF 是 Y 朝上
    this.doors.forEach((d, i) => { d.t = saved[i]; this.poseDoor(d) })
    const data = await new GLTFExporter().parseAsync(root, { binary: true })
    return new Blob([data as ArrayBuffer], { type: 'model/gltf-binary' })
  }

  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png')
  }
}

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  const m = (o as THREE.Mesh).material as THREE.Material | undefined
  return !m || m.visible !== false
}
