import { invoke } from '@tauri-apps/api/core'
import { createPinia } from 'pinia'
import { createApp, watch } from 'vue'

import App from './App.vue'
import { RecoveryWaitError, waitForRecovery } from './features/recovery/wait'
import { editorsLocked, filterBackendSync, initializeStateSafety } from './features/stateSafety'
import { getRuntimeLocaleDirection, i18n } from './locales'
import { createSettingsStorePlugin } from './plugins/settingsStore'
import router from './router'
import { installDiagnostics, reportDiagnostic } from './services/diagnostics'
import { getSystemLanguage, initializeSystemLanguage } from './services/systemLanguage'

import 'virtual:uno.css'

import './assets/css/global.scss'

installDiagnostics()

watch(i18n.global.locale, (locale) => {
  document.documentElement.lang = locale
  document.documentElement.dir = getRuntimeLocaleDirection(locale)
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
  const text = document.createElement('p')
  const guidance = document.createElement('p')
  const renderText = () => {
    const { t } = i18n.global
    title.textContent = t(`startup.web.${timedOut ? 'unconfirmedTitle' : 'failedTitle'}`)
    text.textContent = t(`startup.web.${timedOut ? 'unconfirmedMessage' : 'failedMessage'}`)
    guidance.textContent = t('startup.web.guidance')
  }
  renderText()
  panel.append(title, text, guidance)
  root.replaceChildren(panel)
  panel.focus()
  // A timed-out native barrier must never be retried or create a settings writer.
  // Locale IPC is read-only; retain immediate English guidance if unavailable.
  void initializeSystemLanguage().then(() => {
    if (!panel.isConnected) return
    i18n.global.locale.value = getSystemLanguage()
    panel.lang = getSystemLanguage()
    panel.dir = getRuntimeLocaleDirection(panel.lang)
    renderText()
  })
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
