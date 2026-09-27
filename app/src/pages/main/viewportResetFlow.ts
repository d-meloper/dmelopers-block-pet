export interface ViewportResetFlowCallbacks {
  centerViewport: () => Promise<boolean>
  isCurrent: () => boolean
  settleSelection: () => Promise<boolean>
}

export async function runViewportResetFlow({
  centerViewport,
  isCurrent,
  settleSelection,
}: ViewportResetFlowCallbacks): Promise<boolean> {
  if (!isCurrent()) return false

  const selectionSettled = await settleSelection()
  if (!selectionSettled || !isCurrent()) return false

  const centered = await centerViewport()
  return centered && isCurrent()
}
