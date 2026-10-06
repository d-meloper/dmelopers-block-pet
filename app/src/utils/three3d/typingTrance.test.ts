/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTypingTrance } from './typingTrance'

function burst(controller: ReturnType<typeof createTypingTrance>, start = 0, end = 3200, frameMs = 20) {
  let nextPress = start
  for (let now = start; now <= end; now += frameMs) {
    while (nextPress <= now) {
      controller.press(nextPress)
      nextPress += 50
    }
    controller.update(now)
  }
}

describe('fast typing trance', () => {
  it('qualifies exact 12 Hz across timestamp rounding and either same-time frame order', () => {
    for (const round of [(value: number) => value, Math.floor, Math.round]) {
      for (const fps of [15, 20, 30, 60]) {
        for (const frameFirst of [false, true]) {
          let decisions = 0
          const trance = createTypingTrance(() => {
            decisions++
            return 0
          })
          const events = [
            ...Array.from({ length: 73 }, (_, index) => ({ at: round(index * 1000 / 12), frame: false })),
            ...Array.from({ length: fps * 6 + 1 }, (_, index) => ({ at: index * 1000 / fps, frame: true })),
          ].sort((left, right) => left.at - right.at || (Number(left.frame) - Number(right.frame)) * (frameFirst ? -1 : 1))
          for (const event of events) {
            if (event.frame) {
              trance.update(event.at)
            } else {
              // Exercise both event orders even when a rounded press falls
              // between the regular frame timestamps.
              if (frameFirst) trance.update(event.at)
              trance.press(event.at)
              if (!frameFirst) trance.update(event.at)
            }
          }
          assert.equal(decisions, 1, `${round.name || 'fractional'} / ${fps} FPS / frameFirst=${frameFirst}`)
          assert.equal(trance.update(6000).amount, 1)
        }
      }
    }
  })

  it('does not qualify slower input from a transient inclusive-window endpoint', () => {
    for (const hz of [1, 2, 6, 10, 11]) {
      let decisions = 0
      const trance = createTypingTrance(() => {
        decisions++
        return 0
      })
      let pressIndex = 0
      for (let now = 0; now <= 6000; now += 10) {
        while (pressIndex * 1000 / hz <= now) trance.press(pressIndex++ * 1000 / hz)
        trance.update(now)
      }
      assert.equal(decisions, 0)
      assert.equal(trance.update(6000).amount, 0)
    }
  })

  it('requires a full 1.2 seconds above the threshold, enters with certainty, and ramps in 600 ms', () => {
    for (const randomValue of [0, 0.75, 0.9999999999999999]) {
      let decisions = 0
      const trance = createTypingTrance(() => {
        decisions++
        return randomValue
      })
      // At 20 Hz the twelfth press lands at 550 ms. Qualify at 1750 ms.
      burst(trance, 0, 1740)
      assert.equal(decisions, 0)
      assert.equal(trance.update(1749).amount, 0)
      trance.press(1750)
      assert.equal(decisions, 1)
      assert.equal(trance.update(1750).amount, 0)
      burst(trance, 1800, 2000)
      assert.equal(trance.update(2050).amount, 0.5)
      burst(trance, 2050, 2300)
      assert.ok(trance.update(2349).amount < 1)
      trance.press(2350)
      assert.equal(trance.update(2350).amount, 1)
      burst(trance, 2400, 4200)
      assert.equal(decisions, 1, 'continued typing must not restart entry')
      trance.update(4400)
      assert.equal(trance.update(4800).amount, 0)
      burst(trance, 5200, 8400)
      assert.equal(decisions, 2, 'a new qualified burst can re-enter after quiet')
    }
  })

  it('starts 180 ms shakes at 80% activation and preserves the yaw/roll limits', () => {
    const trance = createTypingTrance(() => 0)
    burst(trance, 0, 2150)
    trance.press(2177)
    assert.ok(trance.update(2177).amount < 0.8)
    assert.equal(trance.update(2177).yawDegrees, 0)
    trance.press(2178)
    assert.ok(trance.update(2178).amount >= 0.8)
    assert.ok(Math.abs(trance.update(2268).yawDegrees) > 0)
    burst(trance, 2300, 2500)
    trance.press(2680) // Earlier pulses have expired; the 200 ms quiet limit has not.
    assert.equal(Math.abs(trance.update(2770).yawDegrees), 1.6)
    assert.equal(Math.abs(trance.update(2770).rollDegrees), 1.2)
    assert.equal(trance.update(2860).yawDegrees, 0)
    assert.equal(trance.update(2860).rollDegrees, 0)
  })

  it('restarts the 1.2-second qualification after a 200 ms interruption', () => {
    let decisions = 0
    const trance = createTypingTrance(() => {
      decisions++
      return 0
    })
    burst(trance, 0, 1200)
    assert.equal(decisions, 0)
    trance.update(1400)
    burst(trance, 1450, 2600)
    assert.equal(decisions, 0)
    burst(trance, 2650, 2800)
    assert.equal(decisions, 1)
  })

  it('holds until quiet and smoothly returns, including sparse continued input', () => {
    const trance = createTypingTrance(() => 0)
    burst(trance)
    assert.equal(trance.update(3399).amount, 1)
    assert.equal(trance.update(3400).amount, 1)
    const halfway = trance.update(3600).amount
    assert.equal(halfway, 0.5)
    assert.equal(trance.update(3800).amount, 0)
    burst(trance, 5000, 8500)
    for (let now = 8500; now <= 11000; now += 20) {
      if (now > 8500 && (now - 8500) % 500 === 0) trance.press(now)
      trance.update(now)
    }
    assert.equal(trance.update(11000).amount, 0)
  })

  it('retains the exclusive quiet window for exactly 2 Hz in either event order', () => {
    for (const frameFirst of [false, true]) {
      const trance = createTypingTrance(() => 0)
      burst(trance)
      assert.equal(trance.update(3200).amount, 1)
      for (let now = 3210; now <= 6000; now += 10) {
        if (frameFirst) trance.update(now)
        if ((now - 3200) % 500 === 0) trance.press(now)
        if (!frameFirst) trance.update(now)
      }
      assert.equal(trance.update(6000).amount, 0)
    }
  })

  it('preserves shake displacement and velocity through another press and both blend endpoints', () => {
    const trance = createTypingTrance(() => 0)
    burst(trance, 0, 3100)
    const epsilon = 0.001
    const before = trance.update(3200 - epsilon)
    const atPress = trance.update(3200)
    trance.press(3200)
    assert.deepEqual(trance.update(3200), atPress, 'a new press must retain the current face displacement')
    const after = trance.update(3200 + epsilon)
    for (const axis of ['yawDegrees', 'rollDegrees'] as const) {
      const incomingVelocity = (atPress[axis] - before[axis]) / epsilon
      const outgoingVelocity = (after[axis] - atPress[axis]) / epsilon
      assert.ok(Math.abs(incomingVelocity - outgoingVelocity) < 0.00001, `${axis}: velocity changed on press`)
    }
    // The old pulse expires at 3280; the new pulse finishes at 3380.
    for (const boundary of [3280, 3380]) {
      const left = trance.update(boundary - epsilon)
      const center = trance.update(boundary)
      const right = trance.update(boundary + epsilon)
      for (const axis of ['yawDegrees', 'rollDegrees'] as const) {
        assert.ok(Math.abs(center[axis] - left[axis]) < 0.001)
        assert.ok(Math.abs(right[axis] - center[axis]) < 0.001)
        assert.ok(Math.abs((center[axis] - left[axis]) / epsilon - (right[axis] - center[axis]) / epsilon) < 0.00001)
      }
    }
    assert.equal(trance.update(3381).yawDegrees, 0)
    assert.equal(trance.update(3381).rollDegrees, 0)
  })

  it('bounds overlapping shakes and drops expired pulse work during prolonged rapid typing', () => {
    const originalSin = Math.sin
    let evaluated = 0
    Math.sin = (value) => {
      evaluated++
      return originalSin(value)
    }
    try {
      for (const interval of [10, 25, 50, 90, 100, 150, 180, 250]) {
        const trance = createTypingTrance(() => 0)
        burst(trance, 0, 3100)
        const duration = interval === 10 ? 60_000 : 3000
        for (let elapsed = 1; elapsed <= duration; elapsed++) {
          const now = 3100 + elapsed
          if (elapsed % interval === 0) trance.press(now)
          evaluated = 0
          const pose = trance.update(now)
          assert.ok(Math.abs(pose.yawDegrees) <= 1.6)
          assert.ok(Math.abs(pose.rollDegrees) <= 1.2)
          const activeInterval = elapsed < 180 ? Math.min(50, interval) : interval
          assert.ok(evaluated <= Math.ceil(180 / activeInterval) + 1, 'expired pulses must not add work to later frames')
        }
        evaluated = 0
        const settled = trance.update(3100 + duration + 180)
        assert.equal(evaluated, 0)
        assert.equal(settled.yawDegrees, 0)
        assert.equal(settled.rollDegrees, 0)
      }
    } finally {
      Math.sin = originalSin
    }
  })

  it('uses elapsed time at different frame rates and clears lifecycle state', () => {
    const slow = createTypingTrance(() => 0)
    const fast = createTypingTrance(() => 0)
    burst(slow, 0, 3200, 1000 / 30)
    burst(fast, 0, 3200, 1000 / 60)
    assert.equal(slow.update(3200).amount, 1)
    assert.equal(fast.update(3200).amount, 1)
    slow.reset()
    assert.deepEqual(slow.update(3210), { amount: 0, yawDegrees: 0, rollDegrees: 0 })
  })
})
