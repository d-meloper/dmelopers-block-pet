import { invoke } from '@tauri-apps/api/core'
import { createPlugin } from '@tauri-store/pinia'
import { createPinia } from 'pinia'
import { createApp, watch } from 'vue'

import App from './App.vue'
import { editorsLocked, filterBackendSync, initializeStateSafety } from './features/stateSafety'
import { i18n } from './locales'
import router from './router'
import { installDiagnostics, reportDiagnostic } from './services/diagnostics'

import 'virtual:uno.css'

import './assets/css/global.scss'

installDiagnostics()

watch(i18n.global.locale, (locale) => {
  document.documentElement.lang = locale
}, { immediate: true })

async function bootstrap() {
  await invoke('await_native_startup')
  await initializeStateSafety()
  const pinia = createPinia()
  pinia.use(context => createPlugin({ saveOnChange: true, save: !editorsLocked.value, hooks: { beforeBackendSync: filterBackendSync } })(context))
  const app = createApp(App)
  app.config.errorHandler = error => reportDiagnostic('error', 'application.vue', error)
  app.config.warnHandler = message => reportDiagnostic('warn', 'application.vue_warning', message)
  app.use(router).use(pinia).use(i18n).mount('#app')
}

void bootstrap().catch((error) => {
  reportDiagnostic('error', 'application.bootstrap', error)
  // Do not create stores or writers when the shared save barrier cannot be initialized safely.
  const root = document.querySelector('#app')
  if (!root) return
  const panel = document.createElement('dialog')
  panel.open = true
  panel.style.cssText = 'padding:28px;font:15px/1.7 sans-serif;overflow-wrap:anywhere'
  const title = document.createElement('h1')
  title.textContent = 'Unable to start / 앱을 시작하지 못했습니다'
  const text = document.createElement('p')
  text.textContent = 'Settings have not been changed. Close and restart the app. 설정을 변경하지 않았습니다. 앱을 종료한 뒤 다시 실행하세요.'
  panel.append(title, text)
  root.replaceChildren(panel)
})
