import type { Monitor, PhysicalPosition } from '@tauri-apps/api/window'

import { cursorPosition, monitorFromPoint } from '@tauri-apps/api/window'

const CURSOR_MONITOR_CACHE_TTL_MS = 1000

function createCursorMonitor() {
  let cachedMonitor: Monitor | null = null
  let cachedAt = 0

  return async (cursorPoint?: PhysicalPosition) => {
    cursorPoint ??= await cursorPosition()

    if (
      cachedMonitor
      && Date.now() - cachedAt <= CURSOR_MONITOR_CACHE_TTL_MS
    ) {
      const { size, position } = cachedMonitor

      const inBounds = cursorPoint.x >= position.x
        && cursorPoint.x < position.x + size.width
        && cursorPoint.y >= position.y
        && cursorPoint.y < position.y + size.height

      if (inBounds) {
        return cachedMonitor
      }
    }

    cachedMonitor = await monitorFromPoint(cursorPoint.x, cursorPoint.y)
    cachedAt = Date.now()

    return cachedMonitor
  }
}

export const getCursorMonitor = createCursorMonitor()
