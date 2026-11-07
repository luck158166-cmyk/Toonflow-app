<template>
  <section class="shotPromptPanel">
    <header><div><h4>视频提示词</h4><p>从已审核镜头自动编译，原对白和参考图编号由程序固定。</p></div><el-button type="primary" :loading="loading" :disabled="saving" @click="compile">编译提示词</el-button></header>
    <p v-if="errorText" class="issues" role="alert">{{ errorText }}</p>
    <template v-if="report">
      <p class="notice">Seedance 2.5 · {{ report.snapshot.requestDraft.duration }} 秒 · 9:16 · 1080p · {{ report.snapshot.templateVersion }}</p>
      <div v-if="problems.length" class="issues" role="alert"><p v-for="(item, index) in problems" :key="index">{{ item.message }}</p></div>
      <pre v-if="report.snapshot.requestDraft.prompt" aria-label="已编译视频提示词">{{ report.snapshot.requestDraft.prompt }}</pre>
      <details><summary>检查结果与待验证事项</summary><p v-for="(check, index) in report.snapshot.checks" :key="index"><b>{{ check.state === 'passed' ? '已检查' : check.state === 'failed' ? '需修改' : '待验证' }} · {{ check.code }}</b>：{{ check.message }}</p></details>
      <div class="actions"><el-button type="primary" :disabled="!report.canSave || !preparationSaved || !!savedVersion || loading" :loading="saving" @click="save">{{ savedVersion ? `已保存提示词 v${savedVersion.version}` : '保存提示词候选版本' }}</el-button><span>{{ preparationSaved ? '本地编译与保存，费用为零。' : '请先保存上方镜头资料版本。' }}</span></div>
      <p class="notice">保存的是单镜提示词候选，不会启动视频生成。多镜片段编排、平台素材信任、发音和内容质检尚未贯通。</p>
      <details v-if="report.history.length"><summary>提示词版本记录（{{ report.history.length }}）</summary><p v-for="entry in report.history" :key="entry.id">v{{ entry.version }} · {{ new Date(entry.createdAt).toLocaleString() }} · {{ entry.inputHash === report.inputHash ? '当前依据' : '历史依据，保留原记录' }}</p></details>
    </template>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import productionApi, { type CompiledShotPrompt } from "@/lib/productionApi";
const props = defineProps<{ directory: string; projectId: string; shotId: string; preparationHash: string; preparationSaved: boolean }>();
const report = ref<CompiledShotPrompt | null>(null);
const errorText = ref(""); const loading = ref(false); const saving = ref(false);
let requestVersion = 0;
const savedVersion = computed(() => report.value?.history.find(item => item.inputHash === report.value?.inputHash));
const problems = computed(() => [...(report.value?.fileIssues ?? []), ...(report.value?.snapshot.checks.filter(item => item.state === "failed") ?? [])]);
watch(() => [props.directory, props.projectId, props.shotId, props.preparationHash], () => { requestVersion++; report.value = null; errorText.value = ""; loading.value = false; });
onBeforeUnmount(() => { requestVersion++; });
function message(cause: unknown) { return axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "提示词操作失败"; }
async function compile() {
  const version = ++requestVersion; loading.value = true; errorText.value = ""; report.value = null;
  try { const result = await productionApi.getShotPrompt(props.directory, props.projectId, props.shotId); if (version === requestVersion) report.value = result; }
  catch (cause) { if (version === requestVersion) errorText.value = message(cause); }
  finally { if (version === requestVersion) loading.value = false; }
}
async function save() {
  if (!report.value?.canSave || saving.value || !props.preparationSaved) return;
  const directory = props.directory; const projectId = props.projectId; const shotId = props.shotId;
  const inputHash = report.value.inputHash; const version = requestVersion;
  saving.value = true; errorText.value = "";
  try {
    await productionApi.saveShotPrompt(directory, projectId, shotId, inputHash);
    if (version !== requestVersion) return;
    await compile(); ElMessage.success("提示词候选已保存，未调用模型");
  } catch (cause) { if (version === requestVersion) errorText.value = message(cause); }
  finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.shotPromptPanel {
  margin-top: 24px; padding-top: 18px; border-top: 1px solid #e3ebf4;
  header { display: flex; align-items: center; justify-content: space-between; gap: 14px; h4 { margin: 0; } p { font-size: 13px; color: #647b90; } }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 18px; background: #f0f7ff; color: #29415b; line-height: 1.9; border-radius: 12px; font-family: inherit; font-size: 13px; }
  .notice, .actions span { font-size: 12px; color: #647b90; line-height: 1.8; }
  .issues { background: #fff5e6; color: #8b571c; padding: 12px; border-radius: 10px; }
  details { margin: 16px 0; font-size: 13px; line-height: 1.8; summary { cursor: pointer; color: #1689ec; } }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  @media(max-width: 700px) { header { flex-wrap: wrap; } }
}
</style>
