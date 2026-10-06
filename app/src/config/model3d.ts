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
    normalizedHeight: 2.45,
    rotationYDegrees: 0,
    position: [-0.32, -1.55, -0.48],
    animation: {
      inputMode: {
        mouseIdleMs: 1500,
        dualSideWindowMs: 300,
        transitionMs: 220,
        keyboardSplitX: 0,
        rightHandStartKeys: ['Num7', 'KeyY', 'KeyH', 'KeyN'],
        leftIdleKey: 'KeyF',
        rightIdleKey: 'PageUp',
      },
      handTravel: {
        durationMs: 120,
        minArmLengthRatio: 0.35,
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
        navigationKeys: ['LeftArrow', 'DownArrow', 'RightArrow', 'UpArrow', 'PageUp', 'PageDown'],
        navigationTurnDegrees: 6.6,
        navigationBackLeanDegrees: 2.4,
        navigationDamping: 8,
        // Ten standard key pitches to KeyY: 2 degrees per key at the 20-degree maximum.
        rightHandLeftTurnStartX: 1.7565625,
        rightHandLeftTurnEndX: -0.1684375,
        rightHandLeftTurnDegrees: 20,
        farLeanStartZ: 0.15,
        farLeanEndZ: -0.41,
        farLeanDegrees: 10,
        farLeanHoldMs: 350,
        farLeanReturnMs: 650,
        strikeRiseMs: 50,
        strikeFallMs: 40,
        strikeChordWindowMs: 40,
        strikeContactMs: 30,
        strikeImpactDamping: 28,
        strikeLiftHeight: 1.2,
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
      typingTrance: {
        windowMs: 1000,
        fastPressCount: 12,
        qualificationMs: 1200,
        probability: 1,
        enterMs: 600,
        backPitchDegrees: 15,
        shakeStartAmount: 0.8,
        shakeYawDegrees: 1.6,
        shakeRollDegrees: 1.2,
        shakeMs: 180,
        quietPressCount: 3,
        quietMs: 200,
        returnMs: 400,
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
    negativeXOffsetScale: 0.5,
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
    minimumWidth: 1,
    heightOffsetScale: 0.4,
    size: [2.6, 0.08, 1.2],
    // Keep the pet-facing edge at Z=0.05; shift left by 8% of baseline width.
    position: [-0.208, -0.04, 0.65],
  },
  scene: {
    rotationDegrees: -15,
  },
} as const
