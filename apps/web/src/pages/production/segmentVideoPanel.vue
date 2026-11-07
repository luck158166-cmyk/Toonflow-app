<template>
  <section class="segmentVideoPanel" aria-label="片段审片">
    <p v-if="busy">{{ busy === 'inspect' ? '正在读取原视频并检查画幅、时长、黑屏与静音…' : '正在保存审片结果…' }}</p>
    <template v-if="candidate">
      <div class="previewGrid">
        <videoPlayer v-if="videoUrl" :key="videoUrl" ref="player" :src="videoUrl" :readOnly="true" label="片段审片视频" />
        <div><h4>片段 {{ candidate.sequence }} · 方案 v{{ candidate.planVersion }}</h4>
          <p>{{ candidate.message }}</p>
          <p>{{ candidate.evidence.width }} × {{ candidate.evidence.height }} · {{ (candidate.evidence.durationMs / 1000).toFixed(2) }} 秒 · {{ candidate.evidence.videoCodec }} / {{ candidate.evidence.audioCodec }}</p>
          <ol><li v-for="shot in candidate.shots" :key="shot.shotId">{{ shot.start }}–{{ shot.end }} 秒 · {{ shot.title }}</li></ol>
          <p v-if="candidate.evidence.quality.formatIssues.length" class="failure">格式问题：{{ candidate.evidence.quality.formatIssues.join('、') }}</p>
          <p v-for="(interval, index) in candidate.evidence.quality.intervals" :key="index" class="warning">{{ interval.kind === 'black' ? '疑似黑屏' : '疑似静音' }} {{ interval.startSeconds.toFixed(2) }}–{{ interval.endSeconds.toFixed(2) }} 秒，请确认是否符合剧情。</p>
          <p v-if="candidate.adoption" class="adopted">已采用 v{{ candidate.adoption.version }}，费用仍待对账，尚非发布确认。</p>
          <template v-else-if="candidate.canAdopt">
            <label class="review"><input v-model="confirmed" type="checkbox" :disabled="!loaded || !!busy" />我已播放核对人物与道具、动作连续性、对白音频和使用权</label>
            <el-input v-model="note" type="textarea" :rows="2" maxlength="2000" aria-label="审片说明" placeholder="审片说明；若有黑屏或静音提醒，请说明是否为剧情需要" :disabled="!!busy" />
            <el-button type="primary" :disabled="!loaded || !confirmed || !note.trim() || !!busy" @click="adopt">采用到本集时间线</el-button>
          </template>
        </div>
      </div>
    </template>
    <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import axios from "axios";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import productionApi, { type SegmentVideoCandidate } from "@/lib/productionApi";
const props = defineProps<{ directory: string; projectId: string; taskId: string }>();
const emit = defineEmits<{ changed: [] }>();
const candidate = ref<SegmentVideoCandidate | null>(null); const videoUrl = ref(""); const busy = ref("");
const player = ref<InstanceType<typeof videoPlayer>>(); const loaded = computed(() => !!player.value?.ready);
const confirmed = ref(false); const note = ref(""); const failure = ref(""); let version = 0;
function clearVideo() { if (videoUrl.value) URL.revokeObjectURL(videoUrl.value); videoUrl.value = ""; }
function message(cause: unknown) { return axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "视频操作失败"; }
watch(() => [props.directory, props.projectId, props.taskId], async () => {
  const current = ++version; const { directory, projectId, taskId } = props;
  clearVideo(); candidate.value = null; confirmed.value = false; note.value = ""; failure.value = ""; busy.value = "inspect";
  try {
    const result = await productionApi.inspectSegmentVideo(directory, projectId, taskId);
    if (current !== version) return;
    candidate.value = result;
    const bytes = await productionApi.readSegmentVideo(directory, projectId, taskId);
    if (current === version) videoUrl.value = URL.createObjectURL(bytes);
  } catch (cause) { if (current === version) failure.value = message(cause); }
  finally { if (current === version) busy.value = ""; }
}, { immediate: true });
onBeforeUnmount(() => { version++; clearVideo(); });
async function adopt() {
  if (!candidate.value || busy.value || !loaded.value || !confirmed.value || !note.value.trim()) return;
  const current = version; busy.value = "adopt"; failure.value = "";
  try {
    const result = await productionApi.adoptSegmentVideo(props.directory, props.projectId, props.taskId, candidate.value.expectedAdoptionId,
      { pictureConfirmed: true, continuityConfirmed: true, audioConfirmed: true, rightsConfirmed: true, note: note.value.trim() });
    if (current === version) { candidate.value.adoption = result.adoption; emit("changed"); }
  } catch (cause) { if (current === version) failure.value = message(cause); }
  finally { if (current === version) busy.value = ""; }
}
</script>

<style scoped lang="scss">
.segmentVideoPanel { margin: 12px 0; padding: 18px; background: #f4f9ff; border-radius: 12px;
  .previewGrid { display: grid; grid-template-columns: minmax(160px, 240px) 1fr; gap: 24px; }
  .videoPlayer { --nodeMediaHeight: 430px; background: #e7eff8; border-radius: 10px; }
  :deep(.playerControls) { opacity: 1; pointer-events: auto; }
  h4 { margin: 0; color: #20354a; } p, li { font-size: 13px; line-height: 1.7; color: #526d86; }
  .review { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.8; margin: 14px 0; }
  .el-button { margin-top: 12px; } .warning { color: #996012; } .failure { color: #a5422b; } .adopted { color: #18734c; }
  @media(max-width: 600px) { .previewGrid { grid-template-columns: 1fr; } .videoPlayer { --nodeMediaHeight: 350px; } }
}
</style>
