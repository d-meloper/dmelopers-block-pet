import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import type { ShowWindowRequest, WindowLabel } from './windowNavigation'

import { LISTEN_KEY } from '../constants'
import { createWindowVisibilityQueue } from './windowVisibility'

const orderVisibility = createWindowVisibilityQueue()

export type { ShowWindowRequest, WindowLabel } from './windowNavigation'

const COMMAND = {
  SHOW_WINDOW: 'plugin:custom-window|show_window',
  HIDE_WINDOW: 'plugin:custom-window|hide_window',
  DRAG_MAIN_WINDOW: 'plugin:custom-window|drag_main_window',
  SET_MEMORY_ACTIVE: 'plugin:custom-window|set_memory_active',
  SET_ALWAYS_ON_TOP: 'plugin:custom-window|set_always_on_top',
  SET_PET_CURSOR_EVENTS: 'plugin:custom-window|set_pet_cursor_events',
  POPUP_PET_MENU: 'plugin:custom-window|popup_pet_menu',
  SET_COLOR_PICKER_OPEN: 'plugin:custom-window|set_color_picker_open',
  SET_TASKBAR_VISIBILITY: 'plugin:custom-window|set_taskbar_visibility',
}

export function showWindow(request?: ShowWindowRequest, options: { focus?: boolean } = {}) {
  if (request) {
    return emit(LISTEN_KEY.SHOW_WINDOW, request)
  }

  return orderVisibility(() => invoke<void>(COMMAND.SHOW_WINDOW, { focus: options.focus ?? true }))
}

export function hideWindow(label?: WindowLabel) {
  if (label) {
    return emit(LISTEN_KEY.HIDE_WINDOW, label)
  }

  return orderVisibility(() => invoke<void>(COMMAND.HIDE_WINDOW))
}

export function setWindowMemoryActive(active: boolean) {
  return invoke(COMMAND.SET_MEMORY_ACTIVE, { active })
}

/** On Windows, resolves when the native move loop ends, even with mouse input off. */
export function dragMainWindow(keepInScreen: boolean): Promise<void> {
  return invoke(COMMAND.DRAG_MAIN_WINDOW, { keepInScreen })
}

export function setAlwaysOnTop(alwaysOnTop: boolean) {
  invoke(COMMAND.SET_ALWAYS_ON_TOP, { alwaysOnTop })
}

/** Apply click-through without activating the desktop pet or blurring its editor. */
let cursorEventsOrder: Promise<void> = Promise.resolve()
export function setPetCursorEvents(ignore: boolean): Promise<void> {
  const pending = cursorEventsOrder.then(() => invoke<void>(COMMAND.SET_PET_CURSOR_EVENTS, { ignore }))
  cursorEventsOrder = pending.catch(() => {})
  return pending
}

/** Native owns temporary popup ordering through completion, including page reloads. */
export function popupPetMenu(rid: number): Promise<void> {
  return invoke(COMMAND.POPUP_PET_MENU, { rid })
}

let colorPickerOrder: Promise<void> = Promise.resolve()
/** Preserve open/close order even when an option is switched before IPC returns. */
export function setColorPickerOpen(open: boolean): Promise<void> {
  const pending = colorPickerOrder.then(() => invoke<void>(COMMAND.SET_COLOR_PICKER_OPEN, { open }))
  colorPickerOrder = pending.catch(() => {})
  return pending
}

export async function toggleWindowVisible(label?: WindowLabel) {
  const appWindow = getCurrentWebviewWindow()

  if (appWindow.label !== label) return

  const visible = await appWindow.isVisible()

  if (visible) {
    return hideWindow(label)
  }

  return showWindow(label)
}

export async function setTaskbarVisibility(visible: boolean) {
  invoke(COMMAND.SET_TASKBAR_VISIBILITY, { visible })
}
