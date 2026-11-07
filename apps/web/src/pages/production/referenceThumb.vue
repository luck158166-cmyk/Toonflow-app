<template>
  <div class="referenceThumb"><img v-if="url" :src="url" :alt="label" @error="imageFailed" /><span v-else>{{ failed ? '参考图暂不可读，请刷新图库' : '读取原图…' }}</span></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import productionApi from "@/lib/productionApi";
const props = defineProps<{ directory: string; projectId: string; referenceId: string; label: string }>();
const url = ref("");
const failed = ref(false);
let version = 0;
function release() { if (url.value) URL.revokeObjectURL(url.value); url.value = ""; }
function imageFailed() { failed.value = true; release(); }
watch(() => [props.directory, props.projectId, props.referenceId], async () => {
  const request = ++version; release(); failed.value = false;
  try {
    const blob = await productionApi.readAssetReference(props.directory, props.projectId, props.referenceId);
    if (request === version) url.value = URL.createObjectURL(blob);
  } catch { if (request === version) failed.value = true; }
}, { immediate: true });
onBeforeUnmount(() => { version++; release(); });
</script>

<style scoped lang="scss">
.referenceThumb { display: grid; place-items: center; width: 100%; height: 100%; min-height: 60px; overflow: hidden; border-radius: inherit; background: #edf5fc; img { width: 100%; height: 100%; object-fit: contain; } span { padding: 8px; color: #7b90a5; font-size: 11px; text-align: center; } }
</style>
