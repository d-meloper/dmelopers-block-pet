import type { SemanticInputEvent } from '@/features/input/types'

import { IDLE_DELAY_MS, IDLE_FPS } from '@/config/performance'

/** Gates animation and drawing together; input collection remains responsive. */
export class RenderCadence {
  private enabled = false
  private lastActivityAt = 0
  private lastFrameAt = 0
  private lastLimit = 0
  private typingActive = false
  private readonly mouseButtons = new Set<string>()
  private dragging = false
  private interactionHeld = false

  reset(timestamp: number): void {
    this.typingActive = false
    this.mouseButtons.clear()
    this.dragging = false
    this.interactionHeld = false
    this.lastActivityAt = timestamp
    this.lastFrameAt = 0
    this.lastLimit = 0
  }

  setEnabled(enabled: boolean, timestamp: number): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.noteActivity(timestamp)
  }

  noteActivity(timestamp: number): void {
    this.lastActivityAt = timestamp
  }

  handleInput(event: SemanticInputEvent, timestamp: number): void {
    this.noteActivity(timestamp)
    if (event.kind === 'typing') this.typingActive = event.active
    if (event.kind === 'drag') this.dragging = event.active
    if (event.kind === 'mouse_primary' || event.kind === 'mouse_secondary' || event.kind === 'mouse_middle') {
      if (event.active) this.mouseButtons.add(event.kind)
      else this.mouseButtons.delete(event.kind)
    }
  }

  setInteractionHeld(held: boolean, timestamp: number): void {
    if (this.interactionHeld === held) return
    this.interactionHeld = held
    this.noteActivity(timestamp)
  }

  resetMouseInput(timestamp: number): void {
    this.mouseButtons.clear()
    this.dragging = false
    this.noteActivity(timestamp)
  }

  getFrameLimit(timestamp: number, maxFPS: number): number {
    const idle = this.enabled
      && !this.typingActive
      && this.mouseButtons.size === 0
      && !this.dragging
      && !this.interactionHeld
      && timestamp - this.lastActivityAt >= IDLE_DELAY_MS
    return idle ? Math.min(maxFPS, IDLE_FPS) : maxFPS
  }

  shouldRender(timestamp: number, maxFPS: number): boolean {
    const limit = this.getFrameLimit(timestamp, maxFPS)
    // A new rate starts on this RAF, including the first frame after input.
    if (limit !== this.lastLimit) {
      this.lastLimit = limit
      this.lastFrameAt = timestamp
      return true
    }
    const interval = 1000 / limit
    const elapsed = timestamp - this.lastFrameAt
    if (elapsed + 1e-6 < interval) return false
    this.lastFrameAt += Math.max(1, Math.floor((elapsed + 1e-6) / interval)) * interval
    return true
  }
}
