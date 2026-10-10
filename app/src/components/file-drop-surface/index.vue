<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <div class="file-drop-surface file-drop-surface-active">
    <div class="file-drop-content">
      <span
        aria-hidden="true"
        class="file-drop-icon i-lucide:file-up"
      />
      <strong class="file-drop-title">{{ title }}</strong>
    </div>
  </div>
</template>

<style scoped>
.file-drop-surface {
  container-type: size;
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  border: 2px dashed var(--ant-color-primary);
  border-radius: 18px;
  background: color-mix(in srgb, var(--ant-color-primary-bg) 50%, transparent);
  color: var(--ant-color-text);
}

.file-drop-content {
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 320px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  box-sizing: border-box;
  padding: 16px;
  text-align: center;
}

.file-drop-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: var(--ant-color-primary-text);
}

.file-drop-title {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

@container (max-height: 120px) {
  .file-drop-content {
    gap: 8px;
    padding: 8px;
  }

  .file-drop-icon {
    width: 24px;
    height: 24px;
  }

  .file-drop-title {
    font-size: 14px;
  }
}
</style>
