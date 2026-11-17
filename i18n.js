/**
 * 查询语言推断（C4）：中文问题走中文站点参数，英文问题走英文站点参数。
 *
 * 只做「参数与请求头」这一层，不翻译查询词——翻译属于调用方（模型）的事。
 */

export const LANG_MODES = ['auto', 'zh', 'en'];

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/** 中文占比高就是 zh；没有汉字但有拉丁词就是 en；都没有返回空。 */
export function detectLang(text) {
  const value = typeof text === 'string' ? text : '';
  const cjk = (value.match(CJK) || []).length;
  const words = (value.match(LATIN_WORD) || []).length;
  if (cjk === 0 && words === 0) return '';
  if (cjk === 0) return 'en';
  if (words === 0) return 'zh';
  // 中文按字数、英文按词数比：两个汉字配一个英文词仍算中文提问
  return cjk >= words ? 'zh' : 'en';
}

/** settings.lang 是 auto 时按查询词推断，推断不出来按中文（插件主用户群）。 */
export function resolveLang(settings, query, forced) {
  const pick = (value) => (LANG_MODES.includes(value) ? value : '');
  const forcedLang = pick(forced);
  if (forcedLang && forcedLang !== 'auto') return forcedLang;
  const configured = pick(settings && settings.lang) || 'auto';
  if (configured !== 'auto') return configured;
  return detectLang(query) || 'zh';
}

export function acceptLanguage(lang) {
  return lang === 'en' ? 'en-US,en;q=0.9,zh-CN;q=0.6' : 'zh-CN,zh;q=0.9,en;q=0.8';
}

/** 必应的界面语言参数。 */
export function bingLang(lang) {
  return lang === 'en' ? 'en' : 'zh-Hans';
}

/** 必应市场参数：只改 setlang 不影响结果语言，mkt 才会换市场。 */
export function bingMarket(lang) {
  return lang === 'en' ? 'en-US' : 'zh-CN';
}

/** 360 搜索的区域参数（so.com 用 `src` + `hl`）。 */
export function so360Lang(lang) {
  return lang === 'en' ? 'en' : 'zh-CN';
}

/** 只给「这个平台是否对当前语言更有用」打分，排序时用作极小的加权，不改状态。 */
export function langAffinity(platformLang, lang) {
  if (!platformLang || !lang) return 0;
  return platformLang === lang ? 0.15 : -0.05;
}