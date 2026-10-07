// OBJ + MTL(含地板貼圖)打包成 zip:SketchUp(2021 以後的「匯入 OBJ」)、3ds Max、Revit 等都讀得到。
// 單位公尺、Y 朝上(OBJ 的慣例);顏色寫在 MTL 的 Kd,貼圖另存 PNG。
import * as THREE from 'three'
import { strToU8, zipSync } from 'fflate'

const f = (v: number) => (Math.round(v * 1e5) / 1e5).toString()

async function canvasPng(image: unknown): Promise<Uint8Array | null> {
  if (!(image instanceof HTMLCanvasElement)) return null
  const blob = await new Promise<Blob | null>((ok) => image.toBlob(ok, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

export async function exportObjZip(root: THREE.Object3D, name: string): Promise<Blob> {
  root.updateMatrixWorld(true)
  const obj: string[] = [`# ${name}\n`, `mtllib ${name}.mtl\n`]
  const mtl: string[] = []
  const files: Record<string, Uint8Array> = {}
  const mats = new Map<THREE.Material, string>()
  const textures = new Map<THREE.Texture, string>()
  let vBase = 1, tBase = 1, nBase = 1, group = 0

  const toYUp = (v: THREE.Vector3) => `${f(v.x / 1000)} ${f(v.z / 1000)} ${f(-v.y / 1000)}`

  const meshes: THREE.Mesh[] = []
  root.traverseVisible((o) => { if (o instanceof THREE.Mesh) meshes.push(o) })

  for (const mesh of meshes) {
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
    if (!material.visible) continue
    let mname = mats.get(material)
    if (!mname) {
      mname = `m${mats.size + 1}`
      mats.set(material, mname)
      const c = (material.color ?? new THREE.Color(0xcccccc)).clone().convertLinearToSRGB() // MTL 的顏色是 sRGB
      mtl.push(`newmtl ${mname}\nKd ${f(c.r)} ${f(c.g)} ${f(c.b)}\nKa 0 0 0\nd ${f(material.opacity ?? 1)}\nillum 1\n`)
      if (material.map) {
        let tex = textures.get(material.map)
        if (!tex) {
          const png = await canvasPng(material.map.image)
          if (png) {
            tex = `${name}_tex${textures.size + 1}.png`
            files[tex] = png
            textures.set(material.map, tex)
          }
        }
        if (tex) mtl.push(`map_Kd ${tex}\n`)
      }
      mtl.push('\n')
    }

    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
    const pos = geo.attributes.position
    const nor = geo.attributes.normal
    const uv = geo.attributes.uv
    const normalMat = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
    const v = new THREE.Vector3()
    obj.push(`g g${++group}\nusemtl ${mname}\n`)
    for (let i = 0; i < pos.count; i++) obj.push(`v ${toYUp(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))}\n`)
    if (nor) for (let i = 0; i < nor.count; i++) obj.push(`vn ${toYUp(v.fromBufferAttribute(nor, i).applyMatrix3(normalMat).normalize().multiplyScalar(1000))}\n`)
    if (uv) for (let i = 0; i < uv.count; i++) obj.push(`vt ${f(uv.getX(i))} ${f(uv.getY(i))}\n`)
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const idx = [i, i + 1, i + 2].map((k) => {
        const vi = vBase + k
        if (uv && nor) return `${vi}/${tBase + k}/${nBase + k}`
        if (nor) return `${vi}//${nBase + k}`
        return `${vi}`
      })
      obj.push(`f ${idx.join(' ')}\n`)
    }
    vBase += pos.count
    if (uv) tBase += uv.count
    if (nor) nBase += nor.count
  }

  files[`${name}.obj`] = strToU8(obj.join(''))
  files[`${name}.mtl`] = strToU8(mtl.join(''))
  const zip = zipSync(files, { level: 6 })
  return new Blob([zip], { type: 'application/zip' })
}
