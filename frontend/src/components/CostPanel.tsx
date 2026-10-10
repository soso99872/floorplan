// 地板材料造價估算:依材質加總面積 × 單價 × (1 + 損耗),單價和損耗可以改(存在場景裡)
import { updateMeta } from '../editor/commands'
import { t } from '../i18n'
import type { Editor } from '../editor/store'
import { floorCost, FLOOR_MATERIALS } from '../scene/materials'

const money = (v: number) => 'NT$ ' + Math.round(v).toLocaleString()

export function CostPanel({ editor }: { editor: Editor }) {
  const { scene } = editor
  if (!scene) return null
  const { rows, waste, total } = floorCost(scene)
  const setPrice = (id: string, v: number) =>
    editor.apply(updateMeta(scene, { prices: { ...(scene.meta.prices ?? {}), [id]: v } }), `price:${id}`)
  return (
    <section>
      <h2>{t('地板材料估算')}({t('含')} {Math.round(waste * 100)}% {t('損耗')})</h2>
      <table className="cost">
        <thead><tr><th>{t("材料")}</th><th className="num">{t("面積")}</th><th className="num">{t("單價 / m²")}</th><th className="num">{t("小計")}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><i className="swatch" style={{ background: FLOOR_MATERIALS[r.id].swatch }} />{t(r.name)}</td>
              <td className="num">{r.area.toFixed(1)} m²</td>
              <td className="num">
                <input type="number" min={0} step={100} value={r.price}
                  onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && v >= 0) setPrice(r.id, v) }}
                  onBlur={editor.endMerge} />
              </td>
              <td className="num">{money(r.cost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={3}>{t("地板材料合計")}</td><td className="num">{money(total)}</td></tr></tfoot>
      </table>
      <div className="field">
        <label>{t("損耗")}</label>
        <span>
          <input type="number" min={0} max={50} step={1} value={Math.round(waste * 100)}
            onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && v >= 0 && v <= 50) editor.apply(updateMeta(scene, { waste: v / 100 }), 'waste') }}
            onBlur={editor.endMerge} /> %
        </span>
      </div>
      <p className="note">{t("單價是參考值(含工),請依實際報價修改;房間的地板材質在右側面板選。")}</p>
    </section>
  )
}
