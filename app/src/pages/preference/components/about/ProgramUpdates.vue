<script setup lang="ts">
import { usePreferenceUpdates } from '@/composables/usePreferenceUpdates'

import AutomaticUpdates from './AutomaticUpdates.vue'
import ManualUpdates from './ManualUpdates.vue'

const { automatic: enabled } = usePreferenceUpdates()
</script>

<template>
  <AutomaticUpdates v-if="enabled === true" />
  <ManualUpdates v-else-if="enabled === false" />
</template>
