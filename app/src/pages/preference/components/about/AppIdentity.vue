<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  stackActions?: boolean
}>()
</script>

<template>
  <header class="app-identity">
    <img
      alt=""
      aria-hidden="true"
      class="app-identity-icon"
      src="/logo.png"
    >
    <div class="app-identity-heading">
      <h1>{{ title }}</h1>
      <slot name="developer" />
    </div>
    <div
      class="app-identity-version"
      :class="{ 'app-identity-version-stacked': stackActions }"
    >
      <slot name="description">
        {{ description }}
      </slot>
      <div class="app-identity-actions">
        <slot />
      </div>
    </div>
  </header>
</template>

<style scoped>
.app-identity {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 16px 28px;
  text-align: center;
}

.app-identity-icon {
  width: 176px;
  height: 176px;
  object-fit: contain;
  filter: drop-shadow(0 8px 12px rgb(0 0 0 / 12%));
}

.app-identity-heading {
  margin-top: 22px;
}

.app-identity-heading h1 {
  margin: 0 0 4px;
  color: var(--ant-color-text);
  font-size: clamp(22px, 4vw, 28px);
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.8px;
  overflow-wrap: anywhere;
}

.app-identity-version {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  margin-top: 14px;
  color: var(--ant-color-text-secondary);
  font-size: 18px;
  line-height: 1.7;
}

.app-identity-actions {
  flex-shrink: 0;
}

.app-identity-version-stacked {
  flex-direction: column;
}
</style>
