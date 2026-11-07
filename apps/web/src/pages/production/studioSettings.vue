<template>
  <el-button @click="openSettings">模型与设置</el-button>
  <settings ref="settingsPanel" v-model="settingsVisible" class="studioSettingsDialog" />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import settings from "@/components/settings/index.vue";
const props = withDefaults(defineProps<{ panel?: "languageModel" | "mediaModel" }>(), { panel: "languageModel" });

const settingsPanel = ref<InstanceType<typeof settings>>();
const settingsVisible = ref(false);
const emit = defineEmits<{ closed: [] }>();
watch(settingsVisible, (visible, previous) => { if (!visible && previous) emit("closed"); });

function openSettings() {
  if (!settingsPanel.value?.openPanel(props.panel)) settingsVisible.value = true;
}
</script>

<style lang="scss">
.studioSettingsDialog {
  color-scheme: light;
  --el-bg-color-page: #f4f7fb;
  --el-bg-color: #fff;
  --el-bg-color-overlay: #fff;
  --el-fill-color-blank: #fff;
  --el-fill-color-light: #f2f7fc;
  --el-border-color: #d9e4ef;
  --el-border-color-light: #e3ebf4;
  --el-text-color-primary: #1d2d42;
  --el-text-color-regular: #3c5067;
  --el-text-color-secondary: #697b8f;
  --el-color-primary: #1689ec;
  --el-color-primary-light-9: #eaf5ff;
  color: var(--el-text-color-primary);
  background: #fff;
}
</style>
