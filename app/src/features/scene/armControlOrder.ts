import { ref } from 'vue'

// UI-only rotation snapshot: commit on gesture completion or preset replacement.
export const armControlOrderRotation = ref(0)

export function commitArmControlOrderRotation(degrees: number): void {
  if (Number.isFinite(degrees)) armControlOrderRotation.value = degrees
}
