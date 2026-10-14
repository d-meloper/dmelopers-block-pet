/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_HEADBUTT_RECOIL_SETTINGS } from '@/config/headbuttRecoil'

import { DEFAULT_HEADBUTT_TUNING } from './headbutt'
import { createHeadbuttRecoil } from './headbuttRecoil'

const tuning = { ...DEFAULT_HEADBUTT_TUNING }
const velocity = 90 * 1000 / 250 * 1.5

function springPeak(amplitude: number, damping: number, incomingVelocity = velocity) {
  const dampedRatio = Math.sqrt(1 - damping * damping)
  const peakDecay = Math.exp(-damping * Math.acos(damping) / dampedRatio)
  const omega = incomingVelocity * peakDecay / amplitude
  return Math.acos(damping) / (omega * dampedRatio) * 1000
}

describe('headbutt recoil charge and stages', () => {
  it('counts continuous physical holds, with exact stage endpoints and no recovery-time charge', () => {
    const recoil = createHeadbuttRecoil(tuning)
    recoil.setHeld(true, 0)
    recoil.notePress(0)
    for (const [age, expected] of [
      [999.999, 250],
      [1000, 250],
      [1000.001, 200],
      [2000, 200],
      [2000.001, 175],
      [3000, 175],
      [3000.001, 150],
    ]) assert.equal(recoil.getRecoveryDuration(age), expected, `physical hold ${age} ms`)
    recoil.setHeld(false, 3000)
    assert.equal(recoil.getRecoveryDuration(10000), 175, 'exactly 3 seconds remains stage 3 after key-up')
  })

  it('accumulates fresh typing across the inclusive gap and resets beyond it', () => {
    const recoil = createHeadbuttRecoil(tuning)
    for (const at of [0, 500, 1000, 1500, 2000, 2500, 3000]) recoil.notePress(at)
    assert.equal(recoil.getRecoveryDuration(9000), 175, 'released input is charged through its last press only')
    recoil.notePress(3500.001)
    assert.equal(recoil.getRecoveryDuration(3500.001), 250, 'a gap above 500 ms starts a new burst')
  })

  it('preserves a continuous held burst when another fresh key is pressed after a long gap', () => {
    const recoil = createHeadbuttRecoil(tuning)
    recoil.setHeld(true, 1000)
    recoil.notePress(1000)
    recoil.notePress(3500)
    assert.equal(recoil.getRecoveryDuration(3500), 175)
    recoil.setHeld(false, 4100)
    assert.equal(recoil.getRecoveryDuration(9000), 150)
    recoil.resetCharge()
    assert.equal(recoil.getRecoveryDuration(9000), 250)
  })
})

describe('headbutt recoil spring', () => {
  it('preserves the existing default spring, charge stages and random sampling with explicit midpoint controls', () => {
    const motions = [createHeadbuttRecoil(tuning, () => 0.5), createHeadbuttRecoil(tuning, () => 0.5)]
    motions[1].setSettings(DEFAULT_HEADBUTT_RECOIL_SETTINGS, 0)
    for (const motion of motions) {
      motion.setHeld(true, 0)
      motion.notePress(0)
      motion.setHeld(false, 3000)
      motion.prepareRecovery(90, 175, 1.5, 3000)
      motion.start(3175)
    }
    for (let at = 3175; at <= 5200; at += 7) {
      assert.equal(motions[0].getDegrees(at), motions[1].getDegrees(at))
      assert.equal(motions[0].active, motions[1].active)
    }
  })

  it('scales the first peak by strength, saturates at 27 degrees and preserves incoming velocity', () => {
    for (const [strength, amplitude] of [[0, 0], [25, 4], [50, 8], [100, 16], [200, 27], [500, 27]]) {
      const motion = createHeadbuttRecoil(tuning, () => 0)
      motion.setSettings({ petHeadbuttRecoilStrengthPercent: strength }, 1000)
      motion.notePress(1000)
      motion.prepareRecovery(90, 250, 1.5, 1160)
      motion.start(1410)
      if (amplitude === 0) {
        assert.equal(motion.active, false)
        assert.equal(motion.getDegrees(1450), 0)
      } else {
        assert.ok(Math.abs(motion.getDegrees(1410 + springPeak(amplitude, 0.4)) - amplitude) < 1e-9)
        assert.ok(Math.abs(motion.getDegrees(1410.001) * 1000 / 0.001 - velocity) < 0.1)
      }
    }
  })

  it('changes wobble damping and lifetime while retaining the selected angle and safe cap', () => {
    for (const [wobble, damping, duration] of [[-10, 0.95, 900], [0, 0.95, 900], [50, 0.4, 1800], [100, 0.05, 2700], [200, 0.05, 2700]]) {
      const motion = createHeadbuttRecoil(tuning, () => 0)
      motion.setSettings({ petHeadbuttRecoilWobblePercent: wobble }, 1000)
      motion.notePress(1000)
      motion.prepareRecovery(90, 250, 1.5, 1160)
      motion.start(1410)
      assert.ok(Math.abs(motion.getDegrees(1410 + springPeak(8, damping)) - 8) < 1e-9)
      let negativePeak = 0
      for (let age = 0; age < duration; age++) {
        const value = motion.getDegrees(1410 + age)
        assert.ok(Number.isFinite(value) && Math.abs(value) <= 27)
        negativePeak = Math.min(negativePeak, value)
      }
      if (wobble <= 0) assert.ok(negativePeak > -0.01, 'minimum wobble visibly damps out the forward swing')
      if (wobble >= 100) assert.ok(negativePeak < -5, 'maximum wobble retains a visible forward swing')
      assert.equal(motion.getDegrees(1410 + duration), 0)
      assert.equal(motion.active, false)
    }
  })

  for (const disabled of [{ petHeadbuttRecoilEnabled: false }, { petHeadbuttRecoilStrengthPercent: 0 }]) {
    it(`fades live disable within 120 ms without restarting an existing input release: ${JSON.stringify(disabled)}`, () => {
      const motions = [createHeadbuttRecoil(tuning, () => 0), createHeadbuttRecoil(tuning, () => 0)]
      for (const motion of motions) {
        motion.setSettings({ petHeadbuttRecoilWobblePercent: 100 }, 1000)
        motion.notePress(1000)
        motion.prepareRecovery(90, 250, 1.5, 1160)
        motion.start(1410)
        motion.release(1420, 1000)
      }
      const at = 1440
      const step = 0.001
      const before = motions[0].getDegrees(at - step)
      const current = motions[0].getDegrees(at)
      motions[0].setSettings(disabled, at)
      assert.equal(motions[0].getDegrees(at), current, 'live disable retains displacement')
      const after = motions[0].getDegrees(at + step)
      assert.ok(Math.abs((after - current) * 1000 / step - (current - before) * 1000 / step) < 0.1, 'live disable retains velocity')
      motions[0].setSettings(disabled, at + 60)
      assert.ok(Math.abs(motions[0].getDegrees(at + 60) - motions[1].getDegrees(at + 60) * 0.5) < 1e-9)
      assert.ok(Math.abs(motions[1].getDegrees(at + 120)) > 0.01, 'the input-release control is still moving at the disable deadline')
      assert.equal(motions[0].getDegrees(at + 120), 0)
      assert.equal(motions[0].active, false)
    })
  }

  it('cancels a prepared spring on live disable, retains physical hold charge and recovers on the next rise', () => {
    const motion = createHeadbuttRecoil(tuning, () => 0)
    motion.setHeld(true, 1000)
    motion.notePress(1000)
    motion.prepareRecovery(90, 250, 1.5, 1160)
    motion.setSettings({ petHeadbuttRecoilEnabled: false }, 1200)
    motion.setSettings({ petHeadbuttRecoilEnabled: true }, 1300)
    motion.start(1410)
    assert.equal(motion.active, false, 're-enabling must not resurrect a retired prepared spring')
    assert.equal(motion.getRecoveryDuration(4000), 175, 'the physical hold still charges stage 3')
    motion.setHeld(false, 4000)
    motion.prepareRecovery(90, 175, 1.5, 4000)
    motion.start(4175)
    assert.ok(motion.getDegrees(4200) > 0)
  })

  it('samples every inclusive amplitude and damping step in the approved stage ranges', () => {
    const stages = [
      { age: 1000, minDegrees: 8, maxDegrees: 11, minDamping: 0.4, maxDamping: 0.7 },
      { age: 2000, minDegrees: 12, maxDegrees: 18, minDamping: 0.2, maxDamping: 0.5 },
      { age: 3000, minDegrees: 18, maxDegrees: 22, minDamping: 0.15, maxDamping: 0.4 },
      { age: 4000, minDegrees: 20, maxDegrees: 27, minDamping: 0.1, maxDamping: 0.25 },
    ]
    for (const stage of stages) {
      const degreeSteps = Math.round((stage.maxDegrees - stage.minDegrees) * 2) + 1
      const dampingSteps = Math.round((stage.maxDamping - stage.minDamping) * 20) + 1
      for (let degreeStep = 0; degreeStep < degreeSteps; degreeStep++) {
        for (let dampingStep = 0; dampingStep < dampingSteps; dampingStep++) {
          let samples = 0
          const recoil = createHeadbuttRecoil(tuning, () => {
            samples += 1
            return samples === 1 ? (degreeStep + 0.5) / degreeSteps : (dampingStep + 0.5) / dampingSteps
          })
          recoil.setHeld(true, 0)
          recoil.notePress(0)
          recoil.setHeld(false, stage.age)
          recoil.prepareRecovery(90, 250, 1.5, stage.age)
          recoil.start(stage.age)
          const amplitude = stage.minDegrees + degreeStep * 0.5
          const damping = stage.minDamping + dampingStep * 0.05
          const peakAt = stage.age + springPeak(amplitude, damping)
          assert.ok(Math.abs(recoil.getDegrees(peakAt) - amplitude) < 1e-9, `stage ${stage.age} / ${amplitude} degrees / damping ${damping}`)
          assert.equal(samples, 2, 'sample once per rise, independently for angle and damping')
        }
      }
    }
  })

  it('retains sampled parameters while measured recovery velocity changes', () => {
    let samples = 0
    const recoil = createHeadbuttRecoil(tuning, () => {
      samples += 1
      return 0
    })
    recoil.notePress(1000)
    recoil.prepareRecovery(45, 250, 1.5, 1160)
    recoil.setRecoveryVelocity(90, 250, 1.5)
    recoil.setRecoveryVelocity(180, 250, 1.5)
    recoil.start(1410)
    assert.equal(samples, 2)
    assert.ok(Math.abs(recoil.getDegrees(1410 + springPeak(8, 0.4, velocity * 2)) - 8) < 1e-9)
    assert.equal(samples, 2)
  })

  it('carries displacement and velocity continuously through renewed-input release', () => {
    const recoil = createHeadbuttRecoil(tuning, () => 0)
    recoil.notePress(1000)
    recoil.prepareRecovery(90, 250, 1.5, 1160)
    recoil.start(1410)
    const releaseAt = 1450
    const stepMs = 0.001
    const before = recoil.getDegrees(releaseAt - stepMs)
    const current = recoil.getDegrees(releaseAt)
    recoil.release(releaseAt, 80)
    assert.equal(recoil.getDegrees(releaseAt), current)
    const after = recoil.getDegrees(releaseAt + stepMs)
    const incoming = (current - before) * 1000 / stepMs
    const outgoing = (after - current) * 1000 / stepMs
    assert.ok(Math.abs(incoming - outgoing) < 0.02, `release velocity ${incoming} -> ${outgoing}`)
    assert.equal(recoil.getDegrees(releaseAt + 80), 0)
    assert.equal(recoil.active, false)
  })

  it('stays within the global cap and settles at the bounded duration across skipped frames', () => {
    const recoil = createHeadbuttRecoil(tuning, () => 1)
    recoil.setHeld(true, 0)
    recoil.notePress(0)
    recoil.setHeld(false, 4000)
    recoil.prepareRecovery(90, 150, 1.5, 4000)
    recoil.start(4150)
    let hadForwardRebound = false
    for (let age = 0; age < 1800; age += 1) {
      const degrees = recoil.getDegrees(4150 + age)
      assert.ok(Number.isFinite(degrees) && Math.abs(degrees) <= 27)
      hadForwardRebound ||= degrees < -1
    }
    assert.ok(hadForwardRebound, 'the stronger spring visibly swings forward after its first backward overshoot')
    assert.equal(recoil.getDegrees(5950), 0)
    assert.equal(recoil.active, false)
    assert.equal(recoil.getDegrees(10000), 0)
  })

  it('starts no recoil for a zero-length return or a disabled cap', () => {
    for (const [distance, cap] of [[0, 27], [90, 0]]) {
      const recoil = createHeadbuttRecoil({ ...tuning, recoilMaxDegrees: cap }, () => 0)
      recoil.notePress(0)
      recoil.prepareRecovery(distance, 250, 1.5, 160)
      recoil.start(410)
      assert.equal(recoil.getDegrees(411), 0)
      assert.equal(recoil.active, false)
    }
  })
})
