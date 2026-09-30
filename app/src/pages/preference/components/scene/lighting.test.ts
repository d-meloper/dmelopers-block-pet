/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import { computed } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import * as sliderDisplay from '@/components/default-snap-slider/displayValue'
import * as lightingConfig from '@/config/lighting'
import { useCatStore } from '@/stores/cat'

it('places bounded strength below color and resets lighting without changing other settings', () => {
  setActivePinia(createPinia())
  const store = useCatStore()
  store.init()
  const { descriptor } = parse(readFileSync(new URL('./lighting.vue', import.meta.url), 'utf8'))
  compileScript(descriptor, { id: 'lighting-controls', inlineTemplate: true })
  const context = {
    exports: {},
    controls: undefined as unknown as {
      updateColor: (value: string) => void
      updateNumber: (key: string, value: unknown) => void
      updateDisplayedNumber: (key: string, value: unknown) => void
      formatDisplayedNumber: (value: unknown, info: { userTyping: boolean, input: string }) => string
      fields: string[]
      reset: () => void
    },
    require: (name: string) => {
      if (name === 'vue') return { computed }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) }
      if (name === 'ant-design-vue') return { Modal: { confirm: ({ onOk }: { onOk: () => void }) => onOk() } }
      if (name === '@/stores/cat') return { useCatStore: () => store }
      if (name === '@/config/lighting') return lightingConfig
      if (name === '@/components/default-snap-slider/displayValue') return sliderDisplay
      if (name === '@/features/presets/editIntent') return { markPresetUserEdit: () => {} }
      return {}
    },
  }
  runInNewContext(ts.transpileModule(`${descriptor.scriptSetup!.content}\nglobalThis.controls = { updateColor, updateNumber, updateDisplayedNumber, formatDisplayedNumber, fields, reset }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const { updateColor, updateNumber, updateDisplayedNumber, formatDisplayedNumber, fields, reset } = context.controls
  assert.deepEqual(Array.from(fields), ['strengthPercent', 'azimuthDegrees', 'elevationDegrees'])
  assert.equal(descriptor.template!.content.match(/<ColorPicker\b/g)?.length, 1)
  assert.ok(descriptor.template!.content.indexOf('<ColorPicker') < descriptor.template!.content.indexOf('v-for="field in fields"'))
  assert.ok(descriptor.template!.content.indexOf('<Button') > descriptor.template!.content.indexOf('v-for="field in fields"'))
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
  const defaults = lightingConfig.createDefaultLightingSettings().key
  for (const key of fields as Array<keyof typeof lightingConfig.LIGHTING_LIMITS>) {
    const range = { ...lightingConfig.LIGHTING_LIMITS[key], defaultValue: defaults[key] }
    for (const displayed of [-1, -0.23, 0, 0.07, 1]) {
      updateDisplayedNumber(key, displayed)
      assert.equal(store.activePet3dPreset.lighting.key[key], sliderDisplay.fromSliderDisplayValue(displayed, range))
      assert.ok(Math.abs(sliderDisplay.toSliderDisplayValue(store.activePet3dPreset.lighting.key[key], range) - displayed) < 1e-12)
    }
    updateDisplayedNumber(key, '0.03')
    const before = store.activePet3dPreset.lighting.key[key]
    for (const invalid of [null, '', 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) updateDisplayedNumber(key, invalid)
    assert.equal(store.activePet3dPreset.lighting.key[key], before)
  }
  assert.ok(descriptor.template!.content.includes('@update:value="updateDisplayedNumber(field, $event)"'))
  assert.ok(descriptor.template!.content.includes(':value="toSliderDisplayValue(keyLight[field], numberRange(field))"'))
  for (const input of ['-', '0.', '-0.0']) assert.equal(formatDisplayedNumber(0, { userTyping: true, input }), input)
  assert.equal(formatDisplayedNumber(0.3, { userTyping: false, input: '0.30' }), '0.3')
  assert.equal(formatDisplayedNumber(-0.001, { userTyping: false, input: '-0.001' }), '0')
  assert.equal(store.shadowQualitySelection, 'off')
  store.activePet3dPreset.cameraZoomPercent = 150
  store.activePet3dPreset.mouseScalePercent = 125
  reset()
  assert.equal(store.activePet3dPreset.cameraZoomPercent, 150)
  assert.equal(store.activePet3dPreset.mouseScalePercent, 125)
  assert.deepEqual(store.activePet3dPreset.lighting, lightingConfig.createDefaultLightingSettings())
  assert.equal(store.shadowQualitySelection, 'off')
  const scene = readFileSync(new URL('./index.vue', import.meta.url), 'utf8')
  const pet = readFileSync(new URL('../cat/index.vue', import.meta.url), 'utf8')
  assert.ok(scene.indexOf('<LightingSettings />') > scene.indexOf(':title="$t(\'pages.preference.scene.title\')"'))
  assert.ok(scene.indexOf('<LightingSettings />') < scene.indexOf(':title="$t(\'pages.preference.scene.labels.viewport\')"'))
  assert.ok(pet.includes('<ProList :title="$t(\'pages.preference.cat.title\')">'))
})
