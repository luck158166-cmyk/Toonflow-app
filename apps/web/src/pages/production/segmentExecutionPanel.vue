<template>
  <section class="segmentExecutionPanel">
    <div class="actions"><el-button type="primary" :disabled="!saved" :loading="busy" @click="inspect">检查投产条件与费用</el-button><span v-if="!saved">先保存本集片段方案</span></div>
    <div v-if="preview" class="preflightCard">
      <template v-if="preview.existingTask?.requestStarted">
        <p>本片段已有生成任务，继续操作会核对和恢复该任务，不重复提交。</p>
        <el-button type="primary" :loading="busy" @click="recover">恢复并核对已有任务</el-button>
      </template>
      <template v-else>
        <h4>投产前复核</h4><p class="hint">核对本片段上方的时间线和提示词，以及以下原图。此记录用于半自动制作；生成后仍须检查实际画面与音频。</p>
        <div class="referenceGrid"><figure v-for="slot in preview.references" :key="slot.index"><div class="picture"><referenceThumb v-if="slot.reference" :directory="directory" :projectId="projectId" :referenceId="slot.reference.id" :label="slot.name" /></div><figcaption>图片 {{ slot.index }} · {{ slot.name }}</figcaption></figure></div>
        <p v-if="preview.review" class="reviewed">已保存复核：{{ preview.review.note }}</p>
        <el-form v-else labelPosition="top" :disabled="busy" @submit.prevent="review">
          <div class="reviewItems"><el-checkbox v-model="actionConfirmed">动作、站位与时长可执行</el-checkbox><el-checkbox v-model="continuityConfirmed">前后镜人物、场景、服装和道具状态连贯</el-checkbox><el-checkbox v-model="dialogueConfirmed">台词原文和发音已核对；无台词则确认不需要</el-checkbox><el-checkbox v-model="referencesConfirmed">原图对应正确，场景和道具图没有未声明人物</el-checkbox></div>
          <el-form-item label="复核说明（发音、动作与连续性）"><el-input v-model="note" type="textarea" :rows="2" maxlength="2000" /></el-form-item>
          <el-button type="primary" :disabled="!canReview" @click="review">保存本版本复核</el-button>
        </el-form>
        <div v-if="preview.blockers.length" class="blockers"><b>尚需处理</b><p v-for="(item, index) in preview.blockers" :key="index">{{ item.message }}</p></div>
        <div class="actions"><studioSettings panel="mediaModel" @closed="inspect" /><el-button :disabled="busy" @click="emit('openCosts')">设置视频价格与预算</el-button></div>
        <div v-if="preview.price" class="authorization">
          <h4>本次生成 · Seedance 2.5 · 1080p · 9:16 · {{ preview.price.quantity }} 秒</h4>
          <p>预算预留 <strong>¥{{ money(preview.price.estimatedCostMicros) }}</strong> · <a :href="preview.price.sourceUrl" target="_blank" rel="noopener noreferrer">价格依据</a></p>
          <p class="hint">预留按你确认的保守秒价计算，平台按实际用量计费；这不是已扣款或平台硬限额。完成后仍须对账，不自动重试失败片段。</p>
          <details><summary>查看本次完整请求与接收地址</summary><p class="destination">{{ preview.destination }}</p><pre>{{ preview.requestJson }}</pre></details>
          <el-form labelPosition="top" :disabled="busy" @submit.prevent="run"><el-form-item label="本次人民币授权上限"><el-input v-model="maxCost" inputmode="decimal" placeholder="填写本次上限" /></el-form-item><el-checkbox v-model="approved">授权将本片段提示词与原图发送至火山方舟，仅生成 1 次，上限 ¥{{ maxCost || '未填写' }}</el-checkbox><div class="actions"><el-button type="primary" :loading="busy" :disabled="!canRun" @click="run">授权并生成此片段</el-button></div></el-form>
        </div>
      </template>
    </div>
    <p v-if="failure" class="blockers" role="alert">{{ failure }}</p><p v-if="receipt" role="status">{{ receipt }}</p>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import productionApi, { type SegmentExecutionPreview, type SegmentExecutionRequest } from "@/lib/productionApi";
import referenceThumb from "./referenceThumb.vue";
import studioSettings from "./studioSettings.vue";
const props = defineProps<SegmentExecutionRequest & { saved: boolean }>();
const emit = defineEmits<{ changed: []; openCosts: [] }>();
const preview = ref<SegmentExecutionPreview | null>(null); const busy = ref(false); const failure = ref(""); const receipt = ref("");
const actionConfirmed = ref(false); const continuityConfirmed = ref(false); const dialogueConfirmed = ref(false); const referencesConfirmed = ref(false);
const note = ref(""); const approved = ref(false); const maxCost = ref(""); let version = 0;
const canReview = computed(() => !busy.value && actionConfirmed.value && continuityConfirmed.value && dialogueConfirmed.value && referencesConfirmed.value && !!note.value.trim());
const costMicros = computed(() => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(maxCost.value.trim())) return 0;
  const [whole, fraction = ""] = maxCost.value.trim().split(".");
  const value = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0")); return Number.isSafeInteger(value) ? value : 0;
});
const canRun = computed(() => !busy.value && approved.value && preview.value?.canSubmit && !!preview.value.price && costMicros.value >= preview.value.price.estimatedCostMicros);
watch(maxCost, () => { approved.value = false; });
watch(() => [props.directory, props.projectId, props.episodeId, props.inputHash, props.sequence], () => {
  version++; preview.value = null; busy.value = false; failure.value = ""; receipt.value = ""; note.value = ""; maxCost.value = "";
  actionConfirmed.value = continuityConfirmed.value = dialogueConfirmed.value = referencesConfirmed.value = approved.value = false;
});
onBeforeUnmount(() => { version++; });
function request(): SegmentExecutionRequest { return { directory: props.directory, projectId: props.projectId, episodeId: props.episodeId, inputHash: props.inputHash, sequence: props.sequence }; }
function money(value: number) { return (value / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); }
async function perform(action: (input: SegmentExecutionRequest) => Promise<string | void>, changed = false) {
  if (busy.value) return;
  const current = ++version; const input = request(); busy.value = true; failure.value = ""; approved.value = false;
  try {
    const message = await action(input); const result = await productionApi.previewSegmentVideo(input);
    if (current !== version) return;
    preview.value = result; receipt.value = message || ""; if (changed) emit("changed");
  } catch (cause) { if (current === version) failure.value = axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "投产操作失败"; }
  finally { if (current === version) busy.value = false; }
}
function inspect() { if (props.saved) return perform(async () => {}); }
function review() { if (canReview.value) return perform(input => productionApi.reviewSegmentPreflight(input, { actionConfirmed: true, continuityConfirmed: true, dialogueConfirmed: true, referencesConfirmed: true, note: note.value.trim() })); }
function run() {
  if (!canRun.value || !preview.value) return;
  const approval = { approved: true as const, maxCalls: 1 as const, planHash: preview.value.planHash, maxCostMicros: costMicros.value };
  return perform(async input => (await productionApi.runSegmentVideo(input, approval)).message, true);
}
function recover() {
  const taskId = preview.value?.existingTask?.id; if (!taskId) return;
  return perform(async input => (await productionApi.recoverVideoTask(input.directory, input.projectId, taskId)).message, true);
}
</script>

<style scoped lang="scss">
.segmentExecutionPanel {
  margin-top: 18px;
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; span { color: #657c91; font-size: 13px; } }
  .preflightCard { margin-top: 16px; padding: 18px; border-radius: 12px; background: #f4f9ff; border: 1px solid #d6e8fa; h4 { margin: 0 0 12px; } }
  .hint { color: #60788f; font-size: 13px; line-height: 1.8; }
  .reviewItems { display: grid; margin-bottom: 12px; }
  :deep(.el-checkbox) { white-space: normal; height: auto; min-height: 34px; align-items: flex-start; .el-checkbox__input { margin-top: 4px; } .el-checkbox__label { white-space: normal; line-height: 1.7; } }
  .referenceGrid { display: flex; flex-wrap: wrap; gap: 12px; figure { margin: 0 0 14px; width: 150px; } .picture { height: 160px; border-radius: 8px; } figcaption { margin-top: 7px; font-size: 12px; color: #476078; } }
  .reviewed { color: #287963; }
  .blockers { margin: 14px 0; padding: 12px; border-radius: 8px; background: #fff5e5; color: #875a24; font-size: 13px; line-height: 1.8; p { margin: 6px 0; } }
  .authorization { margin-top: 20px; border-top: 1px solid #d6e8fa; padding-top: 20px; strong, a { color: #1686db; } .el-form { margin-top: 14px; } }
  details { font-size: 13px; summary { color: #1686db; cursor: pointer; } }
  pre, .destination { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; }
  pre { max-height: 280px; overflow: auto; padding: 12px; background: white; border-radius: 8px; }
}
</style>
