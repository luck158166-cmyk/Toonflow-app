<template>
  <section class="segmentPlanPanel">
    <header><div><h3>自动规划生成片段</h3><p>将同场次的连续镜头组织为视频片段，统一时间线和参考图编号。</p></div><el-button type="primary" :disabled="!selectedId || saving" :loading="loading" @click="plan">规划本集片段</el-button></header>
    <el-select v-model="selectedId" :disabled="saving || loading" aria-label="片段规划分集" placeholder="选择分集" popperClass="studioSelectPopup"><el-option v-for="episode in episodes" :key="episode.id" :value="episode.id" :label="`第 ${episode.episodeNumber} 集 · ${episode.title}`" /></el-select>
    <p v-if="errorText" class="issues" role="alert">{{ errorText }}</p>
    <template v-if="report">
      <p class="overview">本集划为 {{ report.snapshot.segments.length }} 个片段 · 共 {{ totalSeconds }} 秒 · 本地规划，不调用模型</p>
      <p v-for="(issue, index) in report.fileIssues" :key="index" class="issues" role="alert">{{ issue.message }}</p>
      <article v-for="segment in report.snapshot.segments" :key="segment.sequence">
        <div class="segmentHeading"><h4>片段 {{ segment.sequence }} <span>第 {{ segment.sceneSequence ?? '?' }} 场 · {{ segment.requestDraft.duration }} 秒</span></h4><el-tag :type="segment.checks.some(item => item.state === 'failed') ? 'warning' : 'info'">{{ segment.checks.some(item => item.state === 'failed') ? '需要处理' : '候选待验证' }}</el-tag></div>
        <div class="timeline"><div v-for="shot in segment.timeline" :key="shot.shotId"><b>{{ shot.start }}–{{ shot.end }} 秒</b><span>镜头 {{ shot.sequence }} · {{ shot.title }}</span></div></div>
        <p class="notice">{{ segment.boundaryReason }}</p>
        <p v-for="(check, index) in segment.checks.filter(item => item.state === 'failed')" :key="index" class="issues">{{ check.message }}</p>
        <details><summary>查看统一素材与提示词</summary><div class="referenceList"><span v-for="slot in segment.references" :key="slot.index">图片 {{ slot.index }} · {{ slot.name }} · {{ roleLabel(slot.role) }} · {{ slot.reference ? `v${slot.reference.version}` : '缺图' }}</span></div><pre>{{ segment.requestDraft.prompt }}</pre></details>
        <details><summary>检查与待验证事项</summary><p v-for="(check, index) in segment.checks" :key="index">{{ check.state === 'passed' ? '已检查' : check.state === 'pending' ? '待验证' : '需处理' }} · {{ check.message }}</p></details>
      </article>
      <div class="actions"><el-button type="primary" :loading="saving" :disabled="loading || !report.canSave || !!saved" @click="save">{{ saved ? `当前方案已保存为 v${saved.version}` : '保存本集片段方案' }}</el-button><span>只保存制作候选，不启动付费生成。</span></div>
      <p class="notice">平台素材信任、内容语义质检与真实模型效果仍待验证。旧镜头若缺场次或导演资料会显示缺项；不会按地点猜测场次，也不会静默改变镜头时长。</p>
      <details v-if="report.history.length"><summary>方案版本（{{ report.history.length }}）</summary><p v-for="entry in report.history" :key="entry.id">v{{ entry.version }} · {{ new Date(entry.createdAt).toLocaleString() }} · {{ entry.inputHash === report.inputHash ? '当前依据' : '历史依据' }}</p></details>
    </template>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { ElMessage } from "element-plus";
import productionApi, { type SegmentPlan, type ReferenceRole } from "@/lib/productionApi";
const props = defineProps<{ directory: string; projectId: string; episodes: Array<{ id: string; episodeNumber: number; title: string }> }>();
const selectedId = ref(""); const report = ref<SegmentPlan | null>(null);
const loading = ref(false); const saving = ref(false); const errorText = ref(""); let version = 0;
const saved = computed(() => report.value?.history.find(item => item.inputHash === report.value?.inputHash));
const totalSeconds = computed(() => report.value?.snapshot.segments.reduce((sum, segment) => sum + segment.requestDraft.duration, 0) ?? 0);
watch(() => props.episodes, episodes => { if (!episodes.some(item => item.id === selectedId.value)) selectedId.value = episodes[0]?.id ?? ""; }, { immediate: true });
watch(() => [props.directory, props.projectId, props.episodes, selectedId.value], () => { version++; report.value = null; errorText.value = ""; loading.value = false; });
onBeforeUnmount(() => { version++; });
function roleLabel(role: ReferenceRole) { return { headshot: "面部", fullBody: "全身", costume: "服装", scene: "场景", prop: "道具" }[role]; }
function message(cause: unknown) { return axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "片段操作失败"; }
async function plan() {
  if (!props.directory || !props.projectId || !selectedId.value) return;
  const requestVersion = ++version; loading.value = true; errorText.value = ""; report.value = null;
  try { const data = await productionApi.getSegmentPlan(props.directory, props.projectId, selectedId.value); if (version === requestVersion) report.value = data; }
  catch (cause) { if (version === requestVersion) errorText.value = message(cause); }
  finally { if (version === requestVersion) loading.value = false; }
}
async function save() {
  if (!report.value?.canSave || saving.value) return;
  const directory = props.directory; const projectId = props.projectId; const episodeId = selectedId.value;
  const inputHash = report.value.inputHash; const requestVersion = version; saving.value = true;
  try {
    await productionApi.saveSegmentPlan(directory, projectId, episodeId, inputHash);
    if (version !== requestVersion) return;
    await plan(); ElMessage.success("片段方案已保存，未调用模型");
  } catch (cause) { if (version === requestVersion) errorText.value = message(cause); }
  finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.segmentPlanPanel {
  header, .segmentHeading { display: flex; justify-content: space-between; align-items: center; gap: 14px; h3, h4 { margin: 0; } p, span { color: #697e94; font-size: 13px; line-height: 1.8; } }
  > .el-select { max-width: 480px; }
  .overview { color: #296aaa; margin: 20px 0; }
  article { margin: 16px 0; padding: 18px; border: 1px solid #dfe9f2; border-radius: 12px; h4 span { margin-left: 12px; } }
  .timeline { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; div { display: grid; gap: 6px; padding: 12px; border-radius: 8px; background: #eef6ff; b { color: #287bc7; } span { font-size: 13px; color: #435b72; } } }
  .issues { color: #8b571c; background: #fff5e6; padding: 12px; border-radius: 8px; }
  details { margin-top: 14px; font-size: 13px; line-height: 1.9; summary { cursor: pointer; color: #1689ec; } }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f5f8fc; padding: 14px; border-radius: 8px; font-family: inherit; }
  .referenceList { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 14px 0; }
  .notice, .actions span { color: #697e94; font-size: 12px; line-height: 1.8; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  @media(max-width: 700px) { header, .segmentHeading { flex-wrap: wrap; } article { padding: 12px; } }
}
</style>
