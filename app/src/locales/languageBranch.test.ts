/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { isKoreanLanguage, isLanguage, isLanguagePreference, resolveLanguage, selectByLanguage } from './languageBranch'

it('keeps system as a preference and resolves it without treating it as a display language', () => {
  for (const system of ['ko-KR', 'en-US'] as const) {
    assert.equal(resolveLanguage('system', system), system)
    assert.equal(resolveLanguage(undefined, system), system)
    assert.equal(resolveLanguage('ko-KR', system), 'ko-KR')
    assert.equal(resolveLanguage('en-US', system), 'en-US')
  }
  assert.equal(isLanguagePreference('system'), true)
  assert.equal(isLanguage('system'), false)
  for (const invalid of ['', null, undefined, 'ja-JP', 'ko', true]) {
    assert.equal(isLanguagePreference(invalid), false)
  }
  assert.equal(isLanguagePreference('ko-KR'), true)
  assert.equal(isLanguagePreference('en-US'), true)
})

it('preserves the existing Korean/global helper interfaces', () => {
  assert.equal(isKoreanLanguage('ko-KR'), true)
  assert.equal(selectByLanguage('ko-KR', 1, 2), 1)
  for (const other of ['en-US', 'ja-JP', 'system', '']) {
    assert.equal(isKoreanLanguage(other), false)
    assert.equal(selectByLanguage(other, 1, 2), 2)
  }
})
