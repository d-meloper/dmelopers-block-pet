import { theme } from 'ant-design-vue'

const { darkAlgorithm, defaultAlgorithm } = theme

export const APP_THEME_PRIMARY = '#3AA76D'

export const APP_PRIMARY_PALETTES = {
  light: [
    '#E3F6E9',
    '#D0EEDB',
    '#A6D9B8',
    '#78C894',
    '#4FBA7E',
    APP_THEME_PRIMARY,
    '#2C8757',
    '#1F653F',
    '#13452B',
    '#092619',
  ],
  dark: [
    '#112218',
    '#163222',
    '#1D432D',
    '#23583B',
    '#2B754D',
    APP_THEME_PRIMARY,
    '#54A476',
    '#7AB792',
    '#A4C7B1',
    '#C8D5CC',
  ],
} as const

export function appLightAlgorithm(seedToken: Parameters<typeof defaultAlgorithm>[0]) {
  const token = defaultAlgorithm({
    ...seedToken,
    colorPrimary: APP_THEME_PRIMARY,
  })

  return {
    ...token,
    colorPrimary: APP_THEME_PRIMARY,
    colorPrimaryBg: APP_PRIMARY_PALETTES.light[0],
    colorPrimaryBgHover: APP_PRIMARY_PALETTES.light[1],
    colorPrimaryBorder: APP_PRIMARY_PALETTES.light[2],
    colorPrimaryBorderHover: APP_PRIMARY_PALETTES.light[3],
    colorPrimaryHover: APP_PRIMARY_PALETTES.light[4],
    colorPrimaryActive: APP_PRIMARY_PALETTES.light[6],
    colorPrimaryText: APP_THEME_PRIMARY,
    colorPrimaryTextHover: APP_PRIMARY_PALETTES.light[4],
    colorPrimaryTextActive: APP_PRIMARY_PALETTES.light[6],
    // Owner-supplied Twinkle Tray light neutrals; activation stays green.
    colorBgLayout: '#F1F3F9',
    colorBgContainer: '#F9FAFD',
    colorBgElevated: '#F9FAFD',
    colorBorder: '#E5E6E9',
    colorBorderSecondary: '#E5E6E9',
    colorText: '#000000',
    colorTextSecondary: '#3E3F3F',
    colorTextTertiary: '#575B64',
    colorTextQuaternary: '#757984',
    colorFill: '#D0D2D7',
    colorFillSecondary: '#E5E6E9',
    colorFillTertiary: '#E9EBF1',
    colorFillQuaternary: '#F9FAFD',
  }
}

export function appDarkAlgorithm(
  seedToken: Parameters<typeof darkAlgorithm>[0],
  mapToken?: Parameters<typeof darkAlgorithm>[1],
) {
  const token = darkAlgorithm({
    ...seedToken,
    colorBgBase: '#141414',
    colorPrimary: APP_THEME_PRIMARY,
  }, mapToken)

  return {
    ...token,
    colorPrimary: APP_THEME_PRIMARY,
    colorPrimaryBg: APP_PRIMARY_PALETTES.dark[1],
    colorPrimaryBgHover: APP_PRIMARY_PALETTES.dark[2],
    colorPrimaryBorder: APP_PRIMARY_PALETTES.dark[3],
    colorPrimaryBorderHover: APP_PRIMARY_PALETTES.dark[4],
    colorPrimaryHover: APP_PRIMARY_PALETTES.dark[6],
    colorPrimaryActive: APP_PRIMARY_PALETTES.dark[4],
    colorPrimaryText: APP_THEME_PRIMARY,
    colorPrimaryTextHover: APP_PRIMARY_PALETTES.dark[6],
    colorPrimaryTextActive: APP_PRIMARY_PALETTES.dark[4],
    // Owner-supplied Twinkle Tray dark surfaces; sidebar shares the layout.
    colorBgLayout: '#202020',
    colorBgContainer: '#292929',
    colorBgElevated: '#292929',
    colorBgSpotlight: '#2C2C2C',
    colorBorder: '#3B3B3B',
    colorBorderSecondary: '#303030',
    colorFill: 'rgba(255, 255, 255, 0.18)',
    colorFillSecondary: 'rgba(255, 255, 255, 0.12)',
    colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
    colorFillQuaternary: 'rgba(255, 255, 255, 0.04)',
  }
}
