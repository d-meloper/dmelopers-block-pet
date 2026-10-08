/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, reactive } from 'vue'

import type { Language } from '@/locales/languageBranch'

import { isKoreanLanguage, selectByLanguage } from '@/locales/languageBranch'

it('exposes reactive resolved-language branches and selection with no persisted audience field', () => {
  const general = reactive<{ resolvedLanguage: Language }>({ resolvedLanguage: 'ko-KR' })
  const exports = {} as typeof import('./useAppLanguage')
  const source = ts.transpileModule(readFileSync(new URL('./useAppLanguage.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id === 'vue') return { computed }
      if (id === '@/locales/languageBranch') return { isKoreanLanguage, selectByLanguage }
      if (id === '@/stores/general') return { useGeneralStore: () => general }
      throw new Error(`Unexpected import: ${id}`)
    },
  })
  const language = exports.useAppLanguage()
  const korean = { link: 'korean' }
  const global = { link: 'global' }
  assert.equal(language.language.value, 'ko-KR')
  assert.equal(language.isKorean.value, true)
  assert.equal(language.isGlobal.value, false)
  assert.equal(language.select(korean, global), korean)
  general.resolvedLanguage = 'en-US'
  assert.equal(language.language.value, 'en-US')
  assert.equal(language.isKorean.value, false)
  assert.equal(language.isGlobal.value, true)
  assert.equal(language.select(korean, global), global)
  assert.deepEqual(Object.keys(language), ['language', 'isKorean', 'isGlobal', 'select'])
})
