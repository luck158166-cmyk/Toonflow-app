<template>
  <section class="episodeTimelinePanel">
    <div class="heading"><div><h3>剧集时间线与审片版</h3><p>采用片段后按剧本顺序合成，保留原声。合成不调用模型；审片版尚未添加独立配音、字幕与配乐。</p></div>
      <el-select v-model="episodeId" aria-label="选择合成分集" placeholder="选择分集"><el-option v-for="episode in episodes" :key="episode.id" :value="episode.id" :label="`第 ${episode.episodeNumber} 集 · ${episode.title}`" /></el-select>
    </div>
    <div class="actions"><el-button :loading="loading" :disabled="!episodeId" @click="refresh">刷新时间线</el-button>
      <el-button type="primary" :disabled="!timeline?.complete || loading || !!busy" :loading="busy === 'render'" @click="render">{{ hasRunning ? '查看合成进度' : '合成本地审片版' }}</el-button></div>
    <template v-if="timeline">
      <p>{{ timeline.segments.filter(item => item.adoption).length }} / {{ timeline.segments.length }} 个片段已采用 · {{ timeline.durationMs / 1000 }} 秒</p>
      <div class="timeline"><article v-for="segment in timeline.segments" :key="segment.sequence" :class="{ adopted: !!segment.adoption }">
        <strong>片段 {{ segment.sequence }} · {{ segment.startMs / 1000 }}–{{ segment.endMs / 1000 }} 秒</strong>
        <p>{{ segment.adoption ? '已采用 · v' + segment.adoption.version : '等待生成与审片采用' }}</p>
        <div v-for="shot in segment.shots" :key="shot.shotId">镜头 {{ shot.sequence }} · {{ shot.title }}<small>{{ shot.startMs / 1000 }}–{{ shot.endMs / 1000 }} 秒</small></div>
      </article></div>
      <p v-if="!timeline.complete">缺少已采用的片段，请到“生成任务”预览并采用。旧方案的视频保留在任务记录中，不会自动混入当前时间线。</p>
      <article v-for="output in timeline.renders" :key="output.taskId" class="renderRow"><span>合成 v{{ output.version }} · {{ stateLabel(output.state) }} · {{ new Date(output.updatedAt).toLocaleString() }}</span>
        <el-button v-if="output.state === 'succeeded'" type="primary" :disabled="!!busy" @click="preview(output.taskId)">预览 / 下载</el-button></article>
      <div v-if="videoUrl" class="renderPreview"><videoPlayer :key="videoUrl" :src="videoUrl" :readOnly="true" label="整集审片版" /><p>合成文件已核验哈希。编码合规与可播放不代表剧情、人物一致性或发布审核通过。</p>
        <el-button type="primary" @click="download">下载审片版 MP4</el-button></div>
    </template>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="failure" class="failure" role="alert">{{ failure }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import axios from "axios";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import productionApi, { type ProjectProduction, type VideoTimeline } from "@/lib/productionApi";
import saveFile from "@/lib/saveFile";
const props = defineProps<{ directory: string; projectId: string; episodes: ProjectProduction["episodes"] }>();
const emit = defineEmits<{ changed: [] }>();
const episodeId = ref(""); const timeline = ref<VideoTimeline | null>(null); const loading = ref(false); const busy = ref("");
const notice = ref(""); const failure = ref(""); const videoUrl = ref(""); let videoBlob: Blob | null = null; let selectedTaskId = "";
let version = 0; let timer: ReturnType<typeof setTimeout> | undefined;
const hasRunning = computed(() => timeline.value?.renders.some(task => ["queued", "dispatching", "running"].includes(task.state)) ?? false);
function stopTimer() { if (timer) clearTimeout(timer); timer = undefined; }
function clearVideo() { if (videoUrl.value) URL.revokeObjectURL(videoUrl.value); videoUrl.value = ""; videoBlob = null; selectedTaskId = ""; }
function message(cause: unknown) { return axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "合成操作失败"; }
function stateLabel(state: string) { return ({ queued: "排队", dispatching: "合成中", running: "合成中", succeeded: "审片版已保存", failed: "合成失败，可再次合成", reconcile_required: "中断待恢复，可再次合成" } as Record<string, string>)[state] ?? state; }
watch(() => props.episodes, episodes => { if (!episodes.some(item => item.id === episodeId.value)) episodeId.value = episodes[0]?.id ?? ""; }, { immediate: true });
watch(() => [props.directory, props.projectId, episodeId.value], () => {
  version++; stopTimer(); clearVideo(); loading.value = false; busy.value = ""; failure.value = ""; notice.value = ""; timeline.value = null;
  if (episodeId.value) void refresh();
}, { immediate: true });
onBeforeUnmount(() => { version++; stopTimer(); clearVideo(); });
async function refresh() {
  if (loading.value || !episodeId.value) return;
  stopTimer(); const current = version; loading.value = true; failure.value = "";
  try {
    const result = await productionApi.getVideoTimeline(props.directory, props.projectId, episodeId.value);
    if (current !== version) return;
    const wasRunning = hasRunning.value; timeline.value = result;
    if (wasRunning && !hasRunning.value) emit("changed");
    if (hasRunning.value) timer = setTimeout(() => void refresh(), 3000);
  } catch (cause) { if (current === version) failure.value = message(cause); }
  finally { if (current === version) loading.value = false; }
}
async function render() {
  if (!timeline.value?.complete || busy.value) return;
  if (hasRunning.value) { await refresh(); return; }
  const current = version; busy.value = "render"; failure.value = ""; notice.value = "";
  try {
    const result = await productionApi.runEpisodeRoughCut(props.directory, props.projectId, episodeId.value, timeline.value.inputHash);
    if (current !== version) return;
    notice.value = result.message; emit("changed"); await refresh();
  } catch (cause) { if (current === version) failure.value = message(cause); }
  finally { if (current === version) busy.value = ""; }
}
async function preview(taskId: string) {
  if (busy.value) return;
  const current = version; busy.value = "preview"; failure.value = ""; clearVideo();
  try {
    const bytes = await productionApi.readEpisodeRoughCut(props.directory, props.projectId, taskId);
    if (current === version) { videoBlob = bytes; selectedTaskId = taskId; videoUrl.value = URL.createObjectURL(bytes); }
  } catch (cause) { if (current === version) failure.value = message(cause); }
  finally { if (current === version) busy.value = ""; }
}
async function download() {
  if (!videoBlob) return;
  const current = version;
  try { await saveFile(videoBlob, `审片版-${selectedTaskId}.mp4`); }
  catch (cause) { if (current === version) failure.value = message(cause); }
}
</script>

<style scoped lang="scss">
.episodeTimelinePanel { padding: 24px; background: #fff; border: 1px solid #dfe9f2; border-radius: 14px; margin-bottom: 20px;
  h3 { margin: 0; color: #20354a; } p, small { color: #61778d; line-height: 1.7; font-size: 13px; }
  .heading { display: flex; gap: 20px; justify-content: space-between; .el-select { width: 240px; flex-shrink: 0; } }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .timeline { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;
    article { border: 1px dashed #b5cbe0; border-radius: 12px; background: #f6f9fc; padding: 16px;
      strong { color: #31516d; font-size: 14px; } div { font-size: 13px; margin-top: 8px; } small { display: block; }
      &.adopted { border: 1px solid #b9dfce; background: #f2fbf7; }
    }
  }
  .renderRow { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; border-top: 1px solid #e6eef5; padding: 15px 0; font-size: 13px; }
  .renderPreview { margin-top: 18px; .videoPlayer { --nodeMediaHeight: 520px; border-radius: 12px; background: #e7eff8; } }
  :deep(.playerControls) { opacity: 1; pointer-events: auto; }
  .failure { color: #a5422b; }
  @media(max-width: 600px) { padding: 16px; .heading { flex-wrap: wrap; .el-select { width: 100%; } } .timeline { grid-template-columns: 1fr; } }
}
</style>
