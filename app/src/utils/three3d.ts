import type {
  BufferGeometry,
  DirectionalLight,
  Material,
  Object3D,
  Skeleton,
} from 'three'

import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  LoaderUtils,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  SkinnedMesh,
  Sphere,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import type { DeskSettings } from '@/config/desk'
import type { DeviceColorSettings } from '@/config/deviceColors'
import type { DmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import type { LightingSettings } from '@/config/lighting'
import type { PetModelId } from '@/config/model3d'
import type { ShadowQuality } from '@/config/performance'
import type { PetArmPoseSettings } from '@/config/petArmPose'
import type { KeyboardContact, SemanticInputEvent } from '@/features/input/types'

import { DEFAULT_DESK_SETTINGS, normalizeDeskSettings } from '@/config/desk'
import { DEFAULT_DEVICE_COLORS, DEVICE_COLOR_KEYS, normalizeDeviceColors } from '@/config/deviceColors'
import { createDefaultDmeloperEyebrowPreset } from '@/config/dmeloperEyebrows'
import { DMELOPER_PALM_FALLBACK_COLOR } from '@/config/dmeloperPalms'
import { createDefaultLightingSettings, normalizeLightingSettings } from '@/config/lighting'
import { MODEL_3D_CONFIG } from '@/config/model3d'
import { DEFAULT_PERFORMANCE_SETTINGS, MAX_FPS, MIN_FPS, normalizeShadowQuality } from '@/config/performance'
import { DEFAULT_PET_ARM_POSE_SETTINGS, normalizePetArmPoseSettings } from '@/config/petArmPose'
import { getScaledAutoViewportPadding, normalizeAutoViewportPadding } from '@/features/scene/viewportSettings'

import type {
  VisibleContentMeasurementFailureReason,
  VisibleContentMeasurementResult,
  VisibleContentRect,
} from './three3d/contentBounds'
import type { DmeloperEyebrowController } from './three3d/dmeloperEyebrows'
import type {
  KeyboardGroupResult,
  KeyboardLegendLanguage,
} from './three3d/keyboard'
import type { MouseGroupResult } from './three3d/mouse'
import type { PetAnimator } from './three3d/pet'
import type {
  AppliedVoxelSkin,
  NormalizedVoxelSkin,
  VoxelSkinGeometryController,
  VoxelSkinModel,
  VoxelSkinModelController,
  VoxelSkinModelPreference,
} from './three3d/voxelSkin'

import {
  createFullContentRect,
  normalizeRealizedViewRect,
  normalizeVisibleContentRect,
  scanAlphaContentMeasurement,
} from './three3d/contentBounds'
import { createDmeloperEyebrowController } from './three3d/dmeloperEyebrows'
import { createKeyboardGroup } from './three3d/keyboard'
import { forEachMeshWorldBounds } from './three3d/meshBounds'
import { createMouseGroup } from './three3d/mouse'
import { createPetAnimator } from './three3d/pet'
import { padContentRect, projectVisibleSceneBounds, unionContentRects } from './three3d/projectedBounds'
import { RenderCadence } from './three3d/renderCadence'
import {
  awaitAssetOperation,
  createPetLoadCancelledError,
  disposeRendererForReuse,
  disposeReplacedRenderer,
  restoreRendererCanvas,
} from './three3d/rendererLifecycle'
import { renderPetHealthFrame } from './three3d/renderHealth'
import {
  applyVisibleContentViewOffset,
  normalizeOutputDimension,
  selectAdaptiveShadowMapSize,
} from './three3d/renderSizing'
import { applyLightingOutput, SceneLighting } from './three3d/sceneLighting'
import { installSoftShadows } from './three3d/softShadows'
import {
  applyVoxelSkin,
  createVoxelSkinGeometryController,
  createVoxelSkinModelController,
  decodeVoxelSkin,
  resolveVoxelSkinModelPreference,
} from './three3d/voxelSkin'

export type {
  VisibleContentMeasurementFailureReason,
  VisibleContentMeasurementResult,
  VisibleContentRect,
} from './three3d/contentBounds'

export interface LoadedPetAssetState {
  modelId: PetModelId
  dmeloperSkinModel?: VoxelSkinModelPreference
  dmeloperSkinUrl?: string
}

export interface RendererStartupOptions {
  automaticFrames?: boolean
  antialiasEnabled?: boolean
  onRuntimeFailure?: (error: unknown) => void
  onFrameRendered?: () => void
}

export class Three3DRenderer {
  private renderer?: WebGLRenderer
  private readonly rendererDiagnosticCleanups = new WeakMap<WebGLRenderer, () => void>()
  private scene?: Scene
  private sceneRoot?: Group
  private petPresentationVisible = true
  private camera?: PerspectiveCamera
  private directionalLight?: DirectionalLight
  private lighting?: SceneLighting
  private lightingSettings = createDefaultLightingSettings()
  private lightingBoundsDirty = true
  private keyboard?: KeyboardGroupResult
  private mouse?: MouseGroupResult
  private petAnimator?: PetAnimator
  private dmeloperEyebrowController?: DmeloperEyebrowController
  private petModel?: Object3D
  private appliedVoxelSkin?: AppliedVoxelSkin
  private appliedVoxelSkinUrl?: string
  private voxelSkinModelController?: VoxelSkinModelController
  private voxelSkinGeometryController?: VoxelSkinGeometryController
  private cachedVoxelSkin?: { url: string, skin: NormalizedVoxelSkin }
  private loadedPetAssetState?: LoadedPetAssetState
  private pendingPetAssetState?: LoadedPetAssetState
  private runtimeFailure?: (error: unknown) => void
  private firstFrameRendered?: () => void
  private runtimeFaulted = false
  private frameId?: number
  private stillFrameOnly = false
  private stillFrameInputReceived = false
  private initializationGeneration = 0
  private initializationAbort?: AbortController
  private assetLoadAbort?: AbortController
  private modelLoadGeneration = 0
  private readonly renderCadence = new RenderCadence()
  private lastAnimationAt = 0
  private maxFPS: number = DEFAULT_PERFORMANCE_SETTINGS.maxFPS
  private shadowsEnabled: boolean = DEFAULT_PERFORMANCE_SETTINGS.shadowsEnabled
  private renderScalePercent: number = DEFAULT_PERFORMANCE_SETTINGS.renderScalePercent
  private pixelFilterEnabled = false
  private antialiasRequested = true
  private antialiasGeneration = 0
  private readonly highShadows = { value: DEFAULT_PERFORMANCE_SETTINGS.shadowQuality === 'high' }
  private shadowQuality: ShadowQuality = DEFAULT_PERFORMANCE_SETTINGS.shadowQuality
  private readonly compositionWidth: number = MODEL_3D_CONFIG.baseWindow.width
  private readonly compositionHeight: number = MODEL_3D_CONFIG.baseWindow.height
  private outputWidth: number = MODEL_3D_CONFIG.baseWindow.width
  private outputHeight: number = MODEL_3D_CONFIG.baseWindow.height
  private visibleContentRect: VisibleContentRect = createFullContentRect(
    MODEL_3D_CONFIG.baseWindow.width,
    MODEL_3D_CONFIG.baseWindow.height,
  )

  private realizedViewRect: VisibleContentRect = createFullContentRect(
    MODEL_3D_CONFIG.baseWindow.width,
    MODEL_3D_CONFIG.baseWindow.height,
  )

  private contentMeasurementGeneration = 0
  private contentMeasurementTail: Promise<void> = Promise.resolve()
  private readonly contentMeasurementTargets = new Set<WebGLRenderTarget>()
  private readonly contentReadbacks = new Set<Promise<unknown>>()
  private rotationDegrees: number = MODEL_3D_CONFIG.scene.rotationDegrees
  private cameraElevationDegrees: number = MODEL_3D_CONFIG.camera.elevationDegrees
  private cameraDistancePercent: number = MODEL_3D_CONFIG.camera.distancePercent
  private autoViewportPaddingPixels: number = MODEL_3D_CONFIG.renderer.contentBoundsPaddingPixels
  private fittedCameraTarget = new Vector3()
  private fittedCameraDistance = 1
  private fittedCameraModelId?: PetModelId
  private cameraPanX: number = MODEL_3D_CONFIG.camera.pan[0]
  private cameraPanY: number = MODEL_3D_CONFIG.camera.pan[1]
  private petRotationYDegrees = 0
  private petHeadScalePercent = 100
  private petDeskOffset = 0
  private deskSettings: DeskSettings = { ...DEFAULT_DESK_SETTINGS }
  private desk?: Mesh<BoxGeometry, MeshStandardMaterial>
  private petArmPoseSettings = { ...DEFAULT_PET_ARM_POSE_SETTINGS }
  private mouseBaseXOffset = 0
  private mouseBaseZOffset = 0
  private mouseScalePercent = 100
  private eyebrowAnimationEnabled = true
  private mouseEnabled = true
  private mouseInputActive = true
  private inputActive = true
  private readonly heldKeyboardContacts = new Map<string, KeyboardContact>()
  private keyboardBaseXOffset = 0
  private keyboardBaseZOffset = 0
  private keyboardScalePercent = 100
  private keyboardLegendLanguage: KeyboardLegendLanguage = 'ko'
  private deviceColors = { ...DEFAULT_DEVICE_COLORS }
  private dmeloperEyebrowPreset = createDefaultDmeloperEyebrowPreset()
  private dmeloperPalmColor = DMELOPER_PALM_FALLBACK_COLOR
  private readonly generatedGroupDisposers: Array<() => void> = []

  async init(
    canvas: HTMLCanvasElement,
    petUrl: string,
    modelId: PetModelId,
    skinUrl?: string,
    skinModel: VoxelSkinModelPreference = 'wide',
    startupOptions: RendererStartupOptions = {},
  ): Promise<VoxelSkinModel | undefined> {
    this.destroy()
    this.stillFrameOnly = startupOptions.automaticFrames === false
    const initializationGeneration = this.initializationGeneration
    const initializationAbort = new AbortController()
    this.initializationAbort = initializationAbort
    this.runtimeFailure = startupOptions.onRuntimeFailure
    this.firstFrameRendered = startupOptions.onFrameRendered
    this.runtimeFaulted = false

    try {
      await restoreRendererCanvas(canvas, initializationAbort.signal)
      if (initializationGeneration !== this.initializationGeneration) {
        throw createPetLoadCancelledError()
      }
      const { camera: cameraConfig } = MODEL_3D_CONFIG
      const renderer = this.createRenderer(canvas, startupOptions.antialiasEnabled ?? DEFAULT_PERFORMANCE_SETTINGS.antialiasEnabled)
      this.renderer = renderer
      this.antialiasRequested = startupOptions.antialiasEnabled ?? DEFAULT_PERFORMANCE_SETTINGS.antialiasEnabled
      renderer.outputColorSpace = SRGBColorSpace
      applyLightingOutput(renderer)
      renderer.setClearColor(0x000000, 0)
      this.applyPixelRatio()
      renderer.shadowMap.enabled = this.shadowsEnabled
      renderer.shadowMap.type = PCFShadowMap

      const scene = new Scene()
      const camera = new PerspectiveCamera(
        cameraConfig.fov,
        this.compositionWidth / this.compositionHeight,
        cameraConfig.near,
        cameraConfig.far,
      )
      const sceneRoot = new Group()
      sceneRoot.name = 'sceneRoot'

      this.scene = scene
      this.sceneRoot = sceneRoot
      this.camera = camera
      this.renderCadence.reset(performance.now())
      this.lastAnimationAt = 0

      this.buildScene(scene, sceneRoot)
      this.setSceneRotation(this.rotationDegrees)
      this.resizeOutput(this.outputWidth, this.outputHeight)
      if (startupOptions.automaticFrames !== false) this.frameId = requestAnimationFrame(this.renderFrame)
      const resolvedSkinModel = await this.setPetModel(petUrl, modelId, skinUrl, skinModel)
      if (initializationGeneration !== this.initializationGeneration) {
        throw createPetLoadCancelledError()
      }
      return resolvedSkinModel
    } catch (error) {
      if (initializationGeneration === this.initializationGeneration) {
        this.destroy()
      }
      throw error
    }
  }

  async setPetModel(
    petUrl: string,
    modelId: PetModelId,
    skinUrl?: string,
    skinModel: VoxelSkinModelPreference = 'wide',
  ): Promise<VoxelSkinModel | undefined> {
    if (!this.sceneRoot) return
    this.cancelPendingPetAssetLoad()
    const generation = this.modelLoadGeneration
    const abort = new AbortController()
    this.assetLoadAbort = abort
    const pendingAssetState: LoadedPetAssetState = {
      modelId,
      dmeloperSkinModel: skinModel,
      dmeloperSkinUrl: skinUrl,
    }
    this.pendingPetAssetState = pendingAssetState

    try {
      const resolvedSkinModel = await this.loadPet(
        petUrl,
        skinUrl,
        skinModel,
        generation,
        abort.signal,
      )
      this.assertCurrentModelLoad(generation)
      // Reinitialization retains device transforms. Refitting those transforms
      // would change the saved manual composition compared with a cold start.
      if (this.fittedCameraModelId !== modelId) {
        if (this.fitCamera()) this.fittedCameraModelId = modelId
      } else {
        this.positionCamera()
      }
      this.loadedPetAssetState = {
        modelId,
        dmeloperSkinModel: resolvedSkinModel ?? (skinModel === 'slim' ? 'slim' : 'wide'),
        dmeloperSkinUrl: skinUrl,
      }
      this.noteActivity()
      return resolvedSkinModel
    } catch (error) {
      this.assertCurrentModelLoad(generation)
      if (error instanceof Error && error.name === 'PetModelLoadCancelledError') {
        throw error
      }
      console.error('Failed to load the fixed 3D pet model.', { modelId, error })
      const loadError = new Error('The fixed 3D pet model could not be loaded.')
      loadError.name = 'PetAssetLoadError'
      throw loadError
    } finally {
      if (this.assetLoadAbort === abort) this.assetLoadAbort = undefined
      if (this.pendingPetAssetState === pendingAssetState) {
        this.pendingPetAssetState = undefined
      }
    }
  }

  async setDmeloperSkin(
    skinUrl?: string,
    skinModel: VoxelSkinModelPreference = 'wide',
  ): Promise<VoxelSkinModel> {
    this.invalidateContentMeasurement()
    const model = this.petModel
    if (!model) return skinModel === 'slim' ? 'slim' : 'wide'
    this.cancelPendingPetAssetLoad()
    const generation = this.modelLoadGeneration
    const abort = new AbortController()
    this.assetLoadAbort = abort
    const pendingAssetState: LoadedPetAssetState = {
      modelId: 'dmeloper',
      dmeloperSkinModel: skinModel,
      dmeloperSkinUrl: skinUrl,
    }
    this.pendingPetAssetState = pendingAssetState
    try {
      let skin = skinUrl && this.cachedVoxelSkin?.url === skinUrl
        ? this.cachedVoxelSkin.skin
        : undefined
      if (skinUrl && !skin) {
        skin = await this.loadSkin(skinUrl, abort.signal)
        this.assertCurrentModelLoad(generation)
        this.cachedVoxelSkin = { url: skinUrl, skin }
      }

      const resolvedModel = skin
        ? resolveVoxelSkinModelPreference(skin, skinModel)
        : skinModel === 'slim' ? 'slim' : 'wide'
      this.voxelSkinModelController ??= createVoxelSkinModelController(
        model,
        resolvedModel,
      )
      this.voxelSkinModelController.setModel(resolvedModel)

      if (!skinUrl || !skin) {
        if (this.appliedVoxelSkin || this.appliedVoxelSkinUrl) {
          this.appliedVoxelSkin?.dispose()
          this.appliedVoxelSkin = undefined
          this.appliedVoxelSkinUrl = undefined
          this.voxelSkinGeometryController?.setSkin(undefined)
        }
        installSoftShadows(model, this.highShadows)
        this.dmeloperEyebrowController?.setSuggestedColor()
        this.recordLoadedDmeloperSkin(model, skinUrl, resolvedModel)
        return resolvedModel
      }
      if (this.appliedVoxelSkinUrl !== skinUrl) {
        this.appliedVoxelSkin?.dispose()
        this.voxelSkinGeometryController?.setSkin(skin)
        this.appliedVoxelSkin = applyVoxelSkin(model, skin, {
          materialNames: ['Voxel External Skin', 'Voxel External Skin Overlay'],
        })
        installSoftShadows(model, this.highShadows)
        this.appliedVoxelSkin.setPixelFilterEnabled(this.pixelFilterEnabled)
        this.appliedVoxelSkinUrl = skinUrl
      }
      this.dmeloperEyebrowController?.setSuggestedColor(skin.suggestedEyebrowColor)
      this.recordLoadedDmeloperSkin(model, skinUrl, resolvedModel)
      return resolvedModel
    } catch (error) {
      this.assertCurrentModelLoad(generation)
      throw error
    } finally {
      if (this.assetLoadAbort === abort) this.assetLoadAbort = undefined
      if (this.pendingPetAssetState === pendingAssetState) {
        this.pendingPetAssetState = undefined
      }
    }
  }

  cancelPendingPetAssetLoad(): void {
    this.modelLoadGeneration += 1
    this.assetLoadAbort?.abort()
    this.assetLoadAbort = undefined
    this.pendingPetAssetState = undefined
    this.invalidateContentMeasurement()
  }

  getLoadedPetAssetState(): LoadedPetAssetState | undefined {
    return this.loadedPetAssetState
      ? { ...this.loadedPetAssetState }
      : undefined
  }

  getPendingPetAssetState(): LoadedPetAssetState | undefined {
    return this.pendingPetAssetState
      ? { ...this.pendingPetAssetState }
      : undefined
  }

  /** @deprecated Use resizeOutput so the fixed composition is explicit. */
  resize(width: number, height: number): void {
    this.resizeOutput(width, height)
  }

  resizeOutput(
    width: number,
    height: number,
  ): void {
    if (width !== this.outputWidth || height !== this.outputHeight) this.noteActivity()
    this.outputWidth = normalizeOutputDimension(width)
    this.outputHeight = normalizeOutputDimension(height)
    if (!this.renderer || !this.camera) return

    this.applyPixelRatio()
    // Keep the last rendered frame at its logical size while native resize
    // readback is pending; percentage CSS stretches it before the new crop.
    this.renderer.setSize(this.outputWidth, this.outputHeight)
    this.applyCameraViewOffset()
    this.updateShadowMapSize()
    // Changing the drawing buffer clears it. Draw the current pose in this
    // task instead of exposing an empty canvas until the FPS gate next opens.
    if (this.scene) {
      this.renderPresentationFrame()
    }
  }

  getCompositionSize(): { width: number, height: number } {
    return {
      width: this.compositionWidth,
      height: this.compositionHeight,
    }
  }

  getVisibleContentRect(): VisibleContentRect {
    return { ...this.visibleContentRect }
  }

  getRealizedViewRect(): VisibleContentRect {
    return { ...this.realizedViewRect }
  }

  setViewportCrop(
    sourceRect: VisibleContentRect,
    realizedViewRect: VisibleContentRect = sourceRect,
  ): VisibleContentRect {
    this.visibleContentRect = normalizeVisibleContentRect(
      sourceRect,
      this.compositionWidth,
      this.compositionHeight,
    )
    this.realizedViewRect = normalizeRealizedViewRect(
      realizedViewRect,
      this.visibleContentRect,
    )
    this.applyCameraViewOffset()
    return this.getVisibleContentRect()
  }

  setVisibleContentRect(rect: VisibleContentRect): VisibleContentRect {
    return this.setViewportCrop(rect)
  }

  setRealizedViewRect(rect: VisibleContentRect): VisibleContentRect {
    this.realizedViewRect = normalizeRealizedViewRect(
      rect,
      this.visibleContentRect,
    )
    this.applyCameraViewOffset()
    return this.getRealizedViewRect()
  }

  refitComposition(): void {
    this.invalidateContentMeasurement()
    this.fitCamera()
  }

  setAutoViewportPadding(pixels: number): void {
    const padding = normalizeAutoViewportPadding(pixels)
    if (padding === this.autoViewportPaddingPixels) return
    this.invalidateContentMeasurement()
    this.autoViewportPaddingPixels = padding
  }

  private getContentPadding(): number {
    return getScaledAutoViewportPadding(this.autoViewportPaddingPixels, MODEL_3D_CONFIG.camera.distancePercent * 100 / this.cameraDistancePercent)
  }

  getConservativeContentRect(): VisibleContentRect {
    const bounds = this.sceneRoot && this.camera
      ? projectVisibleSceneBounds(this.sceneRoot, this.camera, this.compositionWidth, this.compositionHeight)
      : undefined
    return padContentRect(unionContentRects(bounds ?? createFullContentRect(this.compositionWidth, this.compositionHeight), this.getMouseMotionContentRect()), this.getContentPadding())
  }

  private getMouseMotionContentRect(): VisibleContentRect | undefined {
    const group = this.mouse?.group
    const device = group?.getObjectByName('mouseDevice')
    if (!group?.visible || !device || !this.camera) return undefined
    group.updateWorldMatrix(true, true)
    const origin = group.getWorldPosition(new Vector3())
    const { xRange, zRange, curveDepth } = MODEL_3D_CONFIG.mouse.interaction
    const offsets: Vector3[] = []
    for (const x of [-xRange, xRange]) {
      for (const z of [-zRange - curveDepth, zRange]) {
        offsets.push(group.localToWorld(new Vector3(x - device.position.x, 0, z - device.position.z)).sub(origin))
      }
    }
    // Include the full cursor travel once per composition change. Input never
    // resizes the native window, even with extreme device placement/scale.
    return projectVisibleSceneBounds(device, this.camera, this.compositionWidth, this.compositionHeight, offsets)
  }

  setEyebrowAnimationEnabled(enabled: boolean): void {
    if (this.eyebrowAnimationEnabled !== enabled) this.noteActivity()
    this.eyebrowAnimationEnabled = enabled
    this.dmeloperEyebrowController?.setAnimationEnabled(enabled)
  }

  async measureVisibleContentRect(): Promise<VisibleContentMeasurementResult> {
    const measurementGeneration = ++this.contentMeasurementGeneration
    const modelLoadGeneration = this.modelLoadGeneration
    const operation = this.contentMeasurementTail.then(() => (
      this.measureVisibleContentRectNow(
        measurementGeneration,
        modelLoadGeneration,
      )
    ))
    this.contentMeasurementTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async measureVisibleContentRectNow(
    measurementGeneration: number,
    modelLoadGeneration: number,
  ): Promise<VisibleContentMeasurementResult> {
    if (
      measurementGeneration !== this.contentMeasurementGeneration
      || modelLoadGeneration !== this.modelLoadGeneration
    ) {
      return { status: 'stale' }
    }
    const renderer = this.renderer
    const scene = this.scene
    const camera = this.camera
    if (!renderer || !scene || !camera) {
      return { status: 'failure', reason: 'renderer-unavailable' }
    }
    if (this.getMeasurementFailureReason(renderer, 'renderer-unavailable') === 'context-lost') {
      return { status: 'failure', reason: 'context-lost' }
    }

    const measurementRect = this.getConservativeContentRect()
    const resolution = Math.min(1, 2048 / Math.max(measurementRect.width, measurementRect.height), (renderer.capabilities?.maxTextureSize ?? 2048) / Math.max(measurementRect.width, measurementRect.height))
    const measurementWidth = Math.max(1, Math.ceil(measurementRect.width * resolution))
    const measurementHeight = Math.max(1, Math.ceil(measurementRect.height * resolution))
    const renderTarget = new WebGLRenderTarget(
      measurementWidth,
      measurementHeight,
      {
        depthBuffer: true,
        format: RGBAFormat,
        stencilBuffer: false,
        type: UnsignedByteType,
      },
    )
    renderTarget.texture.generateMipmaps = false
    this.contentMeasurementTargets.add(renderTarget)

    const measurementCamera = this.createCompositionCamera(camera)
    applyVisibleContentViewOffset(measurementCamera, this.compositionWidth, this.compositionHeight, measurementRect)
    const previousRenderTarget = renderer.getRenderTarget()
    const previousClearColor = renderer.getClearColor(new Color())
    const previousClearAlpha = renderer.getClearAlpha()
    const previousAutoClear = renderer.autoClear
    const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate
    const previousShadowNeedsUpdate = renderer.shadowMap.needsUpdate
    const pixels = new Uint8Array(
      measurementWidth * measurementHeight * 4,
    )

    const deskMaterial = this.desk?.material
    const deskColorWrite = deskMaterial?.colorWrite
    let renderFailure: unknown
    try {
      // Preserve depth occlusion while excluding the desk from alpha crop bounds.
      if (deskMaterial) deskMaterial.colorWrite = false
      renderer.setRenderTarget(renderTarget)
      renderer.setClearColor(0x000000, 0)
      renderer.autoClear = true
      renderer.shadowMap.autoUpdate = false
      renderer.shadowMap.needsUpdate = false
      renderer.clear(true, true, true)
      this.prepareLighting()
      renderer.render(scene, measurementCamera)
    } catch (error) {
      renderFailure = error
      console.warn('Failed to render the visible-content measurement.', error)
    } finally {
      if (deskMaterial) deskMaterial.colorWrite = deskColorWrite!
      try {
        renderer.setRenderTarget(previousRenderTarget)
        renderer.setClearColor(previousClearColor, previousClearAlpha)
        renderer.autoClear = previousAutoClear
        renderer.shadowMap.autoUpdate = previousShadowAutoUpdate
        renderer.shadowMap.needsUpdate = previousShadowNeedsUpdate
      } catch (error) {
        renderFailure ??= error
        console.warn('Failed to restore the renderer after content measurement.', error)
      }
    }
    if (renderFailure) {
      this.contentMeasurementTargets.delete(renderTarget)
      renderTarget.dispose()
      return {
        status: 'failure',
        reason: this.getMeasurementFailureReason(renderer, 'render-failed'),
      }
    }

    try {
      const readback = renderer.readRenderTargetPixelsAsync(
        renderTarget,
        0,
        0,
        measurementWidth,
        measurementHeight,
        pixels,
      )
      this.contentReadbacks.add(readback)
      try {
        await readback
      } finally {
        this.contentReadbacks.delete(readback)
      }
      if (
        renderer !== this.renderer
        || scene !== this.scene
        || camera !== this.camera
        || measurementGeneration !== this.contentMeasurementGeneration
        || modelLoadGeneration !== this.modelLoadGeneration
      ) {
        return { status: 'stale' }
      }
      if (this.getMeasurementFailureReason(renderer, 'readback-failed') === 'context-lost') {
        return { status: 'failure', reason: 'context-lost' }
      }
      const measurement = scanAlphaContentMeasurement(
        pixels,
        measurementWidth,
        measurementHeight,
        0,
      )
      if (measurement.status !== 'success') return measurement
      const scaleX = measurementRect.width / measurementWidth
      const scaleY = measurementRect.height / measurementHeight
      const measured = measurement.rect
      return { status: 'success', rect: padContentRect(unionContentRects(normalizeVisibleContentRect({
        x: measurementRect.x + measured.x * scaleX,
        y: measurementRect.y + measured.y * scaleY,
        width: measured.width * scaleX,
        height: measured.height * scaleY,
      }, this.compositionWidth, this.compositionHeight), this.getMouseMotionContentRect()), this.getContentPadding()) }
    } catch (error) {
      if (renderer !== this.renderer || measurementGeneration !== this.contentMeasurementGeneration) {
        return { status: 'stale' }
      }
      console.warn('Failed to read the visible-content measurement.', error)
      return {
        status: 'failure',
        reason: this.getMeasurementFailureReason(renderer, 'readback-failed'),
      }
    } finally {
      this.contentMeasurementTargets.delete(renderTarget)
      renderTarget.dispose()
    }
  }

  setMaxFPS(fps: number): void {
    this.maxFPS = Number.isFinite(fps)
      ? Math.min(MAX_FPS, Math.max(MIN_FPS, fps))
      : 60
    this.noteActivity()
  }

  setIdlePowerSavingEnabled(enabled: boolean): void {
    this.renderCadence.setEnabled(enabled, performance.now())
  }

  setShadowQuality(quality: ShadowQuality): void {
    const normalized = normalizeShadowQuality(quality)
    if (this.shadowQuality === normalized) return
    this.shadowQuality = normalized
    this.highShadows.value = normalized === 'high'
    this.noteActivity()
    this.updateShadowMapSize()
  }

  setInteractionHeld(held: boolean): void {
    this.renderCadence.setInteractionHeld(held, performance.now())
  }

  setShadowsEnabled(enabled: boolean): void {
    if (this.shadowsEnabled !== enabled) this.noteActivity()
    this.shadowsEnabled = enabled
    if (!this.renderer) return
    this.renderer.shadowMap.enabled = enabled
    this.markMaterialsForUpdate()
    if (enabled) this.updateShadowMapSize()
  }

  setRenderScalePercent(percent: number): void {
    if (!Number.isFinite(percent)) return
    if (percent !== this.renderScalePercent) this.noteActivity()
    this.renderScalePercent = Math.min(100, Math.max(50, percent))
    this.applyPixelRatio()
    this.renderer?.setSize(this.outputWidth, this.outputHeight, false)
    this.updateShadowMapSize()
  }

  setPixelFilterEnabled(enabled: boolean): void {
    this.pixelFilterEnabled = enabled
    this.appliedVoxelSkin?.setPixelFilterEnabled(enabled)
    this.noteActivity()
  }

  getAntialiasEnabled(): boolean {
    return this.antialiasRequested
  }

  /** Only the context changes. Camera, model, animation, input and canvas size survive. */
  async setAntialiasEnabled(enabled: boolean, isCurrent: () => boolean = () => true): Promise<HTMLCanvasElement | undefined> {
    const generation = ++this.antialiasGeneration
    const previous = this.renderer
    // Coalesce rapid edits and let a content readback finish before replacing its renderer.
    await this.contentMeasurementTail
    if (!previous || previous !== this.renderer || !this.scene || !this.camera
      || generation !== this.antialiasGeneration || !isCurrent()) {
      return
    }
    if (enabled === this.antialiasRequested) return previous.domElement

    const canvas = previous.domElement.cloneNode(false) as HTMLCanvasElement
    const shadow = this.directionalLight?.shadow
    const oldMap = shadow?.map ?? null
    const oldMapPass = shadow?.mapPass ?? null
    let candidate: WebGLRenderer | undefined
    try {
      candidate = this.createRenderer(canvas, enabled)
      candidate.outputColorSpace = previous.outputColorSpace
      candidate.toneMapping = previous.toneMapping
      candidate.toneMappingExposure = previous.toneMappingExposure
      candidate.setClearColor(previous.getClearColor(new Color()), previous.getClearAlpha())
      candidate.setPixelRatio(previous.getPixelRatio())
      candidate.setSize(this.outputWidth, this.outputHeight, false)
      candidate.shadowMap.enabled = this.shadowsEnabled
      candidate.shadowMap.type = previous.shadowMap.type
      // Shadow targets belong to their context. Do not reuse the old context's maps.
      if (shadow) {
        shadow.map = null
        shadow.mapPass = null
      }
      const onShaderError = candidate.debug.onShaderError
      candidate.debug.onShaderError = () => {
        throw new Error('The replacement renderer shader could not compile.')
      }
      this.renderPresentationFrame(candidate)
      const gl = candidate.getContext()
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR
        || gl.getContextAttributes()?.antialias !== enabled) {
        throw new Error('The requested antialiasing context could not be rendered.')
      }
      candidate.debug.onShaderError = onShaderError
      previous.domElement.replaceWith(canvas)
    } catch (error) {
      if (shadow) {
        if (shadow.map !== oldMap) shadow.map?.dispose()
        if (shadow.mapPass !== oldMapPass) shadow.mapPass?.dispose()
        shadow.map = oldMap
        shadow.mapPass = oldMapPass
      }
      if (candidate) {
        this.rendererDiagnosticCleanups.get(candidate)?.()
        disposeReplacedRenderer(candidate, Promise.resolve())
      }
      throw error
    }
    this.renderer = candidate
    this.antialiasRequested = enabled
    oldMap?.dispose()
    oldMapPass?.dispose()
    this.rendererDiagnosticCleanups.get(previous)?.()
    disposeReplacedRenderer(previous, Promise.allSettled([...this.contentReadbacks]))
    this.noteActivity()
    return canvas
  }

  private createRenderer(canvas: HTMLCanvasElement, antialias: boolean): WebGLRenderer {
    const renderer = new WebGLRenderer({ canvas, alpha: true, antialias, premultipliedAlpha: true, powerPreference: 'high-performance' })
    const onContextLost = () => {
      if (this.renderer !== renderer) return
      if (this.runtimeFailure) this.failRuntime(new Error('The active pet WebGL context was lost.'))
      else console.warn('The active pet WebGL context was lost.')
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    this.rendererDiagnosticCleanups.set(renderer, () => canvas.removeEventListener('webglcontextlost', onContextLost))
    // Driver shader output can include sources and device details. Keep the
    // failure category while the existing rendering/error flow owns recovery.
    renderer.debug.onShaderError = () => {
      if (this.renderer !== renderer) return
      if (this.runtimeFailure) this.failRuntime(new Error('The pet renderer shader could not compile.'))
      else console.error('The pet renderer shader could not compile.')
    }
    return renderer
  }

  setLightingSettings(value: LightingSettings): void {
    const next = normalizeLightingSettings(value)
    if (JSON.stringify(next) === JSON.stringify(this.lightingSettings)) return
    this.lightingSettings = next
    this.noteActivity()
    if (this.renderer) applyLightingOutput(this.renderer)
    this.lighting?.apply(next)
    this.lightingBoundsDirty = true
    this.updateShadowMapSize()
  }

  private prepareLighting(): void {
    if (!this.lightingBoundsDirty || !this.lighting || !this.sceneRoot) return
    this.lighting.fitShadow(this.sceneRoot, this.lightingSettings)
    this.lightingBoundsDirty = false
  }

  setSceneRotation(degrees: number): void {
    if (!Number.isFinite(degrees)) return
    if (degrees !== this.rotationDegrees) this.invalidateContentMeasurement()
    this.rotationDegrees = degrees
    if (this.sceneRoot) {
      this.sceneRoot.rotation.y = MathUtils.degToRad(degrees)
      this.lightingBoundsDirty = true
    }
  }

  setCameraElevation(degrees: number): void {
    if (!Number.isFinite(degrees)) return
    if (degrees === this.cameraElevationDegrees) return
    this.invalidateContentMeasurement()
    this.cameraElevationDegrees = degrees
    this.fitCamera()
  }

  setCameraDistance(percent: number): void {
    if (!Number.isFinite(percent) || percent <= 0) return
    if (percent === this.cameraDistancePercent) return
    this.invalidateContentMeasurement()
    this.cameraDistancePercent = percent
    this.positionCamera()
  }

  setCameraPan(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (x === this.cameraPanX && y === this.cameraPanY) return
    this.invalidateContentMeasurement()
    this.cameraPanX = x
    this.cameraPanY = y
    this.positionCamera()
  }

  handleSemanticInput(event: SemanticInputEvent): void {
    if (!this.inputActive) return
    if (event.kind !== 'typing' && event.kind !== 'pointer_activity' && (!this.mouseEnabled || !this.mouseInputActive)) return
    if (this.stillFrameOnly) this.stillFrameInputReceived = true
    this.renderCadence.handleInput(event, performance.now())
    if (event.kind === 'pointer_activity') {
      if (this.mouseEnabled && this.mouseInputActive) this.mouse?.setMousePosition(event.x, event.y)
      this.petAnimator?.setMousePosition(event.x, event.y)
      return
    }
    if (event.kind === 'typing') {
      if (event.contact) {
        const key = `${event.contact.row}:${event.contact.column}`
        if (event.contact.pressed) this.heldKeyboardContacts.set(key, { ...event.contact })
        else this.heldKeyboardContacts.delete(key)
        const timestamp = performance.now()
        const target = this.keyboard?.getContactTarget(event.contact)
        this.keyboard?.setContactPressed(event.contact, event.contact.pressed)
        this.petAnimator?.setKeyPressed(
          `${event.contact.row}:${event.contact.column}`,
          event.contact.pressed,
          target,
        )
        this.dmeloperEyebrowController?.setKeyPressed(
          `${event.contact.row}:${event.contact.column}`,
          event.contact.pressed,
          timestamp,
        )
      }
      return
    }
    if (event.kind === 'scroll') {
      this.mouse?.pulseWheelScroll(event.deltaX, event.deltaY)
      return
    }
    if (event.kind === 'mouse_primary' || event.kind === 'mouse_secondary' || event.kind === 'mouse_middle') {
      const button = event.kind === 'mouse_primary' ? 'Left' : event.kind === 'mouse_secondary' ? 'Right' : 'Middle'
      this.mouse?.setMouseButtonPressed(button, event.active)
      this.petAnimator?.setMouseButtonPressed(button, event.active)
      if (button !== 'Middle') {
        this.dmeloperEyebrowController?.setMouseButtonPressed(
          button,
          event.active,
          performance.now(),
        )
      }
    }
  }

  setMouseEnabled(enabled: boolean): void {
    if (this.mouseEnabled !== enabled) this.invalidateContentMeasurement()
    this.mouseEnabled = enabled
    if (!enabled) this.renderCadence.resetMouseInput(performance.now())
    this.mouse?.setMouseEnabled(enabled)
    this.petAnimator?.setMouseEnabled(enabled)
    this.dmeloperEyebrowController?.setMouseEnabled(enabled)
  }

  /** A suspended collector must not change the user's resting pose or keyboard state. */
  setMouseInputActive(active: boolean): void {
    if (this.mouseInputActive !== active) this.noteActivity()
    this.mouseInputActive = active
    if (active) return
    this.renderCadence.resetMouseInput(performance.now())
    this.mouse?.resetInput()
    this.petAnimator?.resetMouseInput()
    this.dmeloperEyebrowController?.resetMouseInput()
  }

  setInputActive(active: boolean): void {
    if (!active) {
      // Key-up can arrive while a skin load suspends input on this same rig.
      // Release accepted contacts before closing the gate so no keycap, arm,
      // or eyebrow retains a hold whose native release will be discarded.
      for (const contact of this.heldKeyboardContacts.values()) {
        this.handleSemanticInput({ kind: 'typing', active: false, intensity: 0, contact: { ...contact, pressed: false } })
      }
      this.heldKeyboardContacts.clear()
      this.petAnimator?.resetInput()
    }
    if (this.inputActive !== active) this.renderCadence.reset(performance.now())
    this.inputActive = active
    if (!active) this.setMouseInputActive(false)
  }

  setDmeloperEyebrows(preset: DmeloperEyebrowPreset): void {
    const previous = this.dmeloperEyebrowPreset
    if (Object.keys(preset).some(key => preset[key as keyof DmeloperEyebrowPreset] !== previous[key as keyof DmeloperEyebrowPreset])) {
      this.noteActivity()
    }
    if (
      preset.enabled !== previous.enabled
      || preset.centerOffsetPixels !== previous.centerOffsetPixels
      || preset.heightOffsetPixels !== previous.heightOffsetPixels
      || preset.spacingPixels !== previous.spacingPixels
      || preset.widthPixels !== previous.widthPixels
      || preset.thicknessPixels !== previous.thicknessPixels
      || preset.depthPercent !== previous.depthPercent
    ) {
      this.invalidateContentMeasurement()
    }
    this.dmeloperEyebrowPreset = { ...preset }
    this.dmeloperEyebrowController?.setPreset(this.dmeloperEyebrowPreset)
  }

  setDmeloperPalmColor(color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return
    if (this.dmeloperPalmColor !== color) this.noteActivity()
    this.dmeloperPalmColor = color
    this.voxelSkinGeometryController?.setPalmColor(color)
  }

  setKeyboardLegendLanguage(language: KeyboardLegendLanguage): void {
    if (language !== 'ko' && language !== 'en') return
    if (this.keyboardLegendLanguage !== language) this.noteActivity()
    this.keyboardLegendLanguage = language
    this.keyboard?.setLegendLanguage(language)
  }

  setDeviceColors(colors: DeviceColorSettings): void {
    const normalized = normalizeDeviceColors(colors)
    if (DEVICE_COLOR_KEYS.every(key => normalized[key] === this.deviceColors[key])) return
    this.noteActivity()
    this.deviceColors = normalized
    this.keyboard?.setColors(normalized)
    this.mouse?.setColors(normalized)
  }

  setMousePosition(xRatio: number, yRatio: number): void {
    if (!this.inputActive) return
    this.handleSemanticInput({ kind: 'pointer_activity', x: xRatio, y: yRatio })
  }

  setPetHeadScalePercent(percent: number): void {
    if (!Number.isFinite(percent)) return
    const normalized = Math.min(200, Math.max(25, percent))
    if (normalized === this.petHeadScalePercent) return
    this.invalidateContentMeasurement()
    this.petHeadScalePercent = normalized
    this.petAnimator?.setHeadScalePercent(normalized)
  }

  setPetArmPoseSettings(settings: PetArmPoseSettings): void {
    const normalized = normalizePetArmPoseSettings(settings, this.petArmPoseSettings)
    if (Object.keys(normalized).every((key) => {
      const setting = key as keyof PetArmPoseSettings
      return normalized[setting] === this.petArmPoseSettings[setting]
    })) {
      return
    }
    this.invalidateContentMeasurement()
    this.petArmPoseSettings = normalized
    this.petAnimator?.setArmPoseSettings(normalized)
  }

  setPetTransform(rotationYDegrees: number, deskOffset: number): void {
    if (!Number.isFinite(rotationYDegrees) || !Number.isFinite(deskOffset)) return
    if (
      rotationYDegrees !== this.petRotationYDegrees
      || deskOffset !== this.petDeskOffset
    ) {
      this.invalidateContentMeasurement()
    }
    this.petRotationYDegrees = rotationYDegrees
    this.petDeskOffset = deskOffset
    const orientation = this.sceneRoot?.getObjectByName('petOrientation')
    if (orientation) {
      orientation.rotation.y = MathUtils.degToRad(
        MODEL_3D_CONFIG.pet.rotationYDegrees + rotationYDegrees,
      )
    }
    const petGroup = this.sceneRoot?.getObjectByName('petGroup')
    if (petGroup) petGroup.position.z = MODEL_3D_CONFIG.pet.position[2] + deskOffset
  }

  private get mouseBaseSceneXOffset(): number {
    return this.mouseBaseXOffset < 0
      ? this.mouseBaseXOffset * MODEL_3D_CONFIG.mouse.negativeXOffsetScale
      : this.mouseBaseXOffset
  }

  setMouseBasePosition(xOffset: number, zOffset: number): void {
    if (!Number.isFinite(xOffset) || !Number.isFinite(zOffset)) return
    if (
      xOffset !== this.mouseBaseXOffset
      || zOffset !== this.mouseBaseZOffset
    ) {
      this.invalidateContentMeasurement()
    }
    this.mouseBaseXOffset = xOffset
    this.mouseBaseZOffset = zOffset
    if (this.mouse) {
      this.mouse.group.position.x = MODEL_3D_CONFIG.mouse.position[0] + this.mouseBaseSceneXOffset
      this.mouse.group.position.z = MODEL_3D_CONFIG.mouse.position[2] + zOffset
    }
  }

  setDeskSettings(settings: Partial<DeskSettings>): void {
    const next = normalizeDeskSettings(settings)
    if (next.deskHeightOffset !== this.deskSettings.deskHeightOffset
      || next.deskWidthOffset !== this.deskSettings.deskWidthOffset
      || next.deskDepthOffset !== this.deskSettings.deskDepthOffset) {
      this.invalidateContentMeasurement()
    }
    if (Object.keys(next).some(key => next[key as keyof DeskSettings] !== this.deskSettings[key as keyof DeskSettings])) this.noteActivity()
    this.deskSettings = next
    if (this.desk) {
      this.applyDeskTransform()
      this.desk.material.colorWrite = !next.deskTransparent
      this.desk.material.color.set(next.deskColor)
    }
    if (this.keyboard) this.applyObjectScale(this.keyboard.group, MODEL_3D_CONFIG.keyboard.scale, MODEL_3D_CONFIG.keyboard.position[1], this.keyboardScalePercent)
    if (this.mouse) this.applyObjectScale(this.mouse.group, MODEL_3D_CONFIG.mouse.scale, MODEL_3D_CONFIG.mouse.position[1], this.mouseScalePercent)
    this.sceneRoot?.updateMatrixWorld(true)
  }

  setMouseScalePercent(percent: number): void {
    if (!Number.isFinite(percent) || percent <= 0) return
    const normalizedPercent = Math.min(200, Math.max(50, percent))
    if (normalizedPercent === this.mouseScalePercent) return
    this.invalidateContentMeasurement()
    this.mouseScalePercent = normalizedPercent
    if (this.mouse) {
      this.applyObjectScale(
        this.mouse.group,
        MODEL_3D_CONFIG.mouse.scale,
        MODEL_3D_CONFIG.mouse.position[1],
        normalizedPercent,
      )
    }
  }

  setKeyboardBasePosition(xOffset: number, zOffset: number): void {
    if (!Number.isFinite(xOffset) || !Number.isFinite(zOffset)) return
    if (
      xOffset !== this.keyboardBaseXOffset
      || zOffset !== this.keyboardBaseZOffset
    ) {
      this.invalidateContentMeasurement()
    }
    this.keyboardBaseXOffset = xOffset
    this.keyboardBaseZOffset = zOffset
    if (this.keyboard) {
      this.keyboard.group.position.x = MODEL_3D_CONFIG.keyboard.position[0] + xOffset
      this.keyboard.group.position.z = MODEL_3D_CONFIG.keyboard.position[2] + zOffset
    }
  }

  setKeyboardScalePercent(percent: number): void {
    if (!Number.isFinite(percent) || percent <= 0) return
    const normalizedPercent = Math.min(200, Math.max(50, percent))
    if (normalizedPercent === this.keyboardScalePercent) return
    this.invalidateContentMeasurement()
    this.keyboardScalePercent = normalizedPercent
    if (this.keyboard) {
      this.applyObjectScale(
        this.keyboard.group,
        MODEL_3D_CONFIG.keyboard.scale,
        MODEL_3D_CONFIG.keyboard.position[1],
        normalizedPercent,
      )
    }
  }

  destroy(): void {
    this.runtimeFailure = undefined
    this.firstFrameRendered = undefined
    this.runtimeFaulted = false
    this.initializationGeneration += 1
    this.antialiasGeneration += 1
    this.initializationAbort?.abort()
    this.initializationAbort = undefined
    this.cancelPendingPetAssetLoad()
    this.contentMeasurementTail = Promise.resolve()
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId)
    this.frameId = undefined
    this.stillFrameOnly = false
    this.stillFrameInputReceived = false
    this.clearPetModel()
    this.heldKeyboardContacts.clear()
    this.generatedGroupDisposers.splice(0).forEach(dispose => dispose())
    if (this.scene) {
      this.disposeObjectResources(this.scene)
      this.scene.clear()
    }
    this.directionalLight?.shadow.dispose()
    this.contentMeasurementTargets.forEach(target => target.dispose())
    this.contentMeasurementTargets.clear()
    const renderer = this.renderer
    this.renderer = undefined
    this.scene = undefined
    this.sceneRoot = undefined
    this.camera = undefined
    this.directionalLight = undefined
    this.lighting = undefined
    this.lightingBoundsDirty = true
    this.keyboard = undefined
    this.mouse = undefined
    this.desk = undefined
    this.renderCadence.reset(performance.now())
    this.lastAnimationAt = 0
    if (renderer) {
      this.rendererDiagnosticCleanups.get(renderer)?.()
      disposeRendererForReuse(renderer, Promise.allSettled([...this.contentReadbacks]))
    }
  }

  private buildScene(scene: Scene, sceneRoot: Group): void {
    const petGroup = new Group()
    petGroup.name = 'petGroup'
    petGroup.position.set(...MODEL_3D_CONFIG.pet.position)

    const keyboard = createKeyboardGroup()
    keyboard.group.position.set(
      MODEL_3D_CONFIG.keyboard.position[0] + this.keyboardBaseXOffset,
      MODEL_3D_CONFIG.keyboard.position[1],
      MODEL_3D_CONFIG.keyboard.position[2] + this.keyboardBaseZOffset,
    )
    this.applyObjectScale(
      keyboard.group,
      MODEL_3D_CONFIG.keyboard.scale,
      MODEL_3D_CONFIG.keyboard.position[1],
      this.keyboardScalePercent,
    )
    keyboard.group.rotation.y = MathUtils.degToRad(
      MODEL_3D_CONFIG.keyboard.rotationYDegrees,
    )

    const mouse = createMouseGroup()
    mouse.setMouseEnabled(this.mouseEnabled)
    mouse.group.position.set(
      MODEL_3D_CONFIG.mouse.position[0] + this.mouseBaseSceneXOffset,
      MODEL_3D_CONFIG.mouse.position[1],
      MODEL_3D_CONFIG.mouse.position[2] + this.mouseBaseZOffset,
    )
    this.applyObjectScale(
      mouse.group,
      MODEL_3D_CONFIG.mouse.scale,
      MODEL_3D_CONFIG.mouse.position[1],
      this.mouseScalePercent,
    )
    mouse.group.rotation.y = MathUtils.degToRad(
      MODEL_3D_CONFIG.mouse.rotationYDegrees,
    )

    this.keyboard = keyboard
    keyboard.setColors(this.deviceColors)
    keyboard.setLegendLanguage(this.keyboardLegendLanguage)
    this.mouse = mouse
    mouse.setColors(this.deviceColors)
    this.generatedGroupDisposers.push(
      () => {
        keyboard.group.removeFromParent()
        keyboard.dispose()
      },
      () => {
        mouse.group.removeFromParent()
        mouse.dispose()
      },
    )

    const deskGeometry = new BoxGeometry(...MODEL_3D_CONFIG.desk.size)
    const deskMaterial = new MeshStandardMaterial({
      color: this.deskSettings.deskColor,
      colorWrite: !this.deskSettings.deskTransparent,
      depthTest: true,
      depthWrite: true,
    })
    const desk = new Mesh(deskGeometry, deskMaterial)
    desk.name = 'desk'
    desk.userData.excludeFromContentBounds = true
    desk.receiveShadow = true
    this.desk = desk
    this.applyDeskTransform()
    desk.renderOrder = -100
    sceneRoot.add(desk, petGroup, keyboard.group, mouse.group)

    this.lighting = new SceneLighting()
    this.directionalLight = this.lighting.key
    this.lighting.apply(this.lightingSettings)
    this.lightingBoundsDirty = true
    scene.add(sceneRoot, this.lighting.group)
    installSoftShadows(sceneRoot, this.highShadows)
    const beforeRender = scene.onBeforeRender
    scene.onBeforeRender = function (...args) {
      beforeRender.apply(this, args)
      const renderer = args[0]
      const shadow = renderer.shadowMap
      // Three 0.185.1 stamps instance uploads after incrementing the frame in
      // its shadow pass. Retire that stamp before a draw which skips shadows;
      // otherwise the first Off/crop measurement can reuse stale key buffers.
      if (!shadow.enabled || (!shadow.autoUpdate && !shadow.needsUpdate)) renderer.info.render.frame++
    }
  }

  private applyDeskTransform(): void {
    if (!this.desk) return
    const { size, position, heightOffsetScale, minimumWidth } = MODEL_3D_CONFIG.desk
    const { deskWidthOffset, deskDepthOffset } = this.deskSettings
    // Retain the default and upper half while mapping the minimum width to one scene unit.
    const widthScale = deskWidthOffset < 0
      ? MathUtils.lerp(1.5, minimumWidth / size[0], -deskWidthOffset)
      : 1.5 + deskWidthOffset / 2
    const depthScale = 1 + deskDepthOffset / 2
    this.desk.scale.set(widthScale, 1, depthScale)
    // Preserve the pet-facing edge midpoint while changing width and depth.
    this.desk.position.set(
      position[0],
      position[1] - MODEL_3D_CONFIG.objectVerticalGap + this.deskSettings.deskHeightOffset * heightOffsetScale,
      position[2] + size[2] * (depthScale - 1) / 2,
    )
  }

  private applyObjectScale(
    group: Group,
    baseScale: number,
    baseY: number,
    scalePercent: number,
  ): void {
    const scaleRatio = scalePercent / 100
    group.scale.setScalar(baseScale * scaleRatio)
    // The generated mesh already embeds -objectVerticalGap / baseScale.
    // Offset the scaled group so its original desk clearance stays fixed.
    group.position.y = baseY + this.deskSettings.deskHeightOffset * MODEL_3D_CONFIG.desk.heightOffsetScale
      + MODEL_3D_CONFIG.objectVerticalGap * (scaleRatio - 1)
  }

  private assertCurrentModelLoad(generation: number): void {
    if (generation === this.modelLoadGeneration && this.sceneRoot) return
    throw createPetLoadCancelledError()
  }

  private async loadPet(
    petUrl: string,
    skinUrl: string | undefined,
    skinModel: VoxelSkinModelPreference,
    generation: number,
    signal: AbortSignal,
  ): Promise<VoxelSkinModel | undefined> {
    // Fetch per operation: FileLoader globally deduplicates URLs, which can
    // couple a new init to the request being cancelled by the previous init.
    const response = await fetch(petUrl, { signal })
    if (!response.ok) throw new Error('The fixed pet model could not be read.')
    const bytes = await response.arrayBuffer()
    this.assertCurrentModelLoad(generation)
    const gltf = await awaitAssetOperation(
      new GLTFLoader().parseAsync(bytes, LoaderUtils.extractUrlBase(petUrl)),
      signal,
      late => this.disposeObjectResources(late.scene),
    )
    const model = gltf.scene
    let pendingVoxelSkin: AppliedVoxelSkin | undefined
    let pendingVoxelSkinUrl: string | undefined
    let pendingSkinModelController: VoxelSkinModelController | undefined
    let pendingSkinGeometryController: VoxelSkinGeometryController | undefined
    let pendingDecodedSkin: NormalizedVoxelSkin | undefined
    let resolvedSkinModel: VoxelSkinModel | undefined
    let attached = false
    try {
      this.assertCurrentModelLoad(generation)
      model.name ||= 'petModel'
      model.traverse((object) => {
        if (object instanceof Mesh) {
          object.castShadow = object.userData.voxelSkinLayer !== 'outer'
          object.receiveShadow = true
        }
      })
      this.useMeshBindPose(model)
      if (skinUrl) {
        pendingDecodedSkin = await this.loadSkin(skinUrl, signal)
        this.assertCurrentModelLoad(generation)
      }
      resolvedSkinModel = pendingDecodedSkin
        ? resolveVoxelSkinModelPreference(pendingDecodedSkin, skinModel)
        : skinModel === 'slim' ? 'slim' : 'wide'
      pendingSkinModelController = createVoxelSkinModelController(
        model,
        resolvedSkinModel,
      )
      pendingSkinGeometryController = createVoxelSkinGeometryController(model)
      pendingSkinGeometryController.setPalmColor(this.dmeloperPalmColor)
      if (pendingDecodedSkin && skinUrl) {
        pendingSkinGeometryController.setSkin(pendingDecodedSkin)
        pendingVoxelSkin = applyVoxelSkin(model, pendingDecodedSkin, {
          materialNames: ['Voxel External Skin', 'Voxel External Skin Overlay'],
        })
        pendingVoxelSkinUrl = skinUrl
      }

      installSoftShadows(model, this.highShadows)
      this.attachPetModel(model)
      attached = true
      this.dmeloperEyebrowController = createDmeloperEyebrowController(model)
      this.dmeloperEyebrowController?.setAnimationEnabled(this.eyebrowAnimationEnabled)
      this.dmeloperEyebrowController?.setMouseEnabled(this.mouseEnabled)
      this.dmeloperEyebrowController?.setPreset(this.dmeloperEyebrowPreset)
      this.dmeloperEyebrowController?.setSuggestedColor(
        pendingDecodedSkin?.suggestedEyebrowColor,
      )
      pendingVoxelSkin?.setPixelFilterEnabled(this.pixelFilterEnabled)
      this.appliedVoxelSkin = pendingVoxelSkin
      this.appliedVoxelSkinUrl = pendingVoxelSkinUrl
      this.voxelSkinModelController = pendingSkinModelController
      this.voxelSkinGeometryController = pendingSkinGeometryController
      this.cachedVoxelSkin = pendingDecodedSkin && skinUrl
        ? { url: skinUrl, skin: pendingDecodedSkin }
        : undefined
      pendingVoxelSkin = undefined
      pendingSkinModelController = undefined
      pendingSkinGeometryController = undefined
      return resolvedSkinModel
    } catch (error) {
      pendingVoxelSkin?.dispose()
      pendingSkinModelController?.dispose()
      pendingSkinGeometryController?.dispose()
      if (!attached) {
        this.disposeObjectResources(model)
      }
      throw error
    }
  }

  private async loadSkin(url: string, signal: AbortSignal): Promise<NormalizedVoxelSkin> {
    let decoding = false
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error('The selected Dmeloper skin could not be read.')
      const blob = await response.blob()
      decoding = true
      if (blob.type && blob.type !== 'image/png') {
        throw new Error('The selected Dmeloper skin must be a PNG image.')
      }
      if (signal.aborted) throw createPetLoadCancelledError()
      return await awaitAssetOperation(decodeVoxelSkin(blob, 'auto'), signal)
    } catch (error) {
      if (signal.aborted) throw createPetLoadCancelledError()
      if (decoding) console.warn('Failed to decode the selected pet skin.')
      else console.warn('Failed to read the selected pet skin.')
      const assetError = new Error('The selected pet skin could not be loaded.')
      Object.defineProperty(assetError, 'cause', { value: error })
      assetError.name = 'PetAssetLoadError'
      throw assetError
    }
  }

  private attachPetModel(model: Object3D): void {
    const petGroup = this.sceneRoot?.getObjectByName('petGroup')
    if (!(petGroup instanceof Group)) throw new Error('The pet group is not initialized.')

    model.updateMatrixWorld(true)
    let referenceBoundsNode: Object3D = model
    model.traverse((object) => {
      const referenceName = object.userData.petReferenceBoundsNode
      if (typeof referenceName !== 'string') return
      referenceBoundsNode = model.getObjectByName(referenceName) ?? referenceBoundsNode
    })
    const initialBounds = new Box3().setFromObject(referenceBoundsNode)
    const initialHeight = initialBounds.getSize(new Vector3()).y
    if (!Number.isFinite(initialHeight) || initialHeight <= 0) {
      throw new Error('The fixed pet model has invalid bounds.')
    }

    model.scale.setScalar(MODEL_3D_CONFIG.pet.normalizedHeight / initialHeight)
    model.updateMatrixWorld(true)
    const normalizedBounds = new Box3().setFromObject(referenceBoundsNode)
    const normalizedCenter = normalizedBounds.getCenter(new Vector3())
    model.position.set(-normalizedCenter.x, -normalizedBounds.min.y, -normalizedCenter.z)

    const orientation = new Group()
    orientation.name = 'petOrientation'
    orientation.rotation.y = MathUtils.degToRad(
      MODEL_3D_CONFIG.pet.rotationYDegrees + this.petRotationYDegrees,
    )
    orientation.add(model)
    orientation.traverse(object => object.layers.set(0))

    const targets = this.getPetAnimatorTargets()

    this.clearPetModel()
    petGroup.add(orientation)
    petGroup.position.z = MODEL_3D_CONFIG.pet.position[2] + this.petDeskOffset
    petGroup.updateMatrixWorld(true)
    this.petModel = model
    this.petAnimator = this.createConfiguredPetAnimator(model, targets)
  }

  private getPetAnimatorTargets(): Parameters<typeof createPetAnimator>[1] {
    const keyboardGroup = this.keyboard?.group
    const mouseGroup = this.mouse?.group
    const keyboardRestTarget = this.keyboard?.getKeyTarget('Space')
    const keyboardRightRestTarget = this.keyboard?.getKeyTarget(
      MODEL_3D_CONFIG.pet.animation.inputMode.rightIdleKey,
    )
    const keyboardLeftRestTarget = this.keyboard?.getKeyTarget(
      MODEL_3D_CONFIG.pet.animation.inputMode.leftIdleKey,
    )
    const keyboardBodyTurnThresholdTarget = this.keyboard?.getKeyTarget('KeyL')
    if (
      !keyboardGroup
      || !mouseGroup
      || !keyboardRestTarget
      || !keyboardRightRestTarget
      || !keyboardLeftRestTarget
      || !keyboardBodyTurnThresholdTarget
    ) {
      throw new Error('The fixed pet interaction targets are not initialized.')
    }

    return {
      keyboardBodyDefaultTarget: keyboardLeftRestTarget,
      keyboardBodyTurnThresholdTarget,
      keyboardNavigationTargets: MODEL_3D_CONFIG.pet.animation.keyboard.navigationKeys
        .flatMap(key => this.keyboard?.getKeyTarget(key) ?? []),
      keyboardGroup,
      keyboardLeftRestTarget,
      keyboardRestTarget,
      keyboardRightRestTarget,
      mouseGroup,
    }
  }

  private createConfiguredPetAnimator(
    model: Object3D,
    targets: Parameters<typeof createPetAnimator>[1],
  ): PetAnimator | undefined {
    const animator = createPetAnimator(model, targets)
    // Public setters can skip equal values; a new animator still needs them.
    animator?.setHeadScalePercent(this.petHeadScalePercent)
    animator?.setArmPoseSettings(this.petArmPoseSettings)
    animator?.setMouseEnabled(this.mouseEnabled)
    return animator
  }

  private clearPetModel(): void {
    this.loadedPetAssetState = undefined
    this.dmeloperEyebrowController?.dispose()
    this.dmeloperEyebrowController = undefined
    this.petAnimator?.dispose()
    this.petAnimator = undefined
    this.appliedVoxelSkin?.dispose()
    this.appliedVoxelSkin = undefined
    this.appliedVoxelSkinUrl = undefined
    this.voxelSkinModelController?.dispose()
    this.voxelSkinModelController = undefined
    this.voxelSkinGeometryController?.dispose()
    this.voxelSkinGeometryController = undefined
    this.cachedVoxelSkin = undefined
    this.petModel = undefined
    const petGroup = this.sceneRoot?.getObjectByName('petGroup')
    const orientation = petGroup?.getObjectByName('petOrientation')
    if (!orientation) return
    orientation.removeFromParent()
    this.disposeObjectResources(orientation)
  }

  private recordLoadedDmeloperSkin(
    model: Object3D,
    skinUrl: string | undefined,
    skinModel: VoxelSkinModelPreference,
  ): void {
    this.noteActivity()
    if (
      model !== this.petModel
      || this.loadedPetAssetState?.modelId !== 'dmeloper'
    ) {
      return
    }
    this.loadedPetAssetState = {
      modelId: 'dmeloper',
      dmeloperSkinModel: skinModel,
      dmeloperSkinUrl: skinUrl,
    }
  }

  private useMeshBindPose(root: Object3D): void {
    const skeletons = new Set<Skeleton>()
    root.traverse((object) => {
      if (object instanceof SkinnedMesh) skeletons.add(object.skeleton)
    })
    root.updateMatrixWorld(true)
    skeletons.forEach((skeleton) => {
      skeleton.calculateInverses()
      skeleton.update()
    })
  }

  private getMeasurementFailureReason(
    renderer: WebGLRenderer,
    fallback: VisibleContentMeasurementFailureReason,
  ): VisibleContentMeasurementFailureReason {
    try {
      return renderer.getContext().isContextLost()
        ? 'context-lost'
        : fallback
    } catch {
      return 'context-lost'
    }
  }

  private invalidateContentMeasurement(): void {
    this.lightingBoundsDirty = true
    this.contentMeasurementGeneration += 1
    this.noteActivity()
  }

  private noteActivity(): void {
    this.renderCadence.noteActivity(performance.now())
  }

  private createCompositionCamera(camera: PerspectiveCamera): PerspectiveCamera {
    const compositionCamera = camera.clone()
    compositionCamera.aspect = this.compositionWidth / this.compositionHeight
    compositionCamera.clearViewOffset()
    compositionCamera.updateProjectionMatrix()
    return compositionCamera
  }

  private createBoundsCorners(bounds: Box3): Vector3[] {
    return [
      new Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
      new Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
      new Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
      new Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
      new Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
      new Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
      new Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    ]
  }

  private applyCameraViewOffset(): void {
    const camera = this.camera
    if (!camera) return
    applyVisibleContentViewOffset(
      camera,
      this.compositionWidth,
      this.compositionHeight,
      this.realizedViewRect,
    )
  }

  private updateShadowMapSize(): void {
    const renderer = this.renderer
    const directionalLight = this.directionalLight
    if (!renderer || !directionalLight) return

    const drawingBufferSize = renderer.getDrawingBufferSize(new Vector2())
    const requestedSize = selectAdaptiveShadowMapSize(
      drawingBufferSize.x,
      drawingBufferSize.y,
      this.shadowQuality,
    )
    const limit = renderer.capabilities?.maxTextureSize ?? requestedSize
    const size = Math.min(requestedSize, 2 ** Math.floor(Math.log2(Math.max(1, limit))))
    directionalLight.shadow.radius = this.highShadows.value ? size / 256 : 1
    if (
      directionalLight.shadow.mapSize.x === size
      && directionalLight.shadow.mapSize.y === size
    ) {
      return
    }

    directionalLight.shadow.mapSize.set(size, size)
    if (directionalLight.shadow.map) {
      directionalLight.shadow.map.dispose()
      directionalLight.shadow.map = null
    }
    directionalLight.shadow.needsUpdate = true
  }

  private fitCamera(): boolean {
    if (!this.camera || !this.sceneRoot) return false
    const sceneRotation = this.sceneRoot.rotation.y
    this.sceneRoot.rotation.y = 0
    this.sceneRoot.updateMatrixWorld(true)
    const bounds = new Box3()
    for (const name of ['petGroup', 'keyboardGroup', 'mouseGroup']) {
      const object = this.sceneRoot.getObjectByName(name)
      if (!object) continue
      const objectBounds = new Box3()
      if (name === 'keyboardGroup') {
        const world = new Box3()
        // Transform each cap before union; a rotated batch's aggregate local
        // AABB would otherwise change the original camera composition.
        object.traverse((node) => {
          if (node instanceof Mesh) forEachMeshWorldBounds(node, world, box => objectBounds.union(box))
        })
      } else {
        objectBounds.setFromObject(object)
      }
      if (name === 'petGroup') objectBounds.min.y = Math.max(0, objectBounds.min.y)
      bounds.union(objectBounds)
    }
    this.sceneRoot.rotation.y = sceneRotation
    this.sceneRoot.updateMatrixWorld(true)
    if (bounds.isEmpty()) return false

    const sphere = bounds.getBoundingSphere(new Sphere())
    const verticalFov = MathUtils.degToRad(MODEL_3D_CONFIG.camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect)
    const elevation = MathUtils.degToRad(this.cameraElevationDegrees)
    const target = new Vector3(0, sphere.center.y, 0)
    const direction = new Vector3(0, Math.sin(elevation), Math.cos(elevation)).normalize()
    const safeVerticalTangent = Math.tan(verticalFov / 2) / MODEL_3D_CONFIG.camera.fitMargin
    const safeHorizontalTangent = Math.tan(horizontalFov / 2) / MODEL_3D_CONFIG.camera.fitMargin
    const corners = this.createBoundsCorners(bounds)
    let distance = sphere.radius + MODEL_3D_CONFIG.camera.near
    for (let degrees = 0; degrees < 360; degrees += 1) {
      const radians = MathUtils.degToRad(degrees)
      const cosine = Math.cos(radians)
      const sine = Math.sin(radians)
      corners.forEach((corner) => {
        const relativeY = corner.y - target.y
        const rotatedX = corner.x * cosine + corner.z * sine
        const rotatedZ = -corner.x * sine + corner.z * cosine
        const outwardDepth = relativeY * direction.y + rotatedZ * direction.z
        const cameraY = relativeY * direction.z - rotatedZ * direction.y
        distance = Math.max(
          distance,
          outwardDepth + Math.abs(rotatedX) / safeHorizontalTangent,
          outwardDepth + Math.abs(cameraY) / safeVerticalTangent,
        )
      })
    }
    // Keep the 100% composition distance. Moving the camera through nearby
    // devices at 200% produces near-plane clipping instead of a larger image.
    distance *= MODEL_3D_CONFIG.camera.distancePercent / 100
    this.fittedCameraTarget.copy(target)
    this.fittedCameraDistance = distance
    this.positionCamera()
    return true
  }

  private positionCamera(): void {
    if (!this.camera) return
    const elevation = MathUtils.degToRad(this.cameraElevationDegrees)
    const direction = new Vector3(0, Math.sin(elevation), Math.cos(elevation))
    const target = this.fittedCameraTarget.clone()
      .addScaledVector(new Vector3(1, 0, 0), this.cameraPanX)
      .addScaledVector(new Vector3(0, direction.z, -direction.y), this.cameraPanY)
    this.camera.position.copy(target).addScaledVector(direction, this.fittedCameraDistance)
    this.camera.zoom = MODEL_3D_CONFIG.camera.distancePercent / this.cameraDistancePercent
    this.camera.lookAt(target)
    this.camera.updateMatrixWorld(true)
    this.camera.updateProjectionMatrix()
  }

  /** Request-bound recovery proof for the loaded pet asset. */
  renderHealthFrame(): boolean {
    if (this.runtimeFaulted || !this.renderer || !this.scene || !this.camera || !this.petModel) return false
    this.prepareLighting()
    return renderPetHealthFrame(this.renderer, this.scene, this.camera, this.petModel)
  }

  /** Hide only the pet on screen; measurements still use its complete geometry. */
  setPetPresentationVisible(visible: boolean): void {
    if (visible === this.petPresentationVisible) return
    this.petPresentationVisible = visible
    this.noteActivity()
    if (this.runtimeFaulted) return
    try {
      // Clear the old pet immediately instead of waiting for the FPS gate.
      this.renderPresentationFrame()
    } catch (error) {
      if (this.runtimeFailure) this.failRuntime(error)
      else throw error
    }
  }

  private renderPresentationFrame(renderer = this.renderer): void {
    if (!renderer || !this.scene || !this.camera) return
    this.prepareLighting()
    const pet = this.petPresentationVisible ? undefined : this.sceneRoot?.getObjectByName('petGroup')
    const visible = pet?.visible
    // Restore synchronously: fitting, crop readback and healthy-frame proof must
    // still see the returning pet. Other scene objects keep their visibility.
    if (pet) pet.visible = false
    try {
      renderer.render(this.scene, this.camera)
    } finally {
      if (pet) pet.visible = visible!
    }
  }

  /**
   * Restore a cold pose between input-free previews without rebuilding or refitting.
   * The owner restores baseline scene/device transforms before applying a new preset.
   */
  resetStillFramePose(): void {
    if (!this.stillFrameOnly || this.frameId !== undefined || this.runtimeFaulted
      || !this.renderer || !this.sceneRoot || !this.camera || !this.petModel
      || !this.loadedPetAssetState || this.pendingPetAssetState
      || this.stillFrameInputReceived || this.heldKeyboardContacts.size > 0) {
      throw new Error('A still-frame pose can only be reset on an initialized, input-free preview renderer.')
    }
    const targets = this.getPetAnimatorTargets()
    // dispose restores authored bone transforms before the next animator saves
    // its base pose, preventing shoulder offsets and damping history from accumulating.
    this.petAnimator?.dispose()
    this.petAnimator = this.createConfiguredPetAnimator(this.petModel, targets)
    this.sceneRoot.updateWorldMatrix(true, true)
    this.invalidateContentMeasurement()
  }

  /** Settle a preview, or the current input pose at one unchanged live timestamp. */
  renderStillFrame(currentTimestamp?: number): void {
    if (!this.renderer || !this.scene || !this.camera) return
    for (let frame = 0; frame < 60; frame++) {
      const timestamp = currentTimestamp ?? 1000 + frame * 16
      this.keyboard?.update(16, timestamp)
      this.mouse?.update(16, timestamp)
      this.petAnimator?.update(16, timestamp)
      this.dmeloperEyebrowController?.update(timestamp)
    }
    this.renderPresentationFrame()
  }

  private failRuntime(error: unknown): void {
    if (this.runtimeFaulted) return
    this.runtimeFaulted = true
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId)
    this.frameId = undefined
    // Notify after the current draw unwinds; owners may release this renderer.
    const generation = this.initializationGeneration
    const notify = this.runtimeFailure
    void Promise.resolve().then(() => {
      if (generation === this.initializationGeneration && this.runtimeFaulted) notify?.(error)
    })
  }

  private readonly renderFrame = (timestamp: number) => {
    this.frameId = undefined
    if (this.runtimeFaulted || !this.renderer || !this.scene || !this.camera) return
    try {
      if (this.renderCadence.shouldRender(timestamp, this.maxFPS)) {
        const delta = this.lastAnimationAt > 0
          ? Math.min(timestamp - this.lastAnimationAt, 100)
          : 0
        this.lastAnimationAt = timestamp
        this.keyboard?.update(delta, timestamp)
        this.mouse?.update(delta, timestamp)
        this.petAnimator?.update(delta, timestamp)
        this.dmeloperEyebrowController?.update(timestamp)
        this.renderPresentationFrame()
        if (!this.runtimeFaulted && this.petModel && this.firstFrameRendered) {
          const notify = this.firstFrameRendered
          this.firstFrameRendered = undefined
          notify()
        }
      }
      if (!this.runtimeFaulted) this.frameId = requestAnimationFrame(this.renderFrame)
    } catch (error) {
      if (this.runtimeFailure) {
        this.failRuntime(error)
      } else {
        // Non-desktop owners retain their existing frame/context recovery policy.
        this.frameId = requestAnimationFrame(this.renderFrame)
        throw error
      }
    }
  }

  private applyPixelRatio(): void {
    this.renderer?.setPixelRatio(
      Math.min(
        globalThis.devicePixelRatio || 1,
        MODEL_3D_CONFIG.renderer.maxPixelRatio,
      ) * this.renderScalePercent / 100,
    )
  }

  private markMaterialsForUpdate(): void {
    this.scene?.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material]
      materials.forEach(material => material.needsUpdate = true)
    })
  }

  private disposeObjectResources(root: Object3D): void {
    const geometries = new Set<BufferGeometry>()
    const materials = new Set<Material>()
    const textures = new Set<Texture>()
    const skeletons = new Set<Skeleton>()
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      geometries.add(object.geometry)
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material]
      objectMaterials.forEach(material => materials.add(material))
      if (object instanceof SkinnedMesh) skeletons.add(object.skeleton)
    })
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof Texture) textures.add(value)
      })
    })
    textures.forEach(texture => texture.dispose())
    materials.forEach(material => material.dispose())
    geometries.forEach(geometry => geometry.dispose())
    skeletons.forEach(skeleton => skeleton.dispose())
  }
}

export default new Three3DRenderer()
