/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { applyPresetSnapshot, capturePresetSnapshot, createPresetCollection } from '@/features/presets/model'
import { preparePresetSkin } from '@/features/presets/skin'
import { installPresetSkinBrowser } from '@/features/presets/skin.test.utils'
import { getRequiredPetAssetMutation } from '@/pages/main/petAssetSelection'
import { getResolvedDmeloperSkinUrl, resolveDmeloperSkinUrl } from '@/services/dmeloperSkin'

import { preparePetStateForSync, useBlockStore } from './block'

const entryId = 'a'.repeat(64)
const userSkin = 'data:image/png;base64,oldskin'
const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
function createStore() {
  setActivePinia(createPinia())
  return useBlockStore()
}
function selectUserSkin(store: ReturnType<typeof useBlockStore>) {
  store.applySkinLibraryEntry({ entryId, source: 'java', canonicalNickname: 'jeb_', dataUrl: userSkin, skinModel: 'slim' })
}

it('clears the old PNG across JSON and two webview stores and preserves the materialized default', async () => {
  const browser = installPresetSkinBrowser()
  try {
    await resolveDmeloperSkinUrl()
    for (const bulk of [false, true]) {
      const preference = createStore()
      selectUserSkin(preference)
      preference.updateDmeloperPalmColor('#334455')
      preference.presetCollection = { ...createPresetCollection(), activeId: 'saved', entries: [{ id: 'saved', name: 'Saved', favorite: false, snapshot: capturePresetSnapshot(preference) }] }
      const main = createStore()
      main.$patch(preparePetStateForSync(wire(preference.$state)))
      preference.handleSkinLibraryEntriesDeleted(bulk ? ['b'.repeat(64), entryId] : [entryId])
      const packet = wire(preference.$state)
      assert.equal('dmeloperSkinDataUrl' in packet.customization3d, false)
      const originalPacket = JSON.stringify(packet)
      // The native store replaces top-level values; frontend Pinia merges nested objects.
      main.$patch(preparePetStateForSync(packet))
      assert.equal(JSON.stringify(packet), originalPacket)
      assert.equal(main.customization3d.dmeloperSkinDataUrl, undefined)
      assert.equal(main.customization3d.minecraftSkinUsername, undefined)
      assert.equal(main.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(main.activePet3dPreset.dmeloperPalmColor, '#334455')
      const selected = {
        modelId: 'dmeloper' as const,
        dmeloperSkinModel: 'wide' as const,
        dmeloperSkinUrl: getResolvedDmeloperSkinUrl(main.customization3d.dmeloperSkinDataUrl),
      }
      assert.equal(selected.dmeloperSkinUrl, browser.dataUrl)
      assert.equal(getRequiredPetAssetMutation({ ...selected, dmeloperSkinUrl: userSkin }, selected), 'skin')
      const prepared = await preparePresetSkin(capturePresetSnapshot(main))
      applyPresetSnapshot(main, prepared)
      // A later materialized default must survive the same sync hook.
      preference.$patch(preparePetStateForSync(wire(main.$state)))
      assert.equal(preference.customization3d.dmeloperSkinDataUrl, browser.dataUrl)
      const restored = createStore()
      restored.$patch(preparePetStateForSync(wire(preference.$state)))
      assert.equal(restored.customization3d.activeSkinLibraryEntryId, 'builtin:dmeloper')
      assert.equal(getResolvedDmeloperSkinUrl(restored.customization3d.dmeloperSkinDataUrl), browser.dataUrl)
      assert.equal(restored.customization3d.minecraftSkinUsername, undefined)
    }
  } finally {
    browser.restore()
  }
})

it('preserves user skins and names when unrelated settings or valid user selections are synchronized', () => {
  const store = createStore()
  selectUserSkin(store)
  store.$patch(preparePetStateForSync({ customization3d: { preset: { cameraZoomPercent: 120 } } }))
  assert.equal(store.customization3d.dmeloperSkinDataUrl, userSkin)
  assert.equal(store.customization3d.minecraftSkinUsername, 'jeb_')
  const other = createStore()
  other.$patch(preparePetStateForSync(wire(store.$state)))
  assert.equal(other.customization3d.dmeloperSkinDataUrl, userSkin)
  assert.equal(other.customization3d.minecraftSkinUsername, 'jeb_')
})
