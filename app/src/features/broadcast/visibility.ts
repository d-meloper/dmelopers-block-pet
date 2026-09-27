/** Broadcast hiding is a desktop-only mask; presets still own basic visibility. */
export function isDesktopPetVisible(
  visible: boolean,
  broadcast: { enabled: boolean, showOnDesktop?: boolean },
): boolean {
  return visible && (!broadcast.enabled || broadcast.showOnDesktop !== false)
}
