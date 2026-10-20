/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

import type { Language, LanguagePreference } from '@/locales/languageBranch'
import type { DistributionChannel } from '@/services/distribution'

import externalLinks from '@/config/externalLinks.json'
import en from '@/locales/en-US.json'
import ko from '@/locales/ko-KR.json'
import { resolveLanguage, selectByLanguage } from '@/locales/languageBranch'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function harness(channel: DistributionChannel = 'github') {
  const preference = Vue.ref<LanguagePreference>('system')
  const systemLanguage = Vue.ref<Language>('ko-KR')
  const language = Vue.computed(() => resolveLanguage(preference.value, systemLanguage.value))
  const opened: string[] = []
  const calls: string[] = []
  const errors: string[] = []
  const diagnostics: string[] = []
  const document = { hidden: false }
  let mounted: () => Promise<void> = async () => {}
  let unmounted = () => {}
  let closed = () => {}
  let visibilityChanged = () => {}
  let released = 0
  let visibleBox = true
  let openFails = false
  let review = async (): Promise<string> => 'succeeded'
  let visible = async () => true
  let info = async () => ({ channel })
  let registration = Promise.resolve()
  interface Controls {
    support: () => Promise<void>
    channel: Vue.Ref<DistributionChannel | undefined>
    busy: Vue.Ref<boolean>
    box: Vue.Ref<HTMLElement | undefined>
  }
  let controls!: Controls
  const source = readFileSync(new URL('./SupportMe.vue', import.meta.url), 'utf8')
    .replace('</script>', '\ndefineExpose({ support, channel, busy, box })\n</script>')
  const component = compileScript(parse(source).descriptor, { id: 'about-support-me-test', inlineTemplate: true })
  const module = { exports: {} as { default: { setup: (props: object, context: object) => (context: object, cache: unknown[]) => Vue.VNode } } }
  const translate = (key: string) => {
    const messages = selectByLanguage(language.value, ko, en)
    return key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], messages) as string
  }
  const mocks: Record<string, unknown> = {
    'vue': { ...Vue, onMounted: (callback: typeof mounted) => {
      mounted = callback
    }, onBeforeUnmount: (callback: typeof unmounted) => {
      unmounted = callback
    } },
    'vue-i18n': { useI18n: () => ({ t: translate }) },
    '@vueuse/core': { useEventListener: (target: unknown, event: string, callback: () => void) => {
      assert.equal(target, document)
      assert.equal(event, 'visibilitychange')
      visibilityChanged = callback
    } },
    '@tauri-apps/api/core': { invoke: async (command: string, args: unknown) => {
      assert.equal(command, 'request_store_review')
      assert.equal(args, undefined)
      calls.push('review')
      return review()
    } },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({
      listen: async (event: string, callback: () => void) => {
        assert.equal(event, 'tauri://close-requested')
        closed = callback
        await registration
        return () => {
          released++
        }
      },
      isVisible: () => visible(),
    }) },
    '@tauri-apps/plugin-opener': { openUrl: async (url: string) => {
      opened.push(url)
      if (openFails) throw new Error('OPENER_FAILED')
    } },
    'ant-design-vue': { Button: 'button', message: { error: (text: string) => errors.push(text) } },
    '@/composables/useAppLanguage': { useAppLanguage: () => ({ select: <T>(korean: T, global: T) => selectByLanguage(language.value, korean, global) }) },
    '@/config/externalLinks.json': { default: externalLinks },
    '@/services/diagnostics': { reportDiagnostic: (_level: string, operation: string) => diagnostics.push(operation) },
    '@/services/distribution': { getDistributionInfo: async () => {
      calls.push('info')
      return info()
    } },
  }
  runInNewContext(ts.transpileModule(component.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module,
    exports: module.exports,
    document,
    require: (id: string) => {
      assert.ok(id in mocks, id)
      return mocks[id]
    },
    setTimeout: () => {
      throw new Error('A review dialog must not have a UI timeout')
    },
  })
  const render = module.exports.default.setup({}, { expose: (value: Controls) => {
    controls = value
  } })
  controls.box.value = { getClientRects: () => visibleBox ? [{}] : [] } as unknown as HTMLElement
  return {
    ...controls,
    calls,
    opened,
    errors,
    diagnostics,
    preference,
    systemLanguage,
    mount: () => mounted(),
    unmount: () => unmounted(),
    close: () => closed(),
    hide: () => {
      document.hidden = true
      visibilityChanged()
    },
    show: () => {
      document.hidden = false
      visibilityChanged()
    },
    render: () => render({}, []),
    released: () => released,
    setReview: (value: typeof review) => {
      review = value
    },
    setInfo: (value: typeof info) => {
      info = value
    },
    setVisible: (value: typeof visible) => {
      visible = value
    },
    setBoxVisible: (value: boolean) => {
      visibleBox = value
    },
    failOpen: (value: boolean) => {
      openFails = value
    },
    pauseRegistration: (value: Promise<void>) => {
      registration = value
    },
  }
}

it('keeps the box and effects absent until native channel resolution, including setup failure', async () => {
  const h = harness()
  assert.equal(h.render().type, Vue.Comment)
  await h.support()
  assert.deepEqual(h.calls, [])
  h.setInfo(async () => {
    throw new Error('CHANNEL_UNAVAILABLE')
  })
  await h.mount()
  assert.equal(h.channel.value, undefined)
  assert.equal(h.render().type, Vue.Comment)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.diagnostics, ['about.support_setup'])
})

for (const channel of ['github', 'development', 'test'] as const) {
  it(`opens the exact Korean/English destinations reactively for ${channel}`, async () => {
    const h = harness(channel)
    await h.mount()
    const korean = 'https://app.notion.com/p/aismash/3602dc0bb4ae80fcbcb8efd9390372fa?source=copy_link'
    await h.support()
    h.preference.value = 'en-US'
    await h.support()
    h.systemLanguage.value = 'en-US'
    h.preference.value = 'system'
    await h.support()
    h.preference.value = 'ko-KR'
    await h.support()
    assert.deepEqual(h.opened, [korean, 'https://ko-fi.com/dmeloper', 'https://ko-fi.com/dmeloper', korean])
    assert.equal(h.calls.includes('review'), false)
    h.unmount()
    assert.equal(h.released(), 1)
  })
}

it('renders the exact approved description and support title for both channels and languages', async () => {
  for (const channel of ['store', 'github'] as const) {
    const h = harness(channel)
    await h.mount()
    for (const locale of ['ko-KR', 'en-US'] as const) {
      h.preference.value = locale
      const nodes = h.render().children as Vue.VNode[]
      const expected = channel === 'store'
        ? locale === 'ko-KR' ? '이 프로그램은 앞으로도 무료로 운영됩니다. 리뷰를 남겨 제 활동을 응원해주세요.' : 'This program will always be free. Please support my work by leaving a review.'
        : locale === 'ko-KR' ? '이 프로그램은 앞으로도 무료로 운영됩니다. 제 활동을 응원해주세요.' : 'This program will always be free. Please support my work.'
      assert.equal(nodes[1].children, expected)
      const slot = nodes[0].children as Vue.VNode[]
      assert.equal(String(slot[0].children).trim(), locale === 'ko-KR' ? '개발자 응원하기' : 'Support the developer')
    }
    h.unmount()
  }
})

for (const outcome of ['succeeded', 'cancelled']) {
  it(`does not open a page after Store review ${outcome}`, async () => {
    const h = harness('store')
    h.setReview(async () => outcome)
    await h.mount()
    await h.support()
    assert.deepEqual(h.calls, ['info', 'review'])
    assert.deepEqual(h.opened, [])
    assert.deepEqual(h.errors, [])
    assert.equal(h.busy.value, false)
    h.unmount()
  })
}

it('opens only the localized Store web page after a confirmed unavailable result', async () => {
  const h = harness('store')
  h.setReview(async () => 'unavailable')
  await h.mount()
  await h.support()
  h.preference.value = 'en-US'
  await h.support()
  h.preference.value = 'system'
  h.systemLanguage.value = 'en-US'
  await h.support()
  assert.deepEqual(h.opened, [externalLinks.korean.microsoftStore, externalLinks.global.microsoftStore, externalLinks.global.microsoftStore])
  assert.equal(h.calls.filter(call => call === 'review').length, 3)
  h.unmount()
})

for (const outcome of ['unknown', 'rejected']) {
  it(`keeps uncertain Store IPC ${outcome} separate from a confirmed failure`, async () => {
    const h = harness('store')
    h.setReview(async () => {
      if (outcome === 'rejected') throw new Error('IPC_UNCONFIRMED')
      return 'unexpected'
    })
    await h.mount()
    await h.support()
    assert.deepEqual(h.opened, [])
    assert.equal(h.errors.length, 1)
    assert.equal(h.busy.value, false)
    h.unmount()
  })
}

it('retains a single untimed request and its click-time fallback language until actual completion', async () => {
  const h = harness('store')
  const pending = deferred<string>()
  h.setReview(() => pending.promise)
  await h.mount()
  const first = h.support()
  await h.support()
  assert.equal(h.busy.value, true)
  assert.equal(h.calls.filter(call => call === 'review').length, 1)
  h.preference.value = 'en-US'
  pending.resolve('unavailable')
  await first
  assert.deepEqual(h.opened, [externalLinks.korean.microsoftStore])
  assert.equal(h.busy.value, false)
  h.unmount()
})

for (const end of ['close', 'hide', 'unmount'] as const) {
  it(`ignores a late unavailable result after ${end}, even if shown again`, async () => {
    const h = harness('store')
    const pending = deferred<string>()
    h.setReview(() => pending.promise)
    await h.mount()
    const request = h.support()
    h[end]()
    h.show()
    await h.support()
    assert.equal(h.calls.filter(call => call === 'review').length, 1)
    pending.resolve('unavailable')
    await request
    assert.deepEqual(h.opened, [])
    assert.deepEqual(h.errors, [])
    if (end !== 'unmount') h.unmount()
  })
}

it('does not launch from a hidden native window, hidden tab or a close during visibility readback', async () => {
  const h = harness('store')
  h.setReview(async () => 'unavailable')
  await h.mount()
  h.setVisible(async () => false)
  await h.support()
  h.setVisible(async () => true)
  h.setBoxVisible(false)
  await h.support()
  h.setBoxVisible(true)
  const visible = deferred<boolean>()
  const checking = deferred<void>()
  h.setVisible(() => {
    checking.resolve()
    return visible.promise
  })
  const pending = h.support()
  await checking.promise
  h.close()
  visible.resolve(true)
  await pending
  assert.deepEqual(h.opened, [])
  h.unmount()
})

it('reports failed page opening without a success claim and permits a deliberate retry', async () => {
  const h = harness('store')
  h.setReview(async () => 'unavailable')
  await h.mount()
  h.failOpen(true)
  await h.support()
  assert.equal(h.errors.length, 1)
  assert.equal(h.busy.value, false)
  h.failOpen(false)
  await h.support()
  assert.equal(h.opened.length, 2)
  assert.equal(h.calls.filter(call => call === 'review').length, 2)
  h.unmount()
})

it('releases a late native subscription without loading a retired component', async () => {
  const h = harness()
  const registration = deferred<void>()
  h.pauseRegistration(registration.promise)
  const mounting = h.mount()
  h.unmount()
  registration.resolve()
  await mounting
  assert.equal(h.released(), 1)
  assert.equal(h.channel.value, undefined)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.opened, [])
})
