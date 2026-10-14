/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Pet3dPresetSelectionPayload } from '@/stores/block'

import { MODEL_3D_CONFIG } from '@/config/model3d'
import { createDefaultPet3dPreset } from '@/stores/block'
import { getHeadbuttRearViewWeight } from '@/utils/three3d/headbuttViewport'

import {
  createVisibleBoundsSelectionSignature,
  requiresVisibleBoundsRefresh,
  visibleBoundsCompositionChanged,
  visibleBoundsSelectionChanged,
} from './viewportSelection'

function createSelection(): Pet3dPresetSelectionPayload {
  return {
    modelId: 'dmeloper',
    dmeloperSkinModel: 'wide',
    useDefaultDmeloperSkin: true,
    preset: createDefaultPet3dPreset(),
  }
}

describe('visible bounds selection signatures', () => {
  it('keeps desk appearance outside the framing signature', () => {
    const selection = createSelection()
    const before = createVisibleBoundsSelectionSignature(selection)
    selection.preset.deskTransparent = false
    selection.preset.deskColor = '#112233'
    assert.equal(visibleBoundsSelectionChanged(before, createVisibleBoundsSelectionSignature(selection)), false)
  })

  it('invalidates every geometry and alpha-affecting selection field', () => {
    const mutations: Array<(selection: Pet3dPresetSelectionPayload) => void> = [
      selection => void (selection.dmeloperSkinDataUrl = 'data:image/png;base64,changed'),
      selection => void (selection.dmeloperSkinModel = 'slim'),
      selection => void (selection.useDefaultDmeloperSkin = false),
      selection => void (selection.preset.sceneRotationOffsetDegrees += 1),
      selection => void (selection.preset.autoViewportEnabled = false),
      selection => void (selection.preset.autoViewportPaddingPixels -= 1),
      selection => void (selection.preset.cameraZoomPercent += 10),
      selection => void (selection.preset.petRotationDegrees += 1),
      selection => void (selection.preset.petDeskOffset += 0.25),
      selection => void (selection.preset.petShoulderTorsoConnected = true),
      selection => void (selection.preset.petRightArmDisabled = true),
      selection => void (selection.preset.petLeftArmDisabled = true),
      selection => void (selection.preset.deskHeightOffset += 0.25),
      selection => void (selection.preset.deskWidthOffset += 0.25),
      selection => void (selection.preset.deskDepthOffset += 0.25),
      selection => void (selection.preset.petRightArmBendPercent += 10),
      selection => void (selection.preset.petRightArmSpreadDegrees += 10),
      selection => void (selection.preset.petLeftArmBendPercent += 10),
      selection => void (selection.preset.petLeftArmSpreadDegrees += 10),
      selection => void (selection.preset.mouseEnabled = false),
      selection => void (selection.preset.mouseBaseXOffset += 0.25),
      selection => void (selection.preset.mouseBaseZOffset += 0.25),
      selection => void (selection.preset.mouseScalePercent += 10),
      selection => void (selection.preset.keyboardBaseXOffset += 0.25),
      selection => void (selection.preset.keyboardBaseZOffset += 0.25),
      selection => void (selection.preset.keyboardScalePercent += 10),
      selection => void (selection.preset.dmeloperEyebrows.enabled = false),
      selection => void (selection.preset.dmeloperEyebrows.centerOffsetPixels += 0.25),
      selection => void (selection.preset.dmeloperEyebrows.heightOffsetPixels += 0.25),
      selection => void (selection.preset.dmeloperEyebrows.spacingPixels += 0.25),
      selection => void (selection.preset.dmeloperEyebrows.widthPixels += 0.25),
      selection => void (selection.preset.dmeloperEyebrows.thicknessPixels += 0.25),
      selection => void (selection.preset.dmeloperEyebrows.depthPercent += 10),
    ]

    for (const mutate of mutations) {
      const original = createSelection()
      const previous = createVisibleBoundsSelectionSignature(original)
      const changed = createSelection()
      mutate(changed)
      assert.equal(visibleBoundsCompositionChanged(previous, createVisibleBoundsSelectionSignature(changed)), changed.preset.autoViewportPaddingPixels === original.preset.autoViewportPaddingPixels)
      assert.equal(
        visibleBoundsSelectionChanged(
          previous,
          createVisibleBoundsSelectionSignature(changed),
        ),
        true,
      )
    }
  })

  for (const geometryKey of ['petShoulderTorsoConnected', 'petRightArmDisabled', 'petLeftArmDisabled'] as const) {
    it(`refreshes bounds when ${geometryKey} toggles in either direction`, () => {
      for (const autoViewportEnabled of [true, false]) {
        for (const petAnimationMode of ['default', 'headbutt'] as const) {
          const selection = createSelection()
          selection.preset.autoViewportEnabled = autoViewportEnabled
          selection.preset.petAnimationMode = petAnimationMode
          const original = createVisibleBoundsSelectionSignature(selection)
          selection.preset[geometryKey] = true
          const changed = createVisibleBoundsSelectionSignature(selection)

          for (const [previous, current] of [[original, changed], [changed, original]]) {
            assert.equal(visibleBoundsSelectionChanged(previous, current), true)
            assert.equal(visibleBoundsCompositionChanged(previous, current), true)
            assert.equal(requiresVisibleBoundsRefresh(previous, current, false), true)
          }
        }
      }
    })

    it(`keeps a missing legacy ${geometryKey} equivalent to its false default`, () => {
      const selection = createSelection()
      const current = createVisibleBoundsSelectionSignature(selection)
      delete (selection.preset as Partial<Pet3dPresetSelectionPayload['preset']>)[geometryKey]
      const legacy = createVisibleBoundsSelectionSignature(selection)

      assert.deepEqual(legacy, current)
      for (const [previous, next] of [[legacy, current], [current, legacy]]) {
        assert.equal(visibleBoundsSelectionChanged(previous, next), false)
        assert.equal(visibleBoundsCompositionChanged(previous, next), false)
        assert.equal(requiresVisibleBoundsRefresh(previous, next, false), false)
      }
      assert.equal(Object.prototype.hasOwnProperty.call(selection.preset, geometryKey), false, 'reading bounds must not change legacy preset data')
    })
  }

  it('retains a pending refresh when a rapid change returns to the applied signature', () => {
    const original = createVisibleBoundsSelectionSignature(createSelection())
    const changedSelection = createSelection()
    changedSelection.preset.keyboardBaseXOffset += 0.25
    const changed = createVisibleBoundsSelectionSignature(changedSelection)

    assert.equal(requiresVisibleBoundsRefresh(original, changed, false), true)
    assert.equal(requiresVisibleBoundsRefresh(original, original, true), true)
    assert.equal(requiresVisibleBoundsRefresh(original, original, false), false)
  })

  it('retains the default display area when switching animation, while honoring a pending geometry refresh', () => {
    const selection = createSelection()
    const previous = createVisibleBoundsSelectionSignature(selection)
    selection.preset.petAnimationMode = 'headbutt'
    const current = createVisibleBoundsSelectionSignature(selection)
    assert.deepEqual(current, previous)
    assert.equal(visibleBoundsCompositionChanged(previous, current), false)
    assert.equal(requiresVisibleBoundsRefresh(previous, current, false), false)
    assert.equal(requiresVisibleBoundsRefresh(previous, current, true), true)
  })

  it('refreshes the mouse reservation for headbutt with mouse disabled and releases it on return to default', () => {
    const selection = createSelection()
    selection.preset.mouseEnabled = false
    const withoutMouse = createVisibleBoundsSelectionSignature(selection)
    assert.equal(withoutMouse.reserveMouseContent, false)

    selection.preset.petAnimationMode = 'headbutt'
    const headbutt = createVisibleBoundsSelectionSignature(selection)
    assert.equal(headbutt.mouseEnabled, false, 'reservation must not enable the actual mouse')
    assert.equal(headbutt.reserveMouseContent, true)
    assert.equal(visibleBoundsCompositionChanged(withoutMouse, headbutt), true)

    selection.preset.petAnimationMode = 'default'
    const restored = createVisibleBoundsSelectionSignature(selection)
    assert.equal(visibleBoundsCompositionChanged(headbutt, restored), true)
    assert.deepEqual(restored, withoutMouse)
  })

  it('refreshes a rear-view mode switch even with the mouse enabled and preserves the forward-view exception', () => {
    const selection = createSelection()
    // Convert actual scene yaw to the preset offset, including the authored yaw.
    selection.preset.sceneRotationOffsetDegrees = 135 - MODEL_3D_CONFIG.scene.rotationDegrees
    selection.preset.petRotationDegrees = -MODEL_3D_CONFIG.pet.rotationYDegrees
    const rearDefault = createVisibleBoundsSelectionSignature(selection)
    assert.equal(rearDefault.reserveHeadbuttTopContent, false)

    selection.preset.petAnimationMode = 'headbutt'
    const rearHeadbutt = createVisibleBoundsSelectionSignature(selection)
    assert.equal(rearHeadbutt.reserveHeadbuttTopContent, true)
    assert.equal(rearHeadbutt.reserveMouseContent, rearDefault.reserveMouseContent)
    assert.equal(requiresVisibleBoundsRefresh(rearDefault, rearHeadbutt, false), true)
    assert.equal(visibleBoundsCompositionChanged(rearHeadbutt, rearDefault), true)

    selection.preset.sceneRotationOffsetDegrees = 90 - MODEL_3D_CONFIG.scene.rotationDegrees
    const sideHeadbutt = createVisibleBoundsSelectionSignature(selection)
    assert.equal(sideHeadbutt.reserveHeadbuttTopContent, false)
    selection.preset.petAnimationMode = 'default'
    assert.deepEqual(createVisibleBoundsSelectionSignature(selection), sideHeadbutt)
  })

  it('uses combined scene and pet yaw for rear reservation, while both yaw fields remain composition inputs', () => {
    const selection = createSelection()
    selection.preset.petAnimationMode = 'headbutt'
    selection.preset.sceneRotationOffsetDegrees = 80 - MODEL_3D_CONFIG.scene.rotationDegrees
    selection.preset.petRotationDegrees = -MODEL_3D_CONFIG.pet.rotationYDegrees
    const front = createVisibleBoundsSelectionSignature(selection)
    assert.equal(front.reserveHeadbuttTopContent, false)

    selection.preset.petRotationDegrees += 20
    const rear = createVisibleBoundsSelectionSignature(selection)
    assert.equal(rear.reserveHeadbuttTopContent, true)
    assert.equal(visibleBoundsCompositionChanged(front, rear), true)

    selection.preset.sceneRotationOffsetDegrees += 20
    const furtherRear = createVisibleBoundsSelectionSignature(selection)
    assert.equal(furtherRear.reserveHeadbuttTopContent, true)
    assert.equal(visibleBoundsCompositionChanged(rear, furtherRear), true, 'a boolean reservation must not suppress changes to its amount')
  })

  it('does not invalidate for display area visibility, window scale, legend, or eyebrow color changes', () => {
    const original = createSelection()
    const previous = createVisibleBoundsSelectionSignature(original)
    const changed = createSelection()
    changed.preset.showDisplayArea = true
    changed.preset.windowScalePercent = 50
    changed.preset.keyboardLegendLanguage = 'en'
    changed.preset.dmeloperEyebrows.color = '#ffffff'

    assert.equal(
      visibleBoundsSelectionChanged(
        previous,
        createVisibleBoundsSelectionSignature(changed),
      ),
      false,
    )
  })

  it('copies primitive values so later preset mutation does not alter history', () => {
    const selection = createSelection()
    const previous = createVisibleBoundsSelectionSignature(selection)
    selection.preset.petDeskOffset = 1

    assert.equal(
      visibleBoundsSelectionChanged(
        previous,
        createVisibleBoundsSelectionSignature(selection),
      ),
      true,
    )
  })

  it('ignores inactive Dmeloper options that cannot change visible pixels', () => {
    const original = createSelection()
    original.dmeloperSkinDataUrl = 'data:image/png;base64,current'
    original.preset.dmeloperEyebrows.enabled = false
    const previous = createVisibleBoundsSelectionSignature(original)
    const changed = createSelection()
    changed.dmeloperSkinDataUrl = original.dmeloperSkinDataUrl
    changed.useDefaultDmeloperSkin = false
    changed.preset.dmeloperEyebrows.enabled = false
    changed.preset.dmeloperEyebrows.widthPixels += 6
    changed.preset.dmeloperEyebrows.spacingPixels -= 2
    changed.preset.dmeloperEyebrows.depthPercent = 200

    assert.equal(
      visibleBoundsSelectionChanged(
        previous,
        createVisibleBoundsSelectionSignature(changed),
      ),
      false,
    )
  })
})

describe('headbutt rear-view headroom', () => {
  const weight = (facing: number) => getHeadbuttRearViewWeight(facing - MODEL_3D_CONFIG.pet.rotationYDegrees, 0)

  it('keeps the full forward half unchanged and wraps complete rotations', () => {
    for (const facing of [-450, -90, -45, 0, 45, 90, 450]) assert.equal(weight(facing), 0)
    for (const facing of [-540, -180, 180, 540]) assert.equal(weight(facing), 1)
    assert.ok(Math.abs(weight(135) - 0.5) < 1e-12)
    assert.ok(Math.abs(weight(-135) - weight(135)) < 1e-12)
  })

  it('increases continuously toward the rear in either direction and decreases toward the side', () => {
    let previous = 0
    for (let degrees = 90; degrees <= 180; degrees++) {
      const current = weight(degrees)
      assert.ok(current >= previous && current <= 1)
      assert.ok(current - previous < 0.02, 'one degree of rotation must not cause a headroom jump')
      assert.ok(Math.abs(current - weight(-degrees)) < 1e-12)
      previous = current
    }
    assert.ok(weight(90.001) < 1e-8)
    assert.ok(1 - weight(179.999) < 1e-8)
  })
})
