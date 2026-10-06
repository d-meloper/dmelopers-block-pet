export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  SEMANTIC_INPUT: 'semantic-input',
  CAMERA_ELEVATION_CHANGED: 'camera-elevation-changed',
  CAMERA_DISTANCE_CHANGED: 'camera-distance-changed',
  PET_PRESET_CHANGED: 'pet-preset-changed',
  MENU_VIEWPORT_SETTING_REQUEST: 'menu-viewport-setting-request',
  MOUSE_SETTING_REQUEST: 'mouse-setting-request',
  MOUSE_SETTING_RESPONSE: 'mouse-setting-response',
  VIEWPORT_INTERACTION_CHANGED: 'viewport-interaction-changed',
  MAIN_VIEWPORT_RESET_REQUEST: 'main-viewport-reset-request',
  MAIN_VIEWPORT_RESET_COMPLETE: 'main-viewport-reset-complete',
}

export const INVOKE_KEY = {
  START_DEVICE_LISTENING: 'start_device_listening',
  SET_DEVICE_MOUSE_ENABLED: 'set_device_mouse_enabled',
  SET_DEVICE_INPUT_ACTIVE: 'set_device_input_active',
  STOP_DEVICE_LISTENING: 'stop_device_listening',
  PRIME_APP_PERFORMANCE_SAMPLER: 'prime_app_performance_sampler',
  SAMPLE_APP_PERFORMANCE: 'sample_app_performance',
  FETCH_MINECRAFT_SKIN: 'fetch_minecraft_skin',
  LIST_SKIN_LIBRARY: 'list_skin_library',
  STORE_SKIN_LIBRARY_ENTRY: 'store_skin_library_entry',
  READ_SKIN_LIBRARY_ENTRY: 'read_skin_library_entry',
  READ_LOCAL_SKIN_FILE: 'read_local_skin_file',
  RENAME_SKIN_LIBRARY_ENTRY: 'rename_skin_library_entry',
  DELETE_SKIN_LIBRARY_ENTRIES: 'delete_skin_library_entries',
  CLEANUP_SKIN_LIBRARY: 'cleanup_skin_library',
  CLEAR_SKIN_LIBRARY: 'clear_skin_library',
}

export { APP_DISPLAY_NAME } from './branding'

export const LANGUAGE = {
  KO_KR: 'ko-KR',
  EN_US: 'en-US',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
} as const
