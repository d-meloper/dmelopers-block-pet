/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three'

import { createHeadbutt, DEFAULT_HEADBUTT_TUNING, getDeskGrip } from './headbutt'

const target = (x: number) => ({ position: [x, 0.1, 0.4] as [number, number, number] })

describe('headbutt elapsed-time pulses', () => {
  it('keeps physical holds, targets, charge-stage recovery and dev tuning unchanged by live recoil controls', () => {
    const motions = [createHeadbutt({}, () => 0), createHeadbutt({}, () => 0)]
    const settingsBefore = { ...motions[1].tuning }
    for (const motion of motions) {
      motion.setRecoveryDistance(90)
      motion.setHeld(true, 1000, target(1))
      motion.press(target(1), 1000)
    }
    for (const at of [1050, 1130, 1160, 1500, 3000, 4000]) {
      motions[1].setRecoilSettings({ petHeadbuttRecoilEnabled: at !== 1500, petHeadbuttRecoilStrengthPercent: 200, petHeadbuttRecoilWobblePercent: 100 }, at)
      assert.deepEqual(motions[0].update(at), motions[1].update(at), `held pose at ${at}`)
    }
    for (const motion of motions) motion.setHeld(false, 4000)
    let recoilDiffers = false
    for (let at = 4000; at <= 7000; at += 5) {
      const [baseline, tuned] = motions.map(motion => motion.update(at))
      const { recoilDegrees: baselineRecoil, ...baselinePose } = baseline
      const { recoilDegrees: tunedRecoil, ...tunedPose } = tuned
      assert.deepEqual(baselinePose, tunedPose, `recovery pose at ${at}`)
      assert.ok(Number.isFinite(tunedRecoil) && Math.abs(tunedRecoil) <= 27)
      recoilDiffers ||= Math.abs(tunedRecoil - baselineRecoil) > 1
    }
    assert.ok(recoilDiffers, 'the live setting changes the subsequent spring without changing its recovery phase')
    assert.deepEqual(motions[1].tuning, settingsBefore)
  })

  it('grips, strikes exactly once, waits for quiet and releases on exact deadlines', () => {
    const motion = createHeadbutt({}, () => 0)
    motion.press(target(1), 1000)
    assert.equal(motion.update(1025).grip, 0.5)
    assert.equal(motion.update(1050).phase, 'down')
    assert.equal(motion.update(1090).depth, 0.5)
    assert.equal(motion.update(1130).phase, 'contact')
    assert.equal(motion.update(1160).phase, 'rebound')
    assert.equal(motion.update(1285).depth, 0.625, 'half-time recovery accelerates instead of easing out')
    assert.equal(motion.update(1410).phase, 'quiet')
    assert.equal(motion.update(1420).phase, 'return')
    assert.equal(motion.update(1920).grip, 0.5)
    assert.deepEqual(motion.update(2420), {
      phase: 'idle',
      recovering: false,
      depth: 0,
      grip: 0,
      target: undefined,
      session: 1,
      cycle: 1,
      recoilDegrees: 0,
      holdNeckAmount: 0,
      holdShakeDegrees: 0,
      holdBreathAmount: 0,
    })
    assert.equal(motion.update(9000).cycle, 1)
    assert.equal(motion.active, false)
  })

  it('freezes down/contact and keeps only the latest pending target without restarting velocity', () => {
    const motion = createHeadbutt()
    const source = target(1)
    motion.press(source, 1000)
    source.position[0] = 99
    const before = motion.update(1090)
    motion.press(target(2), 1090)
    assert.deepEqual(motion.update(1090), before)
    motion.press(target(3), 1120)
    motion.press(target(4), 1140)
    assert.equal(motion.update(1159).target!.position[0], 1)
    assert.equal(motion.update(1199).phase, 'rebound')
    const restarted = motion.update(1200)
    assert.equal(restarted.target!.position[0], 4)
    assert.equal(restarted.cycle, 2)
    assert.equal(restarted.phase, 'down')
    assert.ok(Math.abs(restarted.depth - 0.9072) < 1e-12, 'restart retains the visible lift from the protected 40 ms')
    assert.equal(motion.update(5000).phase, 'idle')
    assert.equal(motion.update(5000).cycle, 2)
  })

  it('immediately resumes from the current depth and grip during arm return', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    const before = motion.update(1550)
    motion.press(target(2), 1550)
    const resumed = motion.update(1550)
    assert.equal(resumed.phase, 'down')
    assert.equal(resumed.target!.position[0], 2)
    assert.equal(resumed.depth, before.depth)
    assert.equal(resumed.grip, before.grip)
    assert.equal(resumed.cycle, 2)
    assert.equal(motion.update(1630).phase, 'contact')
    assert.equal(motion.update(5000).cycle, 2)
  })

  it('cancels pending pulses while preserving the current strike and smooth rebound', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.press(target(2), 1110)
    const before = motion.update(1120)
    motion.cancel(1120)
    assert.deepEqual(motion.update(1120), before)
    assert.equal(motion.update(1410).phase, 'return')
    assert.equal(motion.update(2410).phase, 'idle')
    assert.equal(motion.update(5000).cycle, 1)
  })

  it('produces the same exact phases at 8, 16, 33 and 100 ms frame intervals', () => {
    const motions = [8, 16, 33, 100].map((interval) => {
      const motion = createHeadbutt({}, () => 0.5)
      motion.setRecoveryDistance(90)
      motion.press(target(1), 1000)
      for (let time = 1000; time < 1150; time += interval) motion.update(time)
      motion.press(target(2), 1150)
      for (let time = 1150; time < 1250; time += interval) motion.update(time)
      motion.press(target(3), 1250)
      return motion
    })
    for (const at of [1300, 1400, 1480, 1520, 1560, 1700, 1900, 2050]) {
      const poses = motions.map(motion => motion.update(at))
      for (const pose of poses) assert.deepEqual(pose, poses[0])
    }
  })

  it('discards a short tap inside the protected rise without replaying it later', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.setHeld(true, 1170, target(2))
    motion.press(target(2), 1170)
    motion.setHeld(false, 1199)
    assert.equal(motion.update(1200).phase, 'rebound')
    assert.equal(motion.update(1200).cycle, 1)
    assert.equal(motion.update(5000).cycle, 1)
    assert.equal(motion.active, false)
  })

  it('resumes a still-held protected target exactly at the minimum rise deadline', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.setHeld(true, 1170, target(2))
    motion.press(target(2), 1170)
    const before = motion.update(1199.999)
    assert.equal(before.phase, 'rebound')
    assert.equal(before.cycle, 1)
    const resumed = motion.update(1200)
    assert.equal(resumed.phase, 'down')
    assert.equal(resumed.target!.position[0], 2)
    assert.equal(resumed.cycle, 2)
    assert.ok(resumed.depth < 1 && resumed.depth > 0.9)
    assert.equal(motion.update(1310).phase, 'hold')
    assert.equal(motion.update(5000).phase, 'hold')
    assert.equal(motion.update(5000).cycle, 2, 'a physical hold creates no repeated strike queue')
  })

  it('preserves a deferred hold through a skipped frame and a key-up after its deadline', () => {
    const motions = [false, true].map((drawDeadline) => {
      const motion = createHeadbutt({}, () => 0.5)
      motion.setRecoveryDistance(90)
      motion.press(target(1), 1000)
      motion.setHeld(true, 1170, target(2))
      motion.press(target(2), 1170)
      if (drawDeadline) {
        motion.update(1200)
        motion.update(1280)
        motion.update(1310)
      }
      motion.setHeld(false, 1320)
      return motion
    })
    for (const at of [1320, 1400, 1570, 1700, 2400]) {
      assert.deepEqual(motions[0].update(at), motions[1].update(at))
    }
    assert.equal(motions[0].update(5000).cycle, 2)
  })

  it('can resume a new physical hold during the protected rise after cancellation', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.cancel(1165)
    motion.setHeld(true, 1170, target(2))
    motion.press(target(2), 1170)
    assert.equal(motion.update(1199).cycle, 1)
    const resumed = motion.update(1200)
    assert.equal(resumed.phase, 'down')
    assert.equal(resumed.target!.position[0], 2)
    assert.equal(motion.update(1310).phase, 'hold')
  })

  it('keeps the latest held chord member when its primary press was protected', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.setHeld(true, 1170, target(2))
    motion.press(target(2), 1170)
    motion.setHeld(true, 1175, target(3))
    motion.press(target(3), 1175, true)
    assert.equal(motion.update(1199).cycle, 1)
    const resumed = motion.update(1200)
    assert.equal(resumed.phase, 'down')
    assert.equal(resumed.target!.position[0], 3)
    assert.equal(resumed.cycle, 2)
    assert.equal(motion.update(1310).phase, 'hold')
    assert.equal(motion.update(5000).cycle, 2)
  })

  it('retains the protected chord primary when its newer member is released first', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.setHeld(true, 1170, target(2))
    motion.press(target(2), 1170)
    motion.setHeld(true, 1175, target(3))
    motion.press(target(3), 1175, true)
    motion.setHeld(true, 1180, target(2))
    const resumed = motion.update(1200)
    assert.equal(resumed.phase, 'down')
    assert.equal(resumed.target!.position[0], 2, 'remaining held key must survive a sibling key-up')
    assert.equal(motion.update(1310).phase, 'hold')
    assert.equal(motion.update(5000).cycle, 2)
  })

  it('accepts a key held through the exact rise deadline before applying its key-up', () => {
    const motion = createHeadbutt()
    motion.press(target(1), 1000)
    motion.setHeld(true, 1170, target(2))
    motion.press(target(2), 1170)
    motion.setHeld(false, 1200)
    const resumed = motion.update(1200)
    assert.equal(resumed.phase, 'down')
    assert.equal(resumed.target!.position[0], 2)
    assert.equal(resumed.cycle, 2)
    assert.equal(motion.update(1310).phase, 'rebound')
  })

  it('coalesces a held chord into one pulse aimed at its latest member', () => {
    const motion = createHeadbutt()
    motion.setHeld(true, 1000, target(1))
    motion.press(target(1), 1000)
    motion.setHeld(true, 1010, target(2))
    motion.press(target(2), 1010, true)
    motion.setHeld(true, 1039, target(3))
    motion.press(target(3), 1039, true)
    assert.equal(motion.update(1160).phase, 'hold')
    assert.equal(motion.update(1160).target!.position[0], 3)
    assert.equal(motion.update(1160).cycle, 1)
    motion.setHeld(false, 1170)
    assert.equal(motion.update(5000).cycle, 1)
  })

  it('freezes the rise duration even when rejected physical input crosses a charge stage', () => {
    const motion = createHeadbutt()
    motion.setHeld(true, 0, target(1))
    motion.press(target(1), 0)
    motion.setHeld(false, 990)
    assert.equal(motion.update(990).phase, 'rebound')
    motion.setHeld(true, 1010, target(2))
    motion.press(target(2), 1010)
    motion.setHeld(false, 1011)
    assert.equal(motion.update(1239.999).phase, 'rebound')
    assert.equal(motion.update(1240).phase, 'return', 'the existing stage-1 rise remains 250 ms')
  })

  it('uses each physical hold stage for both the full rise and its spring arrival speed', () => {
    for (const [heldMs, recoveryMs] of [[1000, 250], [2000, 200], [3000, 175], [4000, 150]]) {
      const motion = createHeadbutt({}, () => 0)
      motion.setRecoveryDistance(90)
      motion.setHeld(true, 1000, target(1))
      motion.press(target(1), 1000)
      const releaseAt = 1000 + heldMs
      motion.setHeld(false, releaseAt)
      const arrivalAt = releaseAt + recoveryMs
      const stepMs = 0.001
      assert.equal(motion.update(arrivalAt - stepMs).phase, 'rebound')
      assert.equal(motion.update(arrivalAt).phase, 'return')
      const outgoing = motion.update(arrivalAt + stepMs).recoilDegrees * 1000 / stepMs
      const expected = 90 * 1000 / recoveryMs * 1.5
      assert.ok(Math.abs(outgoing - expected) < 0.1, `${heldMs} ms hold: incoming ${expected} / spring ${outgoing}`)
    }
  })

  it('turns off breathing by physical hold age while the neck and shake remain held', () => {
    const motion = createHeadbutt()
    motion.setHeld(true, 1000, target(1))
    motion.press(target(1), 1000)
    assert.equal(motion.update(1160).holdNeckAmount, 0)
    assert.equal(motion.update(1260).holdNeckAmount, 0.5)
    const held = motion.update(1360)
    assert.equal(held.holdNeckAmount, 1)
    assert.equal(held.holdBreathAmount, 1)
    assert.equal(motion.update(1900).holdBreathAmount, 0.5)
    assert.equal(motion.update(2000).holdBreathAmount, 0)
    const late = motion.update(6160)
    assert.equal(late.phase, 'hold')
    assert.equal(late.holdNeckAmount, 1)
    assert.ok(Number.isFinite(late.holdShakeDegrees) && Math.abs(late.holdShakeDegrees) <= 3.2)
    assert.equal(late.holdBreathAmount, 0)
  })

  it('accelerates through neutral and transfers its arrival velocity into recoil', () => {
    const motion = createHeadbutt({}, () => 0)
    motion.setRecoveryDistance(90)
    motion.press(target(1), 1000)
    const quarter = motion.update(1222.5).depth
    const middle = motion.update(1285).depth
    const late = motion.update(1347.5).depth
    assert.ok(quarter - middle < middle - late, 'successive equal intervals recover farther')
    const stepMs = 0.001
    const before = motion.update(1410 - stepMs)
    const neutral = motion.update(1410)
    const after = motion.update(1410 + stepMs)
    assert.equal(neutral.depth, 0)
    assert.equal(neutral.recoilDegrees, 0)
    const incoming = before.depth * 90 * 1000 / stepMs
    const outgoing = after.recoilDegrees * 1000 / stepMs
    assert.ok(Math.abs(incoming - 540) < 0.01)
    assert.ok(Math.abs(outgoing - incoming) < 0.05, `arrival velocity ${incoming} must continue into spring ${outgoing}`)
  })

  it('keeps dev tuning finite and within the runtime articulation safety limits', () => {
    const motion = createHeadbutt()
    motion.setTuning({ downMs: -10, maxStretch: 9, maxTorsoPitchDegrees: 999, minExtendedTorsoPitchDegrees: -2, maxExtendedHeadYawDegrees: 999, returnMs: Number.NaN })
    assert.equal(motion.tuning.downMs, 1)
    assert.equal(motion.tuning.maxStretch, 1.5)
    assert.equal(motion.tuning.maxTorsoPitchDegrees, 90)
    assert.equal(motion.tuning.minExtendedTorsoPitchDegrees, 0)
    assert.equal(motion.tuning.maxExtendedHeadYawDegrees, 90)
    assert.equal(motion.tuning.returnMs, DEFAULT_HEADBUTT_TUNING.returnMs)
  })
})

it('extracts a fixed pet-facing lip from actual desk geometry through nested world transforms', () => {
  const scene = new Group()
  scene.rotation.y = 0.6
  scene.position.set(4, 2, -1)
  const desk = new Mesh(new BoxGeometry(3, 0.2, 2), new MeshBasicMaterial())
  desk.position.set(0, 0.4, 2)
  desk.scale.set(0.7, 1.5, 1.2)
  scene.add(desk)
  const shoulder = scene.localToWorld(new Vector3(0.2, 1, 0))
  const pet = scene.localToWorld(new Vector3(0, 0, 0))
  const grip = getDeskGrip(desk, shoulder, pet, new Vector3())!
  const local = desk.worldToLocal(grip)
  assert.ok(Math.abs(local.y - 0.1) < 1e-6)
  assert.ok(Math.abs(local.z + 1) < 1e-6)
  assert.ok(local.x >= -1.5 && local.x <= 1.5)
  desk.geometry.dispose()
  desk.material.dispose()
})
