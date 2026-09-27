import type { SemanticInputEvent } from '@/features/input/types'

import { isSemanticInputEvent } from '@/features/input/types'

import type { BroadcastScene } from './types'

/** Rendering is transactional even if a newer scene arrives while a skin loads. */
export function createBroadcastSession(deps: {
  apply: (scene: BroadcastScene, isCurrent: () => boolean) => Promise<void>
  input: (event: SemanticInputEvent) => void
  reset: () => void
  clear: () => void
  ready: (revision: number) => void
  failed?: (revision: number) => void
}) {
  let generation = 0
  let revision = 0
  let rendered = false
  let pending: { revision: number, scene: BroadcastScene } | undefined
  let running: Promise<void> | undefined

  async function drain() {
    while (pending) {
      const next = pending
      pending = undefined
      const epoch = generation
      const isCurrent = () => epoch === generation && next.revision === revision
      try {
        await deps.apply(next.scene, isCurrent)
        if (!isCurrent()) continue
        rendered = true
        deps.ready(next.revision)
      } catch {
        // Keep a successfully rendered earlier scene on asset failure.
        if (isCurrent()) deps.failed?.(next.revision)
      }
    }
    running = undefined
  }

  return {
    receive(value: unknown) {
      if (!value || typeof value !== 'object') return
      const message = value as { type?: string, revision?: number, scene?: BroadcastScene, event?: unknown }
      if (message.type === 'reset') {
        deps.reset()
        return
      }
      if (message.type === 'input') {
        if (rendered && isSemanticInputEvent(message.event)) deps.input(message.event)
        return
      }
      if (message.type !== 'scene' || !Number.isSafeInteger(message.revision)
        || message.revision! <= revision || message.scene?.schemaVersion !== 1
        || message.scene.modelId !== 'dmeloper' || !message.scene.preset || !message.scene.performance) {
        return
      }
      revision = message.revision!
      pending = { revision, scene: message.scene }
      running ??= Promise.resolve().then(drain)
    },
    disconnect() {
      generation++
      revision = 0
      pending = undefined
      rendered = false
      deps.reset()
      deps.clear()
    },
    idle: () => running ?? Promise.resolve(),
  }
}
