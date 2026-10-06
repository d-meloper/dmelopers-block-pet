/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Pet3dPresetSelectionPayload } from '@/stores/block'

import { createDefaultPet3dPreset } from '@/stores/block'

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

  it('retains a pending refresh when a rapid change returns to the applied signature', () => {
    const original = createVisibleBoundsSelectionSignature(createSelection())
    const changedSelection = createSelection()
    changedSelection.preset.keyboardBaseXOffset += 0.25
    const changed = createVisibleBoundsSelectionSignature(changedSelection)

    assert.equal(requiresVisibleBoundsRefresh(original, changed, false), true)
    assert.equal(requiresVisibleBoundsRefresh(original, original, true), true)
    assert.equal(requiresVisibleBoundsRefresh(original, original, false), false)
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
