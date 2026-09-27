import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

export const screenColorPicking = ref(false)

export interface ScreenColorAppearance {
  background: number
  border: number
  muted: number
}

interface ScreenColorTokens {
  colorBgElevated: string
  colorBorder: string
  colorTextSecondary: string
}

function parseTokenColor(value: string): number[] | undefined {
  if (typeof value !== 'string') return
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim())?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(channel => channel.repeat(2)).join('') : hex
    return [0, 2, 4].map(index => Number.parseInt(full.slice(index, index + 2), 16)).concat(1)
  }
  const match = /^(rgb|rgba)\(([^)]+)\)$/i.exec(value.trim())
  if (!match) return
  const parts = match[2].split(',').map(part => part.trim())
  if (parts.length !== (match[1].toLowerCase() === 'rgba' ? 4 : 3)
    || parts.some(part => !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(part))) {
    return
  }
  const channels = parts.map(Number)
  if (channels.some((channel, index) => !Number.isFinite(channel) || channel > (index === 3 ? 1 : 255))) return
  return channels.length === 3 ? [...channels, 1] : channels
}

/** Convert current app tokens to opaque Win32 COLORREF values (0xBBGGRR). */
export function createScreenColorAppearance(tokens: ScreenColorTokens): ScreenColorAppearance | undefined {
  const background = parseTokenColor(tokens.colorBgElevated)
  if (!background || background[3] !== 1) return
  const colors = [background, ...[tokens.colorBorder, tokens.colorTextSecondary].map(parseTokenColor)]
  if (colors.some(value => !value)) return
  const [bg, border, muted] = colors.map((value) => {
    const channels = value!.slice(0, 3).map((channel, index) => Math.round(channel * value![3] + background[index] * (1 - value![3])))
    return channels[0] | channels[1] << 8 | channels[2] << 16
  })
  return { background: bg, border, muted }
}

export function pickScreenColor(requestId: string, instruction: string, appearance?: ScreenColorAppearance): Promise<unknown> {
  return invoke('pick_screen_color', { requestId, instruction, ...(appearance ? { appearance } : {}) })
}

export function cancelScreenColorPick(requestId: string): Promise<void> {
  return invoke('cancel_screen_color_pick', { requestId })
}
