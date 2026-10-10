// 介面語言:中文(預設)/ English。用法 t('中文字串'),英文版沒有翻譯的字就顯示中文。
// 換語言時 App 會重新渲染整個畫面,所以 t() 直接讀目前的語言即可。
import { EN } from './i18n.en'

export type Lang = 'zh' | 'en'
const KEY = 'fp3d.lang'

let lang: Lang = (() => {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh' } catch { return 'zh' }
})()

export function getLang(): Lang {
  return lang
}

export function setLang(l: Lang) {
  lang = l
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-Hant'
  try { localStorage.setItem(KEY, l) } catch { /* 存不了就算了 */ }
}

export function t(zh: string): string {
  return lang === 'en' ? EN[zh] ?? zh : zh
}
