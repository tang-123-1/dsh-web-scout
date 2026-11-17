import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptLanguage, bingLang, bingMarket, detectLang, langAffinity, LANG_MODES, resolveLang, so360Lang } from '../i18n.js';

test('中文查询判为 zh', () => {
  assert.equal(detectLang('Cordis 插件怎么写'), 'zh');
  assert.equal(detectLang('今天天气怎么样'), 'zh');
});

test('英文查询判为 en', () => {
  assert.equal(detectLang('how to write a cordis plugin'), 'en');
  assert.equal(detectLang('react hooks'), 'en');
});

test('空串与纯符号返回空', () => {
  assert.equal(detectLang(''), '');
  assert.equal(detectLang('   '), '');
  assert.equal(detectLang('123 !@# ---'), '');
  assert.equal(detectLang(null), '');
});

test('中英混排按「汉字数 vs 英文词数」判断', () => {
  assert.equal(detectLang('Cordis 插件'), 'zh');
  assert.equal(detectLang('Cordis plugin 插件'), 'zh');
  assert.equal(detectLang('how to write a cordis plugin 插'), 'en');
  assert.equal(detectLang('react hooks 用法'), 'zh');
});

test('resolveLang：forced > settings > 推断 > zh', () => {
  assert.equal(resolveLang({ lang: 'en' }, '中文查询'), 'en');
  assert.equal(resolveLang({ lang: 'en' }, '中文查询', 'zh'), 'zh');
  assert.equal(resolveLang({ lang: 'auto' }, 'hello world'), 'en');
  assert.equal(resolveLang({}, 'hello world'), 'en');
  assert.equal(resolveLang({}, ''), 'zh');
  assert.equal(resolveLang({ lang: 'bogus' }, 'hello world'), 'en');
  assert.equal(resolveLang({}, '中文', 'auto'), 'zh');
});

test('LANG_MODES 与头部/参数映射', () => {
  assert.deepEqual(LANG_MODES, ['auto', 'zh', 'en']);
  assert.match(acceptLanguage('zh'), /^zh-CN/);
  assert.match(acceptLanguage('en'), /^en-US/);
  assert.equal(bingLang('en'), 'en');
  assert.equal(bingLang('zh'), 'zh-Hans');
  assert.equal(bingMarket('en'), 'en-US');
  assert.equal(bingMarket('zh'), 'zh-CN');
  assert.equal(so360Lang('en'), 'en');
});

test('语言亲和度只给很小权重', () => {
  assert.ok(langAffinity('en', 'en') > 0);
  assert.ok(langAffinity('en', 'zh') < 0);
  assert.equal(langAffinity('', 'zh'), 0);
  assert.ok(Math.abs(langAffinity('en', 'en')) < 0.2);
});