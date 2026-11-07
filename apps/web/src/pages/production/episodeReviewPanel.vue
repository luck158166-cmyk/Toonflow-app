<template>
  <section class="episodeReviewPanel" aria-label="分集内容审核">
    <header><div><h3>确认本集，衔接下一集</h3><p>核对剧本、人物和道具状态；确认后锁定本集使用的资产描述。</p></div>
      <el-select v-model="selectedId" aria-label="选择审核分集" :disabled="saving" popperClass="studioSelectPopup"><el-option v-for="episode in episodes" :key="episode.id" :value="episode.id" :label="`第 ${episode.episodeNumber} 集 · ${episode.title}`" /></el-select>
      <el-button :loading="loading" :disabled="saving" @click="loadReview">刷新审核资料</el-button>
    </header>
    <p v-if="errorText" class="errorText" role="alert">{{ errorText }}</p>
    <div v-if="review && !loading" class="reviewBody">
      <div class="reviewSummary"><el-tag :type="review.snapshot.episode.reviewState === 'confirmed' ? 'success' : 'warning'">{{ stateLabel(review.snapshot.episode.reviewState) }}</el-tag><span>{{ review.snapshot.shots.length }} 个镜头 · {{ review.snapshot.assets.length }} 项人物/道具/服装 · {{ review.snapshot.scenes.length }} 个场景</span></div>
      <div v-if="review.issues.length" class="issues"><strong>确认前需要修正</strong><ul><li v-for="issue in review.issues" :key="issue">{{ issue }}</li></ul></div>
      <div class="reviewColumns">
        <div>
          <h4>{{ review.snapshot.episode.title }}</h4><p>{{ review.snapshot.episode.logline }}</p>
          <ol><li v-for="(beat, index) in review.snapshot.episode.outline" :key="index">{{ beat }}</li></ol>
          <article v-for="(scene, index) in scriptScenes" :key="index" class="scriptScene">
            <h4>第 {{ index + 1 }} 场 · {{ scene.location }}</h4><small>出场人物：{{ scene.characters.join('、') || '未记录' }}</small>
            <p v-for="(beat, beatIndex) in scene.beats" :key="beatIndex"><b>{{ beat.speaker || beatLabel(beat.type) }}：</b>{{ beat.text }}</p>
            <details><summary>查看本场原文证据</summary><blockquote v-for="(evidence, evidenceIndex) in scene.evidence" :key="evidenceIndex"><small>{{ evidenceLabel(evidence) }}</small><p>{{ evidenceQuote(evidence) }}</p></blockquote></details>
          </article>
        </div>
        <aside><h4>本集资产描述</h4><article v-for="asset in review.snapshot.assets" :key="asset.id" class="assetDescription"><strong>{{ asset.name }}</strong><small>{{ asset.locked ? '描述已锁定' : '确认时锁定描述' }}</small><p>{{ asset.stableDescription }}</p></article><article v-for="scene in review.snapshot.scenes" :key="scene.id" class="assetDescription"><strong>{{ scene.name }}</strong><small>{{ scene.locked ? '场景已锁定' : '确认时锁定场景' }}</small><p>{{ [scene.location, scene.atmosphere, scene.timeWeather].filter(Boolean).join(' · ') }}</p></article></aside>
      </div>
      <details class="shotDetails"><summary>逐镜核对动作、对白与道具（{{ review.snapshot.shots.length }} 镜）</summary>
        <article v-for="shot in review.snapshot.shots" :key="shot.id" class="scriptScene"><h4>镜头 {{ shot.sequence }} · {{ shot.title }} · {{ shot.durationMs / 1000 }} 秒</h4><p>{{ shot.scriptExcerpt }}</p><small>{{ shot.shotSize }} · {{ shot.movement }}</small>
          <p v-for="line in review.snapshot.dialogue.filter(item => item.shotId === shot.id)" :key="line.id"><b>{{ assetName(line.speakerId) || beatLabel(line.kind) }}：</b>{{ line.text }}</p>
          <p v-for="prop in review.snapshot.props.filter(item => item.shotId === shot.id)" :key="prop.propId"><b>{{ prop.propName }}：</b>{{ prop.holderBeforeName || '无人持有' }} / {{ prop.stateBefore }} → {{ prop.holderAfterName || '无人持有' }} / {{ prop.stateAfter }}；{{ prop.interaction }}</p>
          <blockquote v-for="(evidence, index) in shot.evidence" :key="index"><small>{{ evidenceLabel(evidence) }}</small><p>{{ evidenceQuote(evidence) }}</p></blockquote>
        </article>
      </details>
      <details class="sourceDetails"><summary>查看完整原文（带行号）</summary><pre>{{ numberedSource }}</pre></details>
      <p v-if="review.hasSuccessor" class="notice">后续分集已建立。本集审核只读，系列修订入口尚未接入。</p>
      <div v-else class="reviewActions">
        <label for="episodeReviewNote">审核意见（退回时必填）</label><el-input id="episodeReviewNote" v-model="note" type="textarea" :rows="2" maxlength="4000" :disabled="saving" placeholder="例如：镜头 3 的钥匙应仍由林岚持有" />
        <el-checkbox v-model="acknowledged" :disabled="saving || !!review.issues.length">我已核对本集剧本、镜头和资产描述，同意作为后续创作依据</el-checkbox>
        <div class="actionRow"><el-button type="warning" :disabled="saving || !note.trim()" @click="submitReview('changes_requested')">退回并记录问题</el-button><el-button type="primary" :loading="saving" :disabled="!acknowledged || !!review.issues.length || review.snapshot.episode.reviewState === 'confirmed'" @click="submitReview('confirmed')">确认本集并锁定描述</el-button></div>
      </div>
      <p class="notice">此处确认的是内容与资产文字描述，不代表参考图、配音或视频已就绪。退回会阻止续写并保留已有产物；局部修订入口仍在接入。</p>
      <details v-if="review.history.length" class="history"><summary>审核记录（{{ review.history.length }}）</summary><p v-for="entry in review.history" :key="entry.id"><b>{{ stateLabel(entry.decision) }}</b> · {{ new Date(entry.createdAt).toLocaleString() }} · 本机用户<br />{{ entry.note || '未附加意见' }}</p></details>
    </div>
    <p v-else-if="loading" class="notice">正在读取本集审核资料…</p>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import productionApi, { type Episode, type EpisodeReview } from "@/lib/productionApi";
const props = defineProps<{ directory: string; projectId: string; episodes: Episode[] }>();
const emit = defineEmits<{ changed: [] }>();
const selectedId = ref("");
const review = ref<EpisodeReview | null>(null);
const note = ref("");
const acknowledged = ref(false);
const loading = ref(false);
const saving = ref(false);
const errorText = ref("");
let loadVersion = 0;
watch(() => props.episodes, episodes => {
  if (!episodes.some(item => item.id === selectedId.value)) selectedId.value = episodes.find(item => item.reviewState !== "confirmed")?.id ?? episodes.at(-1)?.id ?? "";
}, { immediate: true });
watch(() => [props.directory, props.projectId, selectedId.value, props.episodes.map(item => item.updatedAt).join(",")], () => { void loadReview(); }, { immediate: true });
const numberedSource = computed(() => review.value?.sourceText.replace(/\r\n?/g, "\n").split("\n").map((line, index) => `${index + 1}  ${line}`).join("\n") ?? "");
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
const scriptScenes = computed(() => review.value?.snapshot.episode.script.map(value => {
  const scene = record(value);
  return { location: text(scene.location ?? scene.scene), characters: Array.isArray(scene.characters) ? scene.characters.map(text) : [],
    beats: Array.isArray(scene.beats) ? scene.beats.map(value => { const beat = record(value); return { type: text(beat.type), text: text(beat.text), speaker: text(beat.speaker) }; }) : [],
    evidence: Array.isArray(scene.evidence) ? scene.evidence : [] };
}) ?? []);
function stateLabel(value: string) { return ({ confirmed: "内容已确认", changes_requested: "已退回待修订", draft: "待内容审核" } as Record<string, string>)[value] ?? value; }
function beatLabel(value: string) { return ({ action: "动作", dialogue: "对白", voiceover: "画外音", narration: "旁白", phone: "电话" } as Record<string, string>)[value] ?? value; }
function evidenceLabel(value: unknown) { const evidence = record(value); return evidence.chapterSequence ? `第 ${evidence.chapterSequence} 章 · 第 ${evidence.lineStart}–${evidence.lineEnd} 行` : "原文依据"; }
function evidenceQuote(value: unknown) { return typeof value === "string" ? value : text(record(value).quote); }
function assetName(id: string | null) { return review.value?.snapshot.assets.find(item => item.id === id)?.name; }
function message(cause: unknown) { return axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "审核操作失败"; }
async function loadReview() {
  const version = ++loadVersion;
  review.value = null; note.value = ""; acknowledged.value = false; errorText.value = "";
  loading.value = false;
  if (!props.directory || !props.projectId || !selectedId.value) return;
  loading.value = true;
  try {
    const result = await productionApi.getEpisodeReview(props.directory, props.projectId, selectedId.value);
    if (version === loadVersion) review.value = result;
  } catch (cause) { if (version === loadVersion) errorText.value = message(cause); }
  finally { if (version === loadVersion) loading.value = false; }
}
async function submitReview(decision: "confirmed" | "changes_requested") {
  if (!review.value || saving.value || decision === "confirmed" && (!acknowledged.value || review.value.issues.length)) return;
  const directory = props.directory; const projectId = props.projectId; const episodeId = selectedId.value;
  const snapshotHash = review.value.snapshotHash;
  saving.value = true; errorText.value = "";
  try {
    await productionApi.reviewEpisode(directory, projectId, episodeId, snapshotHash, decision, note.value);
    if (props.directory !== directory || props.projectId !== projectId || selectedId.value !== episodeId) return;
    await loadReview(); emit("changed");
    ElMessage.success(decision === "confirmed" ? "本集已确认，资产描述已锁定，可准备下一集" : "问题已记录，本集等待修订");
  } catch (cause) {
    if (props.directory === directory && props.projectId === projectId && selectedId.value === episodeId) {
      errorText.value = message(cause); acknowledged.value = false;
    }
  } finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.episodeReviewPanel {
  color: #29415a;
  header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; h3 { margin: 0; } p { margin: 8px 0; color: #6e8195; font-size: 13px; } .el-select { width: 250px; margin-left: auto; } }
  .reviewSummary { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 18px 0; font-size: 13px; }
  .reviewColumns { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(230px, 1fr); gap: 24px; > div, aside { min-width: 0; } h4 { margin: 12px 0; } p, li { line-height: 1.8; overflow-wrap: anywhere; } }
  .scriptScene, .assetDescription { margin: 12px 0; padding: 16px; border: 1px solid #dfe9f3; border-radius: 10px; background: #fafcff; p { white-space: pre-wrap; overflow-wrap: anywhere; } small { color: #6e8195; } }
  .assetDescription { strong, small { display: block; } small { margin-top: 6px; } p { margin-bottom: 0; } }
  details { margin: 14px 0; summary { padding: 10px 0; cursor: pointer; color: #197cc9; } blockquote { margin: 10px 0; padding-left: 12px; border-left: 3px solid #9acff7; p { margin: 6px 0; } } }
  .sourceDetails pre { max-height: 360px; overflow: auto; padding: 16px; background: #f3f8fd; white-space: pre-wrap; overflow-wrap: anywhere; }
  .reviewActions { display: grid; gap: 12px; padding: 18px; border-radius: 10px; background: #eef7ff; label { font-size: 13px; } .el-checkbox { height: auto; :deep(.el-checkbox__label) { white-space: normal; line-height: 1.6; } } .actionRow { display: flex; flex-wrap: wrap; gap: 10px; .el-button { margin: 0; } } }
  .notice { color: #708297; font-size: 12px; line-height: 1.8; }
  .issues, .errorText { padding: 14px; color: #a3681b; border-radius: 8px; background: #fff7e8; line-height: 1.7; }
  @media (max-width: 850px) { .reviewColumns { grid-template-columns: 1fr; } header .el-select { margin-left: 0; } }
}
</style>
