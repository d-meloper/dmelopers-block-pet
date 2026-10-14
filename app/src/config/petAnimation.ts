export type PetAnimationMode = 'default' | 'headbutt'

export function normalizePetAnimationMode(value: unknown): PetAnimationMode {
  return value === 'headbutt' ? 'headbutt' : 'default'
}
