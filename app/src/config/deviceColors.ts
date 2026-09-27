import { DEFAULT_PET_PRESET } from './defaultSettings'

export interface DeviceColorSettings {
  keyboardColor: string
  keyboardKeycapColor: string
  keyboardLegendColor: string
  keyboardPressedColor: string
  mouseColor: string
  mousePressedColor: string
}

export const DEVICE_COLOR_KEYS = [
  'keyboardColor',
  'keyboardKeycapColor',
  'keyboardLegendColor',
  'keyboardPressedColor',
  'mouseColor',
  'mousePressedColor',
] as const satisfies readonly (keyof DeviceColorSettings)[]

export const DEFAULT_DEVICE_COLORS: Readonly<DeviceColorSettings> = {
  keyboardColor: DEFAULT_PET_PRESET.keyboardColor,
  keyboardKeycapColor: DEFAULT_PET_PRESET.keyboardKeycapColor,
  keyboardLegendColor: DEFAULT_PET_PRESET.keyboardLegendColor,
  keyboardPressedColor: DEFAULT_PET_PRESET.keyboardPressedColor,
  // White is a neutral tint over the mouse's separate body and button shades.
  mouseColor: DEFAULT_PET_PRESET.mouseColor,
  mousePressedColor: DEFAULT_PET_PRESET.mousePressedColor,
}

export function normalizeDeviceColors(value: Partial<DeviceColorSettings> | undefined): DeviceColorSettings {
  const normalized = { ...DEFAULT_DEVICE_COLORS }
  for (const key of DEVICE_COLOR_KEYS) {
    const color = value?.[key]
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
      normalized[key] = color.toLowerCase()
    }
  }
  return normalized
}
