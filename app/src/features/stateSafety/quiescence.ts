/**
 * Each barrier owns a generation; a late continuation cannot refreeze a
 * participant after the caller cancels or replaces that request.
 */
export function createQuiescenceOwner() {
  let current: string | undefined
  let generation = 0
  return {
    active() {
      return current !== undefined
    },
    begin(requestId: string) {
      if (current !== undefined) return () => false
      current = requestId
      const expected = ++generation
      return () => current === requestId && generation === expected
    },
    release(requestId?: string) {
      if (requestId && current !== requestId) return false
      current = undefined
      generation++
      return true
    },
  }
}
