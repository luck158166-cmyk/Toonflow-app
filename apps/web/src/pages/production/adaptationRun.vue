<template>
  <section class="adaptationRun">
    <div class="runHeading"><div><h3>生成本集剧本</h3><p>使用已保存的章节与创作要求。结果通过校验后，自动建立分集、资产和分镜资料。</p></div><el-button :disabled="busy" @click="loadModels">刷新模型</el-button></div>
    <el-form labelPosition="top" :disabled="busy" @submit.prevent="preview">
      <div class="runFields">
        <el-form-item label="选择编剧输入"><el-select v-model="inputId" placeholder="先保存上方编剧输入" popperClass="studioSelectPopup"><el-option v-for="input in inputs" :key="input.id" :value="input.id" :label="`第 ${input.episodeNumber} 集 · ${new Date(input.createdAt).toLocaleString()}`" /></el-select></el-form-item>
        <el-form-item label="文本模型"><el-select v-model="modelKey" placeholder="选择已配置的模型" popperClass="studioSelectPopup"><el-option v-for="model in models" :key="keyFor(model)" :value="keyFor(model)" :label="`${model.providerLabel} / ${model.label || model.modelId}`" /></el-select></el-form-item>
        <el-form-item label="最长输出（token）"><el-input-number v-model="maxOutputTokens" :min="1" :max="selectedModel?.maxOutputTokens || 1000000" /></el-form-item>
      </div>
      <el-button type="primary" :disabled="!inputId || !selectedModel" :loading="busy && !running" @click="preview">检查输入与费用</el-button>
      <el-button @click="emit('openCosts', selectedModel)">设置预算与价格</el-button>
    </el-form>
    <div v-if="!models.length" class="hint"><p>尚无可选文本模型，可在这里配置供应商。关闭设置后会自动刷新模型列表。</p><studioSettings @closed="loadModels" /></div>
    <div v-if="plan" class="approvalCard">
      <h4>本次编剧调用</h4><p>第 {{ plan.options.episodeNumber }} 集 · 章节 {{ plan.options.firstChapter }}–{{ plan.options.lastChapter }} · {{ plan.options.targetSeconds }} 秒 · {{ plan.options.genre }} / {{ plan.options.visualStyle }}</p>
      <p class="destination">发送至：{{ plan.destination }}</p>
      <p>预算预留 <strong>¥{{ money(plan.estimatedCostMicros) }}</strong>，按已确认的文本最高单价和模型容量保守计算。<a :href="plan.sourceUrl" target="_blank" rel="noopener noreferrer">价格依据</a></p>
      <p class="hint">这不是实扣费用。实际用量随响应保存，费用未对账前保留预留金额；一次调用失败或内容不合格，不自动重试。</p>
      <details><summary>查看即将发送的完整内容</summary><el-input :modelValue="plan.requestJson" type="textarea" :rows="10" readonly aria-label="即将发送的编剧输入" /></details>
      <el-form labelPosition="top" :disabled="busy" @submit.prevent="run">
        <el-form-item label="本次人民币费用上限"><el-input v-model="maxCost" inputmode="decimal" placeholder="请自行填写，如 1.00" /></el-form-item>
        <el-checkbox v-model="approved">我授权将上述内容发送到所选模型，仅调用 1 次，费用上限 ¥{{ maxCost || '未填写' }}。</el-checkbox>
        <div class="runActions"><el-button type="primary" :loading="running" :disabled="!canRun" @click="run">授权并生成本集</el-button><span v-if="running">请求进行中，完成后自动校验；重复提交不会新增调用。</span></div>
      </el-form>
    </div>
    <p v-if="failure" role="alert" class="failure">{{ failure }}</p><p v-if="receipt" role="status">{{ receipt }}</p>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onMounted, ref, watch } from "vue";
import productionApi, { type AdaptationInputSummary, type AdaptationPreview, type AdaptationRequest, type ProductionTextModel } from "@/lib/productionApi";
import studioSettings from "./studioSettings.vue";
const props = defineProps<{ directory: string; projectId: string; inputs: AdaptationInputSummary[]; preferredInputId?: string }>();
const emit = defineEmits<{ changed: []; openCosts: [model: ProductionTextModel | undefined] }>();
const inputId = ref(""); const modelKey = ref(""); const maxOutputTokens = ref(8192);
const models = ref<ProductionTextModel[]>([]); const plan = ref<AdaptationPreview | null>(null);
const busy = ref(false); const running = ref(false); const approved = ref(false); const maxCost = ref("");
const failure = ref(""); const receipt = ref("");
const keyFor = (model: ProductionTextModel) => JSON.stringify([model.providerId, model.modelId]);
const selectedModel = computed(() => models.value.find(model => keyFor(model) === modelKey.value));
const costMicros = computed(() => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(maxCost.value.trim())) return 0;
  const [whole, fraction = ""] = maxCost.value.trim().split(".");
  const value = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(value) ? value : 0;
});
const canRun = computed(() => !busy.value && approved.value && !!plan.value && costMicros.value >= plan.value.estimatedCostMicros && costMicros.value > 0);
const money = (value: number) => (value / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const errorText = (cause: unknown) => axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "编剧操作失败";
function invalidate() { plan.value = null; approved.value = false; failure.value = ""; receipt.value = ""; }
watch(() => [props.directory, props.projectId], () => { inputId.value = ""; maxCost.value = ""; invalidate(); });
watch(() => props.preferredInputId, value => { if (value) inputId.value = value; });
watch(() => props.inputs, values => { if (!values.some(value => value.id === inputId.value)) inputId.value = values[0]?.id ?? ""; }, { immediate: true });
watch([inputId, modelKey, maxOutputTokens], invalidate);
watch(maxCost, () => { approved.value = false; });
watch(selectedModel, model => { if (model) maxOutputTokens.value = Math.min(maxOutputTokens.value, model.maxOutputTokens); });
onMounted(loadModels);

function request(): AdaptationRequest {
  if (!selectedModel.value || !inputId.value) throw new Error("请先选择编剧输入和模型");
  return { directory: props.directory, projectId: props.projectId, inputId: inputId.value,
    providerId: selectedModel.value.providerId, modelId: selectedModel.value.modelId, maxOutputTokens: maxOutputTokens.value };
}
async function loadModels() {
  if (busy.value) return;
  busy.value = true; invalidate();
  try { models.value = await productionApi.listTextModels(); }
  catch (cause) { failure.value = errorText(cause); }
  finally { busy.value = false; }
}
async function preview() {
  if (busy.value) return;
  const input = request(); busy.value = true; invalidate();
  try {
    const result = await productionApi.previewAdaptation(input);
    if (input.directory === props.directory && input.projectId === props.projectId && input.inputId === inputId.value) plan.value = result;
  } catch (cause) { if (input.projectId === props.projectId && input.directory === props.directory) failure.value = errorText(cause); }
  finally { busy.value = false; }
}
async function run() {
  if (!canRun.value || !plan.value) return;
  const input = request(); const approval = { approved: true as const, maxCalls: 1 as const, planHash: plan.value.planHash, maxCostMicros: costMicros.value };
  busy.value = true; running.value = true; failure.value = ""; receipt.value = "";
  try {
    const result = await productionApi.runAdaptation(input, approval);
    if (input.projectId !== props.projectId || input.directory !== props.directory) return;
    receipt.value = result.episodeId ? "本集剧本、资产与分镜已建立，等待内容审核。实际费用仍需对账。"
      : result.adoptionError ? `响应已保存，内容未采用：${result.adoptionError}`
        : result.status === "budget_exhausted" ? "预算不足，尚未调用模型。调整预算后可重新授权。"
          : result.status === "reconcile_required" ? "请求状态需要对账，系统不会再次发送。请查看生成任务。"
            : "任务已存在，未重复调用模型。请查看生成任务。";
    approved.value = false;
    emit("changed");
  } catch (cause) {
    if (input.projectId === props.projectId && input.directory === props.directory) failure.value = `${errorText(cause)}。如请求已发出，请先刷新生成任务核对状态。`;
    approved.value = false;
  } finally { busy.value = false; running.value = false; }
}
</script>

<style scoped lang="scss">
.adaptationRun { margin-top: 24px; padding-top: 22px; border-top: 1px solid #dfeaf5; .runHeading { display: flex; justify-content: space-between; gap: 12px; h3 { margin: 0; } } p { color: #50647b; font-size: 13px; line-height: 1.7; } .runFields { display: grid; grid-template-columns: 1.2fr 1.2fr 1fr; gap: 12px; } .approvalCard { margin-top: 20px; padding: 18px; border: 1px solid #c8e2f8; border-radius: 10px; background: #f5faff; h4 { margin: 0; color: #1678c9; } a { color: #1678c9; } .destination { overflow-wrap: anywhere; } details { margin: 14px 0; summary { margin-bottom: 10px; color: #4d7fa9; cursor: pointer; font-size: 12px; } } :deep(.el-checkbox) { height: auto; white-space: normal; } :deep(.el-checkbox__label) { white-space: normal; line-height: 1.7; } } .hint { color: #7c8b9e; font-size: 12px; } .failure { color: #ad402d; } .runActions { display: flex; align-items: center; gap: 12px; margin-top: 16px; span { color: #7c8b9e; font-size: 12px; } } }
@media (max-width: 900px) { .adaptationRun .runFields { grid-template-columns: 1fr; } }
</style>
