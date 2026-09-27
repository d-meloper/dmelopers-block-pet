export interface Hsv { h: number, s: number, v: number }

export function normalizeHex(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : undefined
}

export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
}

export function rgbToHex(rgb: readonly number[]): string {
  return `#${rgb.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

export function hexToHsv(hex: string, previousHue = 0): Hsv {
  const [r, g, b] = hexToRgb(hex).map(value => value / 255)
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  const sector = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { h: delta === 0 ? previousHue : (sector * 60 + 360) % 360, s: max === 0 ? 0 : delta / max * 100, v: max * 100 }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const saturation = Math.max(0, Math.min(100, s)) / 100
  const value = Math.max(0, Math.min(100, v)) / 100
  const hue = ((h % 360) + 360) % 360 / 60
  const chroma = value * saturation
  const second = chroma * (1 - Math.abs(hue % 2 - 1))
  const sectors = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second], [0, second, chroma], [second, 0, chroma], [chroma, 0, second]]
  return rgbToHex(sectors[Math.floor(hue)].map(channel => (channel + value - chroma) * 255))
}

export function pointToSv(x: number, y: number, width: number, height: number): Pick<Hsv, 's' | 'v'> {
  return { s: Math.max(0, Math.min(100, x / Math.max(1, width) * 100)), v: 100 - Math.max(0, Math.min(100, y / Math.max(1, height) * 100)) }
}
