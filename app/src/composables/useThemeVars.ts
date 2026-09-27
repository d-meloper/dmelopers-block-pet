import { theme } from 'ant-design-vue'
import { kebabCase } from 'es-toolkit'

import {
  APP_PRIMARY_PALETTES,
  APP_THEME_PRIMARY,
  appDarkAlgorithm,
  appLightAlgorithm,
} from '@/config/theme'

export function useThemeVars() {
  const { defaultConfig } = theme

  const generateColorVars = () => {
    const themes = [
      {
        isDark: false,
        primaryPalette: APP_PRIMARY_PALETTES.light,
        token: appLightAlgorithm(defaultConfig.token),
      },
      {
        isDark: true,
        primaryPalette: APP_PRIMARY_PALETTES.dark,
        token: appDarkAlgorithm(defaultConfig.token),
      },
    ]

    for (const { isDark, primaryPalette, token } of themes) {
      const vars: Record<string, any> = {}

      for (const [key, value] of Object.entries(token)) {
        vars[`--ant-${kebabCase(key)}`] = value
      }

      vars['--app-primary'] = APP_THEME_PRIMARY
      primaryPalette.forEach((value, index) => {
        vars[`--app-primary-${index + 1}`] = value
      })

      const style = document.createElement('style')
      style.dataset.theme = isDark ? 'dark' : 'light'
      const selector = isDark ? 'html.dark' : ':root'
      const values = Object.entries(vars).map(([key, value]) => `${key}: ${value};`)

      style.innerHTML = `${selector}{\n${values.join('\n')}\n}`
      document.head.appendChild(style)
    }
  }

  return {
    generateColorVars,
  }
}
