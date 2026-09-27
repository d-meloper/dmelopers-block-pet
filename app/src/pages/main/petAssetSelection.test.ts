/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getRequiredPetAssetMutation } from './petAssetSelection'

describe('pet asset selection', () => {
  it('loads the model when the renderer has no current asset', () => {
    assert.equal(getRequiredPetAssetMutation(
      undefined,
      {
        modelId: 'dmeloper',
        dmeloperSkinModel: 'wide',
        dmeloperSkinUrl: 'skin:latest',
      },
    ), 'model')
  })

  it('does not reload when cancellation preserved the requested asset', () => {
    const dmeloper = {
      modelId: 'dmeloper' as const,
      dmeloperSkinModel: 'wide' as const,
      dmeloperSkinUrl: 'skin:current',
    }

    assert.equal(getRequiredPetAssetMutation(dmeloper, dmeloper), 'none')
  })

  it('reapplies only the skin when the loaded Dmeloper skin is stale', () => {
    assert.equal(getRequiredPetAssetMutation(
      {
        modelId: 'dmeloper',
        dmeloperSkinModel: 'wide',
        dmeloperSkinUrl: 'skin:stale',
      },
      {
        modelId: 'dmeloper',
        dmeloperSkinModel: 'slim',
        dmeloperSkinUrl: 'skin:latest',
      },
    ), 'skin')
  })

  it('honors an explicit model reload even when identities match', () => {
    assert.equal(getRequiredPetAssetMutation(
      { modelId: 'dmeloper' },
      { modelId: 'dmeloper' },
      true,
    ), 'model')
  })
})
