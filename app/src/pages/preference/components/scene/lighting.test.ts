/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import { computed } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as lightingConfig from '@/config/lighting'
import { useBlockStore } from '@/stores/block'

it('keeps bounded lighting sliders within the lighting category', () => {
  setActivePinia(createPinia())
  const store = useBlockStore()
  store.init()
  const { descriptor } = parse(readFileSync(new URL('./lighting.vue', import.meta.url), 'utf8'))
  compileScript(descriptor, { id: 'lighting-controls', inlineTemplate: true })
  const context = {
    exports: {},
    controls: undefined as unknown as {
      updateColor: (value: string) => void
      updateNumber: (key: string, value: unknown) => void
      fields: string[]
    },
    require: (name: string) => {
      if (name === 'vue') return { computed }
      if (name === '@/stores/block') return { useBlockStore: () => store }
      if (name === '@/config/lighting') return lightingConfig
      if (name === '@/features/presets/editIntent') return { markPresetUserEdit: () => {} }
      return {}
    },
  }
  runInNewContext(ts.transpileModule(`${descriptor.scriptSetup!.content}\nglobalThis.controls = { updateColor, updateNumber, fields }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const { updateColor, updateNumber, fields } = context.controls
  assert.deepEqual(Array.from(fields), ['strengthPercent', 'azimuthDegrees', 'elevationDegrees'])
  assert.equal(descriptor.template!.content.match(/<ColorPicker\b/g)?.length, 1)
  assert.ok(descriptor.template!.content.indexOf('<ColorPicker') < descriptor.template!.content.indexOf('v-for="field in fields"'))
  assert.ok(!/<(?:h3|Select|Switch)\b/.test(descriptor.template!.content))
  assert.ok(!descriptor.template!.content.includes('lighting.groups'))
  store.shadowQualitySelection = 'off'
  updateColor('#123456')
  updateColor('red')
  assert.equal(store.activePet3dPreset.lighting.key.color, '#123456')
  updateNumber('strengthPercent', 0)
  assert.equal(store.activePet3dPreset.lighting.key.strengthPercent, 25)
  updateNumber('strengthPercent', 999)
  assert.equal(store.activePet3dPreset.lighting.key.strengthPercent, 200)
  updateNumber('strengthPercent', 100)
  assert.equal(store.activePet3dPreset.lighting.key.strengthPercent, 100)
  updateNumber('azimuthDegrees', 74.8)
  updateNumber('azimuthDegrees', Number.NaN)
  updateNumber('azimuthDegrees', null)
  assert.equal(store.activePet3dPreset.lighting.key.azimuthDegrees, 74.8)
  updateNumber('elevationDegrees', 100)
  assert.equal(store.activePet3dPreset.lighting.key.elevationDegrees, 90)
  for (const key of fields as Array<keyof typeof lightingConfig.LIGHTING_LIMITS>) {
    const { min, max } = lightingConfig.LIGHTING_LIMITS[key]
    updateNumber(key, min - 1)
    assert.equal(store.activePet3dPreset.lighting.key[key], min)
    updateNumber(key, max + 1)
    assert.equal(store.activePet3dPreset.lighting.key[key], max)
    for (const invalid of [null, Number.NaN, Number.POSITIVE_INFINITY]) updateNumber(key, invalid)
    assert.equal(store.activePet3dPreset.lighting.key[key], max)
  }
  assert.equal(store.shadowQualitySelection, 'off')
  const pet = readFileSync(new URL('../block/index.vue', import.meta.url), 'utf8')
  assert.ok(pet.includes('<ProList :title="$t(\'pages.preference.block.title\')">'))
})
