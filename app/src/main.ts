import { invoke } from '@tauri-apps/api/core'
import { createPinia } from 'pinia'
import { createApp, watch } from 'vue'

import App from './App.vue'
import { RecoveryWaitError, waitForRecovery } from './features/recovery/wait'
import { editorsLocked, filterBackendSync, initializeStateSafety } from './features/stateSafety'
import { i18n } from './locales'
import { createSettingsStorePlugin } from './plugins/settingsStore'
import router from './router'
import { installDiagnostics, reportDiagnostic } from './services/diagnostics'
import { initializeSystemLanguage } from './services/systemLanguage'

import 'virtual:uno.css'

import './assets/css/global.scss'

installDiagnostics()

watch(i18n.global.locale, (locale) => {
  document.documentElement.lang = locale
}, { immediate: true })

async function bootstrap() {
  await invoke('await_native_startup')
  await initializeStateSafety()
  await initializeSystemLanguage()
  const pinia = createPinia()
  pinia.use(createSettingsStorePlugin({
    isSavingAllowed: () => !editorsLocked.value,
    beforeBackendSync: filterBackendSync,
  }))
  const app = createApp(App)
  app.config.errorHandler = error => reportDiagnostic('error', 'application.vue', error)
  app.config.warnHandler = message => reportDiagnostic('warn', 'application.vue_warning', message)
  app.use(router).use(pinia).use(i18n).mount('#app')
}

let startupTimedOut = false
function showStartupFailure(error: unknown) {
  reportDiagnostic('error', 'application.bootstrap', error)
  // Do not create stores or writers when the shared save barrier cannot be initialized safely.
  const root = document.querySelector('#app')
  if (!root) return
  const panel = document.createElement('dialog')
  panel.open = true
  panel.tabIndex = -1
  panel.setAttribute('aria-labelledby', 'block-pet-startup-failure-title')
  panel.style.cssText = 'padding:20px;font:15px/1.7 sans-serif;overflow-wrap:anywhere;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);box-sizing:border-box;overflow:auto;background:Canvas;color:CanvasText'
  const title = document.createElement('h1')
  title.id = 'block-pet-startup-failure-title'
  const timedOut = error instanceof RecoveryWaitError && error.reason === 'timeout'
  title.textContent = timedOut ? 'Startup not confirmed / 앱 시작을 확인하지 못했습니다' : 'Unable to start / 앱을 시작하지 못했습니다'
  const text = document.createElement('p')
  text.textContent = timedOut
    ? 'Startup may still be running. Wait for its response before restarting. 앱 시작 요청이 계속 진행 중일 수 있습니다. 응답을 기다린 뒤 재실행하세요.'
    : 'Close and restart the app, keeping your existing settings and user data. 기존 설정과 사용자 데이터를 유지하고 앱을 종료한 뒤 다시 실행하세요.'
  const guidance = document.createElement('p')
  guidance.textContent = 'If the cause remains unknown, try rebooting your computer and reinstalling the app. Preserve existing settings and user data. 문제 원인을 찾을 수 없다면 컴퓨터 재부팅, 프로그램 재설치를 시도해 주세요. 기존 설정과 사용자 데이터를 유지하세요.'
  panel.append(title, text, guidance)
  root.replaceChildren(panel)
  panel.focus()
}
const startup = bootstrap()
// Bound observation only: never repeat barrier/store initialization on timeout.
void waitForRecovery(startup, 15_000).catch((error) => {
  startupTimedOut = error instanceof RecoveryWaitError && error.reason === 'timeout'
  showStartupFailure(error)
})
void startup.catch((error) => {
  if (startupTimedOut) showStartupFailure(error)
})
