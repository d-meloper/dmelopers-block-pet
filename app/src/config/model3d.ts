import { DEFAULT_PET_PRESET, DEFAULT_SKIN_APPEARANCE } from './defaultSettings'

export const PET_MODEL_OPTIONS = [
  {
    id: 'dmeloper',
    label: 'dmeloper',
    resourcePath: 'assets/models/dmeloper/dmeloper.glb',
  },
] as const

export type PetModelId = typeof PET_MODEL_OPTIONS[number]['id']

export const DEFAULT_PET_MODEL_ID: PetModelId = DEFAULT_SKIN_APPEARANCE.selectedModelId

export function getPetModelOption(id: PetModelId) {
  return PET_MODEL_OPTIONS.find(option => option.id === id)
    ?? PET_MODEL_OPTIONS.find(option => option.id === DEFAULT_PET_MODEL_ID)!
}

export const MODEL_3D_CONFIG = {
  baseWindow: {
    width: 500,
    height: 422,
  },
  renderer: {
    contentBoundsDebounceMs: 100,
    contentBoundsPaddingPixels: 16,
    maxPixelRatio: 2,
  },
  objectVerticalGap: 0.16,
  camera: {
    fov: 28,
    near: 0.01,
    far: 100,
    fitMargin: 1.08,
    elevationDegrees: 32,
    distancePercent: 60,
    pan: [0, 0],
  },
  pet: {
    useProceduralPrototype: false,
    normalizedHeight: 2.45,
    rotationYDegrees: 0,
    position: [-0.32, -1.55, -0.48],
    animation: {
      inputMode: {
        mouseIdleMs: 1500,
        dualSideWindowMs: 300,
        transitionMs: 220,
        keyboardSplitX: 0,
        leftIdleKey: 'KeyF',
        rightIdleKey: 'PageUp',
      },
      pose: {
        upperBodyLift: 0.045,
        shoulderDown: 0.04,
        shoulderInward: 0.012,
        shoulderBackward: 0.054,
        armSpacingScale: 1.3,
        armBendAmount: 0.2,
      },
      keyboard: {
        damping: 12,
        typingIdleDelayMs: 420,
        returnDurationMs: 320,
        returnLiftHeight: 0.24,
        restHoverHeight: 0.12,
        contactOffset: 0.018,
        elbowPole: [1, 0.05, -0.25],
        rightElbowPole: [-1, 0.05, -0.25],
        bodyTurnStrength: 0.7,
        bodyMaxTurnDegrees: 20,
        bodyTurnDamping: 6.5,
        bodyDefaultTurnScale: 0.3,
        bodyRightTurnScale: 1.6,
        farLeanStartZ: 0.15,
        farLeanEndZ: -0.41,
        farLeanDegrees: 10,
        strikeArcMs: 240,
        strikeContactMs: 70,
        strikeImpactDamping: 28,
        strikeLiftHeight: 1.4,
      },
      mouse: {
        damping: 9,
        elbowPole: [-1, 0.05, -0.25],
        clickStrikeMs: 220,
        clickLiftHeight: 0.16,
        clickButtonOffset: 0.08,
        clickDamping: 20,
      },
      head: {
        damping: 5,
        basePitchDegrees: -5.25,
        yawDegrees: 16,
        pitchDegrees: 11.2,
      },
      breathing: {
        periodMs: 2800,
        spineDegrees: 1.2,
        headDegrees: 0.6,
      },
    },
  },
  keyboard: {
    scale: 0.5,
    position: [0.09, 0.012, 0.447],
    rotationYDegrees: 173,
    interaction: {
      pressTravel: 0.028,
      pressedColor: Number.parseInt(DEFAULT_PET_PRESET.keyboardPressedColor.slice(1), 16),
      minimumPressMs: 90,
      pressDurationMs: 70,
      releaseDurationMs: 140,
    },
    palette: {
      housing: Number.parseInt(DEFAULT_PET_PRESET.keyboardColor.slice(1), 16),
      keycap: Number.parseInt(DEFAULT_PET_PRESET.keyboardKeycapColor.slice(1), 16),
      legend: DEFAULT_PET_PRESET.keyboardLegendColor,
    },
  },
  mouse: {
    scale: 0.5,
    position: [-1.0488, 0.008, 0.438],
    rotationYDegrees: 5,
    handAnchorPosition: [0, 0.32, 0.02],
    interaction: {
      xRange: 0.192,
      zRange: 0.096,
      curveDepth: 0.027,
      followDamping: 10.5,
      buttonTravel: 0.022,
      pressedColor: Number.parseInt(DEFAULT_PET_PRESET.mousePressedColor.slice(1), 16),
      minimumPressMs: 90,
      pressDurationMs: 70,
      releaseDurationMs: 140,
    },
    palette: {
      body: 0xE9ECEF,
      button: 0xF8FAFC,
      trim: 0x6F7780,
      wheel: 0x444B53,
    },
  },
  desk: {
    size: [5.2, 0.08, 2.4],
    position: [0, -0.04, 1.25],
  },
  scene: {
    rotationDegrees: -15,
  },
} as const
