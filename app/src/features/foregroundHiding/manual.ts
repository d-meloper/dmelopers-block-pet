import { isDesktopPetVisible } from '@/features/broadcast/visibility'

/** Preserve the basic shortcut's broadcast meaning; automatic hiding alone is a temporary mask. */
export function toggledBasicVisibility(
  basicVisible: boolean,
  broadcast: { enabled: boolean, showOnDesktop?: boolean },
  automaticallySuppressed: boolean,
): boolean {
  return basicVisible && isDesktopPetVisible(basicVisible, broadcast) && automaticallySuppressed
    ? true
    : !basicVisible
}
