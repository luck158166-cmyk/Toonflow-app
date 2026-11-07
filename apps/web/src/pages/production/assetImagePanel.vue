<template>
  <section class="assetImagePanel">
    <h4>从资产设定生成原图</h4>
    <p class="hint">沿用已锁定的描述生成一张候选图，确认后加入参考图库。已有图片继续保留。</p>
    <el-input v-model="visualStyle" :disabled="busy" maxlength="120" placeholder="统一画风；留空沿用分镜画风" aria-label="资产图片画风" />
    <div class="actions"><el-button type="primary" :disabled="!target.locked" :loading="busy" @click="inspect">检查图片方案与费用</el-button></div>
    <template v-if="preview">
      <template v-if="preview.existingTask?.requestStarted">
        <p>已有生成任务：{{ stateLabel(preview.existingTask.state) }}。恢复时只核对原任务。</p>
        <el-button :loading="busy" @click="recover">恢复并读取原图</el-button>
        <div v-if="imageUrl" class="candidate"><img :src="imageUrl" alt="模型生成的资产候选原图" @load="imageReady = true" @error="imageReady = false" /></div>
        <p v-if="preview.adoptedReferenceId" class="adopted">这张原图已进入参考图库。</p>
        <template v-else-if="imageUrl">
          <el-checkbox v-model="rightsConfirmed" :disabled="busy">我已核对形象与设定、确认使用权，同意新增参考图版本</el-checkbox>
          <div class="actions"><el-button type="primary" :disabled="!rightsConfirmed || !imageReady" :loading="busy" @click="adopt">确认采用此原图</el-button></div>
        </template>
      </template>
      <template v-else>
        <div v-if="preview.blockers.length" class="notice"><p v-for="item in preview.blockers" :key="item">{{ item }}</p></div>
        <div class="actions"><studioSettings panel="mediaModel" @closed="inspect" /><el-button @click="emit('openCosts')">设置图片价格与预算</el-button></div>
        <details><summary>查看将发送的提示词与参数</summary><pre>{{ preview.requestJson }}</pre><p>{{ preview.destination }}</p></details>
        <template v-if="preview.price">
          <p>Seedream 5.0 pro · 单张原图 · 预留 ¥{{ money(preview.price.amountMicros) }} · <a :href="preview.price.sourceUrl" target="_blank" rel="noopener noreferrer">价格依据</a></p>
          <p class="hint">资产供全剧复用，本次费用归入第 {{ preview.episodeNumber }} 集。按已确认单图上限预留，实际费用待平台对账。</p>
          <el-input v-model="maxCost" :disabled="busy" inputmode="decimal" placeholder="本次人民币授权上限" aria-label="资产图授权上限" />
          <el-checkbox v-model="approved" :disabled="busy">授权向火山方舟发送此提示词，生成 1 张图片，上限 ¥{{ maxCost || '未填写' }}</el-checkbox>
          <div class="actions"><el-button type="primary" :disabled="!canRun" :loading="busy" @click="run">授权并生成原图</el-button></div>
        </template>
      </template>
    </template>
    <p v-if="failure" class="notice" role="alert">{{ failure }}</p><p v-if="receipt" role="status">{{ receipt }}</p>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import productionApi, { type AssetImageRequest, type AssetImagePreview, type ReferenceTarget, type ReferenceRole } from "@/lib/productionApi";
import studioSettings from "./studioSettings.vue";
const props = defineProps<{ directory: string; projectId: string; target: ReferenceTarget; role: ReferenceRole }>();
const emit = defineEmits<{ changed: []; openCosts: [] }>();
const visualStyle = ref(""); const maxCost = ref(""); const approved = ref(false); const rightsConfirmed = ref(false);
const preview = ref<AssetImagePreview | null>(null); const busy = ref(false); const failure = ref(""); const receipt = ref("");
const imageUrl = ref(""); const imageReady = ref(false); let version = 0;
const costMicros = computed(() => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(maxCost.value.trim())) return 0;
  const [whole, fraction = ""] = maxCost.value.trim().split(".");
  const value = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0")); return Number.isSafeInteger(value) ? value : 0;
});
const canRun = computed(() => !busy.value && approved.value && preview.value?.canSubmit && !!preview.value.price && costMicros.value >= preview.value.price.amountMicros);
function releaseImage() { if (imageUrl.value) URL.revokeObjectURL(imageUrl.value); imageUrl.value = ""; imageReady.value = false; rightsConfirmed.value = false; }
function clear() { version++; preview.value = null; busy.value = false; failure.value = receipt.value = ""; approved.value = false; releaseImage(); }
watch(() => [props.directory, props.projectId, props.target.entityId, props.target.entityHash, props.role, visualStyle.value], clear);
watch(maxCost, () => { approved.value = false; });
onBeforeUnmount(() => { version++; releaseImage(); });
function request(): AssetImageRequest { return { directory: props.directory, projectId: props.projectId, entityKind: props.target.entityKind, entityId: props.target.entityId, role: props.role, visualStyle: visualStyle.value }; }
function money(value: number) { return (value / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); }
function stateLabel(state: string) { return ({ succeeded: "已保存", running: "处理中", reconcile_required: "等待核对", queued: "等待预算" } as Record<string, string>)[state] ?? "已提交"; }
async function perform(action: (input: AssetImageRequest) => Promise<string | void>, changed = false) {
  if (busy.value) return;
  const current = ++version; const input = request(); busy.value = true; failure.value = ""; approved.value = false; releaseImage();
  try {
    const message = await action(input); const result = await productionApi.previewAssetImage(input);
    if (current !== version) return;
    preview.value = result; receipt.value = message || "";
    if (result.existingTask?.state === "succeeded") {
      const blob = await productionApi.readAssetImage(input.directory, input.projectId, result.existingTask.id);
      if (current !== version) return; imageUrl.value = URL.createObjectURL(blob);
    }
    if (changed) emit("changed");
  } catch (cause) { if (current === version) failure.value = axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "资产图片操作失败"; }
  finally { if (current === version) busy.value = false; }
}
function inspect() { return perform(async () => {}); }
function run() {
  if (!canRun.value || !preview.value) return;
  const approval = { approved: true as const, maxCalls: 1 as const, planHash: preview.value.planHash, maxCostMicros: costMicros.value };
  return perform(async input => (await productionApi.runAssetImage(input, approval)).message);
}
function recover() { const id = preview.value?.existingTask?.id; if (id) return perform(async input => (await productionApi.recoverAssetImage(input.directory, input.projectId, id)).message); }
function adopt() {
  const id = preview.value?.existingTask?.id;
  if (id && rightsConfirmed.value && imageReady.value) return perform(input => productionApi.adoptAssetImage(input.directory, input.projectId, id), true);
}
</script>

<style scoped lang="scss">
.assetImagePanel {
  margin: 18px 0; padding: 18px; border: 1px solid #d6e8fa; background: #f4f9ff; border-radius: 12px;
  h4 { margin: 0 0 10px; } .hint { color: #60788f; font-size: 13px; line-height: 1.8; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .notice { padding: 12px; border-radius: 8px; color: #875a24; background: #fff5e5; }
  details { margin: 16px 0; summary, a { color: #1686db; } pre, p { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; } }
  .candidate { height: 300px; margin: 16px 0; background: white; border-radius: 10px; img { height: 100%; width: 100%; object-fit: contain; } }
  .adopted { color: #287963; }
  :deep(.el-checkbox) { white-space: normal; height: auto; margin-top: 12px; .el-checkbox__label { white-space: normal; line-height: 1.7; } }
}
</style>
