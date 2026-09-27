/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { INVOKE_KEY } from '@/constants'

import {
  createMinecraftSkinBlob,
  createMinecraftSkinDataUrl,
  fetchMinecraftSkin,
  LatestRequestGate,
  MinecraftSkinError,
  normalizeMinecraftSkinError,
} from './minecraftSkin'

const VALID_RESPONSE = {
  canonicalName: 'jeb_',
  uuid: '853c80ef3c3749fdaa49938b674adae6',
  model: 'wide' as const,
  textureKey: 'a'.repeat(64),
  pngBase64: 'iVBORw0KGgo=',
  sha256: 'a'.repeat(64),
  width: 64 as const,
  height: 64 as const,
  cacheHit: false,
}

describe('Minecraft skin frontend service', () => {
  it('rejects invalid usernames before invoking Tauri', async () => {
    let invocations = 0
    const invokeCommand = async <T>() => {
      invocations += 1
      return VALID_RESPONSE as T
    }

    await assert.rejects(
      fetchMinecraftSkin('bad-name', invokeCommand),
      (error: unknown) => error instanceof MinecraftSkinError
        && error.code === 'INVALID_USERNAME',
    )
    assert.equal(invocations, 0)
  })

  it('trims the username and validates the complete response contract', async () => {
    const invokeCommand = async <T>(command: string, args?: Record<string, unknown>) => {
      assert.equal(command, INVOKE_KEY.FETCH_MINECRAFT_SKIN)
      assert.deepEqual(args, { username: 'jeb_' })
      return VALID_RESPONSE as T
    }

    const result = await fetchMinecraftSkin('  jeb_  ', invokeCommand)
    assert.deepEqual(result, VALID_RESPONSE)
    assert.equal(
      createMinecraftSkinDataUrl(result.pngBase64),
      `data:image/png;base64,${VALID_RESPONSE.pngBase64}`,
    )
    const blob = createMinecraftSkinBlob(result.pngBase64)
    assert.equal(blob.type, 'image/png')
    assert.deepEqual(
      [...new Uint8Array(await blob.arrayBuffer())],
      [137, 80, 78, 71, 13, 10, 26, 10],
    )
  })

  it('rejects malformed backend success payloads', async () => {
    const invokeCommand = async <T>() => ({
      ...VALID_RESPONSE,
      textureKey: '../not-a-texture',
    }) as T

    await assert.rejects(
      fetchMinecraftSkin('jeb_', invokeCommand),
      (error: unknown) => error instanceof MinecraftSkinError
        && error.code === 'INVALID_RESPONSE'
        && error.retryable === false,
    )
  })

  it('normalizes structured and JSON-serialized backend errors', () => {
    const limited = normalizeMinecraftSkinError({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: 4.2,
    })
    assert.equal(limited.code, 'RATE_LIMITED')
    assert.equal(limited.retryable, true)
    assert.equal(limited.retryAfterSeconds, 5)

    const notFound = normalizeMinecraftSkinError(JSON.stringify({
      code: 'PROFILE_NOT_FOUND',
      retryable: false,
    }))
    assert.equal(notFound.code, 'PROFILE_NOT_FOUND')
    assert.equal(notFound.retryable, false)
  })

  it('invalidates stale responses after a newer request or tab change', () => {
    const gate = new LatestRequestGate()
    const first = gate.begin()
    const second = gate.begin()
    assert.equal(gate.isCurrent(first), false)
    assert.equal(gate.isCurrent(second), true)

    gate.invalidate()
    assert.equal(gate.isCurrent(second), false)
  })
})
