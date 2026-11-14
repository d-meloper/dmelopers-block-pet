import type { Ref } from 'vue'

import { computed, ref, watch } from 'vue'

/** Serialize the three preference reminders, including their closing animations. */
export function createPreferencePromptPriority(deps: {
  broadcastOpen: Readonly<Ref<boolean>>
  broadcastActive: Readonly<Ref<boolean>>
  updateVersion: Readonly<Ref<string | undefined>>
  updateBusy: Readonly<Ref<boolean>>
  updateHandoff: Readonly<Ref<boolean>>
  adminOpen: Readonly<Ref<boolean>>
  blockAdmin: (blocked: boolean) => void
}) {
  const updateActive = ref(false)
  const adminActive = ref(false)
  const updateVersion = computed(() => deps.broadcastActive.value || adminActive.value
    ? undefined
    : deps.updateVersion.value)
  const broadcastOpen = computed(() => deps.broadcastOpen.value && !updateActive.value && !adminActive.value)
  const stops = [
    watch(updateVersion, (version) => {
      if (version) updateActive.value = true
    }, { immediate: true, flush: 'post' }),
    watch(deps.adminOpen, (open) => {
      if (open) adminActive.value = true
    }, { immediate: true, flush: 'post' }),
    watch(
      () => deps.broadcastActive.value || deps.updateBusy.value || !!deps.updateVersion.value
        || updateActive.value || deps.updateHandoff.value,
      deps.blockAdmin,
      { immediate: true, flush: 'sync' },
    ),
  ]
  return {
    updateVersion,
    broadcastOpen,
    finishUpdate: () => {
      if (!updateVersion.value) updateActive.value = false
    },
    finishAdmin: () => {
      if (!deps.adminOpen.value) adminActive.value = false
    },
    dispose: () => stops.forEach(stop => stop()),
  }
}
