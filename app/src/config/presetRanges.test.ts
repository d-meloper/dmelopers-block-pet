/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { captureBroadcastScene } from '@/features/broadcast/scene'
import { applyPresetSnapshot, capturePresetSnapshot, createDefaultPresetSnapshot } from '@/features/presets/model'
import { parsePortablePreset, serializePortablePreset, validatePortablePreset } from '@/features/presets/transfer'
import { createDefaultPet3dPreset, useBlockStore } from '@/stores/block'

import presetRanges from './presetRanges.json'

const fixture = readFileSync(new URL('../features/presets/fixtures/portable-v1.json', import.meta.url))

describe('shared actual preset ranges', () => {
  it('implements the nine requested bounds independently of the display coordinate system', () => {
    assert.deepEqual(presetRanges, {
      preset: {
        petRotationDegrees: { min: -30, max: 30 },
        petDeskOffset: { min: -0.4, max: 0.4 },
        keyboardBaseXOffset: { min: -0.8, max: 0.8 },
        keyboardBaseZOffset: { min: -0.45, max: 0.45 },
        mouseBaseXOffset: { min: -0.6, max: 0.6 },
        mouseBaseZOffset: { min: -0.45, max: 0.45 },
      },
      eyebrows: {
        spacingPixels: { min: 0.5, max: 3 },
        widthPixels: { min: 0.8, max: 4 },
        thicknessPixels: { min: 0.2, max: 1.4 },
      },
    })
  })

  it('clamps restored state and loaded snapshots without altering defaults or the source snapshot', () => {
    const defaults = createDefaultPet3dPreset()
    for (const edge of ['min', 'max'] as const) {
      setActivePinia(createPinia())
      const store = useBlockStore()
      const snapshot = createDefaultPresetSnapshot()
      for (const [key, range] of Object.entries(presetRanges.preset)) {
        Object.assign(snapshot.preset, { [key]: range[edge] + (edge === 'min' ? -100 : 100) })
      }
      for (const [key, range] of Object.entries(presetRanges.eyebrows)) {
        Object.assign(snapshot.preset.dmeloperEyebrows, { [key]: range[edge] + (edge === 'min' ? -100 : 100) })
      }
      const original = JSON.stringify(snapshot)
      store.$patch({ customization3d: { preset: snapshot.preset } })
      store.init()
      for (const apply of [false, true]) {
        if (apply) applyPresetSnapshot(store, snapshot)
        for (const [key, range] of Object.entries(presetRanges.preset)) {
          assert.equal(Reflect.get(store.activePet3dPreset, key), range[edge], key)
        }
        for (const [key, range] of Object.entries(presetRanges.eyebrows)) {
          assert.equal(Reflect.get(store.activePet3dPreset.dmeloperEyebrows, key), range[edge], key)
        }
      }
      assert.equal(JSON.stringify(snapshot), original)
    }
    assert.deepEqual(createDefaultPet3dPreset(), defaults)
  })

  it('preserves actual fractional values through stored snapshots, portable files and OBS', () => {
    setActivePinia(createPinia())
    const store = useBlockStore()
    store.init()
    const document = parsePortablePreset(fixture)
    document.settings.opacity = 10.9
    const preset = document.settings.preset
    Object.assign(preset, {
      petRotationDegrees: 3.3,
      petDeskOffset: -0.044,
      keyboardBaseXOffset: 0.088,
      keyboardBaseZOffset: -0.0495,
      mouseBaseXOffset: 0.066,
      mouseBaseZOffset: -0.0495,
      petRightArmBendPercent: 103,
    })
    Object.assign(preset.dmeloperEyebrows, { spacingPixels: 1.665, widthPixels: 2.22, thicknessPixels: 0.599 })
    preset.lighting.key.azimuthDegrees = -14.91
    const restored = parsePortablePreset(new TextEncoder().encode(serializePortablePreset(document)))
    const snapshot = { ...createDefaultPresetSnapshot(), ...restored.settings }
    applyPresetSnapshot(store, snapshot)
    store.init()
    assert.deepEqual(capturePresetSnapshot(store).preset, preset)
    assert.equal(capturePresetSnapshot(store).opacity, 10.9)
    const broadcast = captureBroadcastScene(store)
    assert.equal(broadcast.opacity, 10.9)
    for (const key of Object.keys(presetRanges.preset)) {
      assert.equal(Reflect.get(broadcast.preset, key), Reflect.get(preset, key))
    }
    assert.deepEqual(broadcast.preset.dmeloperEyebrows, preset.dmeloperEyebrows)
    assert.equal(broadcast.preset.lighting.key.azimuthDegrees, -14.91)
  })

  it('rejects out-of-range file inputs at each shared boundary', () => {
    for (const [group, ranges] of Object.entries(presetRanges)) {
      for (const [key, { min, max }] of Object.entries(ranges)) {
        for (const value of [min, max, min - 0.0001, max + 0.0001]) {
          const document = parsePortablePreset(fixture)
          const target = group === 'preset' ? document.settings.preset : document.settings.preset.dmeloperEyebrows
          Object.assign(target, { [key]: value })
          if (value === min || value === max) validatePortablePreset(document)
          else assert.throws(() => validatePortablePreset(document), { code: 'invalidSettings' }, `${group}.${key}`)
        }
      }
    }
  })
})
