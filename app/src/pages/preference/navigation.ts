import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { preferenceQuery } from '@/plugins/windowNavigation'

export function usePreferenceNavigation() {
  const route = useRoute()
  const router = useRouter()
  const current = computed({
    get: () => {
      const tab = typeof route.query.tab === 'string' ? Number(route.query.tab) : 0
      return Number.isInteger(tab) && tab >= 0 && tab < 8 ? tab : 0
    },
    set: (tab: number) => {
      void router.replace({ query: { ...route.query, tab: String(tab) } })
    },
  })
  const innerView = computed(() => route.query.view === 'skin-library' ? 'skin-library' : undefined)

  function closeInnerView() {
    return router.replace({ query: { ...preferenceQuery(route.query, 'preferences'), tab: '1' } })
  }

  function openSkinLibrary() {
    return router.replace({ query: preferenceQuery(route.query, 'skin-library') })
  }

  return { current, innerView, closeInnerView, openSkinLibrary }
}
