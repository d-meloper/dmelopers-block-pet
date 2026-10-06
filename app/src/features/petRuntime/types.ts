export const PET_RUNTIME_SHOW = 'pet-runtime-show'
export const PET_RUNTIME_RESTART_REQUIRED = 'pet-runtime-restart-required'

export interface PetRuntimeRestartRequest { incident: number }
export const PET_RUNTIME_RECOVERY_QUERY = 'pet-runtime-recovery-query'
export const PET_RUNTIME_RECOVERED = 'pet-runtime-recovered'

export const PET_SKIN_CHANGE = 'pet-skin-change'
export interface PreparedPetSkin {
  dataUrl?: string
  model: 'wide' | 'slim'
  palmColor: string
}
export interface PetSkinChangeRequest {
  requestId: string
  phase: 'prepare' | 'finish'
  skin?: PreparedPetSkin
}

export function isPetSkinChangeRequest(value: unknown): value is PetSkinChangeRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<PetSkinChangeRequest>
  if (typeof request.requestId !== 'string' || !/^[\w-]{1,128}$/.test(request.requestId)) return false
  if (request.phase !== 'prepare' && request.phase !== 'finish') return false
  if (request.skin === undefined) return true
  if (request.phase !== 'finish' || !request.skin || typeof request.skin !== 'object') return false
  const { dataUrl, model, palmColor } = request.skin
  return (dataUrl === undefined || (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')))
    && (model === 'wide' || model === 'slim')
    && typeof palmColor === 'string' && /^#[\da-f]{6}$/i.test(palmColor)
}
