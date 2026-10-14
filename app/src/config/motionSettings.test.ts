/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import defaults from './defaultSettings.json'
import { DEFAULT_HEADBUTT_MAX_RADIUS_OFFSET, getHeadbuttReachRadius, HEADBUTT_REACH_RADII, normalizeHeadbuttMaxRadiusOffset } from './headbuttRadius'
import { DEFAULT_HEADBUTT_RECOIL_SETTINGS, HEADBUTT_RECOIL_LIMITS, normalizeHeadbuttRecoilSettings } from './headbuttRecoil'
import ranges from './presetRanges.json'
import { DEFAULT_TYPING_MOTION_SETTINGS, normalizeTypingMotionSettings, TYPING_MOTION_LIMITS } from './typingMotion'

describe('authored motion settings at the runtime boundary', () => {
  it('keeps calibrated radius endpoints and continuous intermediate values independent from device geometry', () => {
    assert.equal(DEFAULT_HEADBUTT_MAX_RADIUS_OFFSET, 0)
    assert.equal(getHeadbuttReachRadius(-1), HEADBUTT_REACH_RADII.min)
    assert.equal(getHeadbuttReachRadius(0), HEADBUTT_REACH_RADII.default)
    assert.equal(getHeadbuttReachRadius(1), HEADBUTT_REACH_RADII.max)
    assert.equal(getHeadbuttReachRadius(-0.5), (HEADBUTT_REACH_RADII.min + HEADBUTT_REACH_RADII.default) / 2)
    assert.equal(getHeadbuttReachRadius(0.5), (HEADBUTT_REACH_RADII.max + HEADBUTT_REACH_RADII.default) / 2)
    assert.equal(normalizeHeadbuttMaxRadiusOffset(-2), -1)
    assert.equal(normalizeHeadbuttMaxRadiusOffset(2), 1)
    for (const invalid of [Number.NaN, Infinity, '1', null, undefined]) {
      assert.equal(normalizeHeadbuttMaxRadiusOffset(invalid, 0.6), 0.6)
    }
  })

  it('uses the same defaults and bounds as durable presets', () => {
    assert.deepEqual(DEFAULT_TYPING_MOTION_SETTINGS, {
      petTypingMaxRadiusOffset: 0,
      petTypingHandLiftPercent: 100,
      petTypingBodyMotionPercent: 100,
      petTypingReturnSpeedPercent: 100,
    })
    assert.deepEqual(DEFAULT_HEADBUTT_RECOIL_SETTINGS, {
      petHeadbuttRecoilEnabled: true,
      petHeadbuttRecoilStrengthPercent: 50,
      petHeadbuttRecoilWobblePercent: 50,
    })
    for (const key of Object.keys(DEFAULT_TYPING_MOTION_SETTINGS) as (keyof typeof DEFAULT_TYPING_MOTION_SETTINGS)[]) {
      assert.equal(DEFAULT_TYPING_MOTION_SETTINGS[key], defaults.preset[key])
      assert.deepEqual(TYPING_MOTION_LIMITS[key], ranges.preset[key])
    }
    for (const key of Object.keys(HEADBUTT_RECOIL_LIMITS) as (keyof typeof HEADBUTT_RECOIL_LIMITS)[]) {
      assert.equal(DEFAULT_HEADBUTT_RECOIL_SETTINGS[key], defaults.preset[key])
      assert.deepEqual(HEADBUTT_RECOIL_LIMITS[key], ranges.preset[key])
    }
  })

  it('clamps both ends of every typing range while retaining fractional values', () => {
    for (const [key, range] of Object.entries(TYPING_MOTION_LIMITS)) {
      for (const [value, expected] of [[range.min - 1, range.min], [range.min, range.min], [100.5, 100.5], [range.max, range.max], [range.max + 1, range.max]]) {
        assert.equal(normalizeTypingMotionSettings({ [key]: value })[key as keyof typeof TYPING_MOTION_LIMITS], Math.min(range.max, Math.max(range.min, expected)))
      }
    }
  })

  it('clamps both ends of recoil ranges and accepts only actual enable booleans', () => {
    for (const [key, range] of Object.entries(HEADBUTT_RECOIL_LIMITS)) {
      for (const [value, expected] of [[range.min - 1, range.min], [range.min, range.min], [25.5, 25.5], [range.max, range.max], [range.max + 1, range.max]]) {
        assert.equal(normalizeHeadbuttRecoilSettings({ [key]: value })[key as keyof typeof HEADBUTT_RECOIL_LIMITS], expected)
      }
    }
    assert.equal(normalizeHeadbuttRecoilSettings({ petHeadbuttRecoilEnabled: false }).petHeadbuttRecoilEnabled, false)
    for (const invalid of [0, 1, 'false', null, undefined]) {
      assert.equal(normalizeHeadbuttRecoilSettings({ petHeadbuttRecoilEnabled: invalid as unknown as boolean }).petHeadbuttRecoilEnabled, true)
    }
  })

  it('keeps last valid values for partial and invalid live updates without mutating callers', () => {
    const typing = { petTypingMaxRadiusOffset: 0.6, petTypingHandLiftPercent: 275, petTypingBodyMotionPercent: 125, petTypingReturnSpeedPercent: 350 }
    const recoil = { petHeadbuttRecoilEnabled: false, petHeadbuttRecoilStrengthPercent: 175, petHeadbuttRecoilWobblePercent: 75 }
    assert.deepEqual(normalizeTypingMotionSettings({}, typing), typing)
    assert.deepEqual(normalizeHeadbuttRecoilSettings({}, recoil), recoil)
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', null, undefined]) {
      assert.deepEqual(normalizeTypingMotionSettings({ petTypingHandLiftPercent: invalid as number, petTypingBodyMotionPercent: invalid as number, petTypingReturnSpeedPercent: invalid as number }, typing), typing)
      assert.deepEqual(normalizeHeadbuttRecoilSettings({ petHeadbuttRecoilStrengthPercent: invalid as number, petHeadbuttRecoilWobblePercent: invalid as number }, recoil), recoil)
    }
    assert.deepEqual(normalizeTypingMotionSettings({ petTypingHandLiftPercent: 50 }, typing), { ...typing, petTypingHandLiftPercent: 50 })
    assert.deepEqual(normalizeHeadbuttRecoilSettings({ petHeadbuttRecoilEnabled: true }, recoil), { ...recoil, petHeadbuttRecoilEnabled: true })
    assert.deepEqual(typing, { petTypingMaxRadiusOffset: 0.6, petTypingHandLiftPercent: 275, petTypingBodyMotionPercent: 125, petTypingReturnSpeedPercent: 350 })
    assert.deepEqual(recoil, { petHeadbuttRecoilEnabled: false, petHeadbuttRecoilStrengthPercent: 175, petHeadbuttRecoilWobblePercent: 75 })
  })
})
