/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LocaleRegistry } from './registry'

import fixtures from './fixtures/resolution.json'
import { createPluralRules, formatLocaleDateTime, formatLocaleNumber } from './formatting'
import { getPublicLanguageOptions, isPublicLanguage, localeRegistry, resolveSystemLocale } from './registry'
import { createLocaleRuntime } from './runtime'

test('shares exact, explicitly aliased and script-specific resolver cases with native tests', () => {
  for (const { input, expected } of fixtures.cases) {
    assert.equal(resolveSystemLocale(input, fixtures.registry as LocaleRegistry), expected, JSON.stringify(input))
  }
  assert.equal(resolveSystemLocale(undefined), 'en-US')
  assert.deepEqual(getPublicLanguageOptions(), [{ value: 'ko-KR', label: '한국어' }, { value: 'en-US', label: 'English' }, { value: 'ja-JP', label: '日本語' }])
  assert.equal(isPublicLanguage('ja-JP'), true)
  for (const observed of ['ja-JP', 'ja', 'JA-jp', 'ja-Jpan-JP']) assert.equal(resolveSystemLocale(observed), 'ja-JP')
  for (const value of ['system', 'ko', 'ja', 'en-GB', 'fr-FR', 'en-XA', 'ar-XB', null]) assert.equal(isPublicLanguage(value), false)
})

test('falls back directly to English rather than an inferred parent locale', () => {
  const runtime = createLocaleRuntime({ 'en-US': { message: 'English' }, 'zh': { message: 'Parent' }, 'zh-Hant': {} })
  runtime.global.locale.value = 'zh-Hant'
  assert.equal(runtime.global.t('message'), 'English')
})

test('selects plural categories through Intl and formats presentation without changing numeric values', () => {
  const registry: LocaleRegistry = { ...localeRegistry, locales: {
    ...localeRegistry.locales,
    ar: { ...localeRegistry.locales['en-US'], direction: 'rtl', pluralCategories: ['zero', 'one', 'two', 'few', 'many', 'other'] },
  } }
  const rules = createPluralRules(registry)
  for (const [value, index] of [[0, 0], [1, 1], [2, 2], [3, 3], [11, 4], [100, 5]]) assert.equal(rules.ar(value, 6), index)
  assert.equal(rules['ko-KR'](7, 1), 0)
  assert.equal(rules['en-US'](1, 2), 0)
  assert.equal(rules['en-US'](2, 2), 1)
  const value = 1234.5
  assert.equal(formatLocaleNumber('en-US', value), '1,234.5')
  assert.equal(formatLocaleNumber('invalid_locale', value), '1,234.5')
  assert.equal(value, 1234.5)
  assert.equal(formatLocaleDateTime('en-US', new Date('2026-10-27T00:00:00Z'), { year: 'numeric', timeZone: 'UTC' }), '2026')
})
