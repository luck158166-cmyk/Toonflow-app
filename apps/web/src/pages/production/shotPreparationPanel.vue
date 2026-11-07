<template>
  <section class="shotPreparationPanel">
    <header><div><h3>镜头制作资料</h3><p>按出场人物排列参考图，核对原对白与道具承接，再保存供提示词编译使用的版本。</p></div><el-button :loading="loading" :disabled="saving" @click="loadPreparation">重新检查</el-button></header>
    <el-select v-model="selectedId" :disabled="saving" aria-label="制作资料镜头" placeholder="选择镜头" popperClass="studioSelectPopup"><el-option v-for="shot in shots" :key="shot.id" :value="shot.id" :label="`第 ${shot.episodeNumber} 集 · 镜头 ${shot.sequence} · ${shot.title}`" /></el-select>
    <p v-if="errorText" class="errorText" role="alert">{{ errorText }}</p>
    <template v-if="report">
      <div v-if="report.issues.length" class="issues" role="alert"><strong>还有 {{ report.issues.length }} 项需要处理</strong><p v-for="(issue, index) in report.issues" :key="index">{{ issue.message }}</p><el-button @click="emit('openAssets')">查看参考图库</el-button></div>
      <div class="shotFacts"><h4>{{ report.snapshot.shot.title }} · {{ report.snapshot.shot.durationMs / 1000 }} 秒</h4><p>{{ report.snapshot.shot.scriptExcerpt }}</p><small>{{ report.snapshot.shot.shotSize }} · {{ report.snapshot.shot.movement }}</small></div>
      <div class="referenceGrid"><article v-for="slot in report.snapshot.references" :key="`${slot.entityId}:${slot.role}`"><div class="referenceImage"><referenceThumb v-if="slot.reference" :directory="directory" :projectId="projectId" :referenceId="slot.reference.id" :label="`${slot.name}${roleLabel(slot.role)}`" /><span v-else>缺少{{ roleLabel(slot.role) }}</span></div><b>图片 {{ slot.index }} · {{ slot.name }}</b><small>{{ roleLabel(slot.role) }} · {{ slot.reference ? `v${slot.reference.version}` : '待绑定' }}</small><p>{{ slot.description }}</p></article></div>
      <div class="contextColumns">
        <section><h4>对白原文</h4><p v-for="line in report.snapshot.dialogue" :key="line.id"><b>{{ line.speakerName || lineKind(line.kind) }}：</b>{{ line.text }}<small v-if="line.emotion">（{{ line.emotion }}）</small></p><p v-if="!report.snapshot.dialogue.length" class="notice">本镜头没有已记录对白。</p><small v-else>按 {{ report.snapshot.dialogueTiming.charactersPerSecond }} 字/秒粗估 {{ report.snapshot.dialogueTiming.estimatedSeconds.toFixed(1) }} 秒，实际音频生成后仍需对齐。</small><h4 v-if="report.snapshot.props.length">道具起止状态</h4><p v-for="prop in report.snapshot.props" :key="prop.propId"><b>{{ prop.propName }}</b>：{{ prop.holderBeforeName || '无人持有' }} / {{ prop.stateBefore }} → {{ prop.holderAfterName || '无人持有' }} / {{ prop.stateAfter }}；{{ prop.interaction }}</p></section>
        <section><h4>前后镜承接</h4><p><b>上一镜：</b>{{ report.snapshot.continuity.previousShot?.scriptExcerpt || '本集起始镜头' }}</p><p><b>下一镜：</b>{{ report.snapshot.continuity.nextShot?.scriptExcerpt || '本集结尾镜头' }}</p></section>
      </div>
      <details v-if="report.snapshot.shot.promptText"><summary>查看编剧草稿提示词（尚未编译）</summary><pre>{{ report.snapshot.shot.promptText }}</pre></details>
      <div class="saveActions"><el-button type="primary" :disabled="loading || !!report.issues.length || !!savedVersion" :loading="saving" @click="savePreparation">{{ savedVersion ? `当前资料已保存为 v${savedVersion.version}` : '保存镜头资料版本' }}</el-button><span>本地检查与保存，不调用模型。</span></div>
      <p class="notice">此版本保存镜头依据、原对白和原图顺序。片段划分、站位与动作细化、模型专用提示词、平台素材信任及费用预检仍需完成；保存不会把视频标为就绪。</p>
      <details v-if="report.history.length"><summary>资料版本记录（{{ report.history.length }}）</summary><p v-for="entry in report.history" :key="entry.id">v{{ entry.version }} · {{ new Date(entry.createdAt).toLocaleString() }} · {{ entry.inputHash === report.inputHash ? '与当前资料一致' : '旧版，保留原记录' }}</p></details>
    </template>
    <p v-else-if="!loading" class="notice">建立并审核分集后，在这里查看每个镜头的制作资料。</p>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import productionApi, { type ProjectProduction, type ReferenceRole, type ShotPreparation } from "@/lib/productionApi";
import referenceThumb from "./referenceThumb.vue";
const props = defineProps<{ directory: string; projectId: string; shots: ProjectProduction["shots"] }>();
const emit = defineEmits<{ openAssets: [] }>();
const selectedId = ref("");
const report = ref<ShotPreparation | null>(null);
const loading = ref(false); const saving = ref(false); const errorText = ref("");
let loadVersion = 0;
const savedVersion = computed(() => report.value?.history.find(item => item.inputHash === report.value?.inputHash));
watch(() => props.shots, shots => { if (!shots.some(item => item.id === selectedId.value)) selectedId.value = shots[0]?.id ?? ""; }, { immediate: true });
watch(() => [props.directory, props.projectId, selectedId.value], () => { void loadPreparation(); }, { immediate: true });
onBeforeUnmount(() => { loadVersion++; });
function roleLabel(role: ReferenceRole) { return { headshot: "面部图", fullBody: "全身妆造图", scene: "场景图", prop: "道具图", costume: "服装图" }[role]; }
function lineKind(kind: string) { return ({ narration: "旁白", voiceover: "画外音", phone: "电话", dialogue: "对白" } as Record<string, string>)[kind] ?? kind; }
function message(cause: unknown) { return axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "镜头资料操作失败"; }
async function loadPreparation() {
  const version = ++loadVersion; report.value = null; errorText.value = ""; loading.value = false;
  if (!props.directory || !props.projectId || !selectedId.value) return;
  loading.value = true;
  try { const result = await productionApi.getShotPreparation(props.directory, props.projectId, selectedId.value); if (version === loadVersion) report.value = result; }
  catch (cause) { if (version === loadVersion) errorText.value = message(cause); }
  finally { if (version === loadVersion) loading.value = false; }
}
async function savePreparation() {
  if (!report.value || report.value.issues.length || saving.value) return;
  const directory = props.directory; const projectId = props.projectId; const shotId = selectedId.value;
  const inputHash = report.value.inputHash; const version = loadVersion;
  saving.value = true; errorText.value = "";
  try {
    await productionApi.saveShotPreparation(directory, projectId, shotId, inputHash);
    if (version !== loadVersion) return;
    await loadPreparation(); ElMessage.success("镜头资料版本已保存，未启动生成");
  } catch (cause) { if (version === loadVersion) errorText.value = message(cause); }
  finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.shotPreparationPanel {
  header { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; h3 { margin: 0; } p { color: #708397; line-height: 1.7; } }
  > .el-select { max-width: 520px; }
  .issues, .errorText { margin-top: 16px; padding: 16px; border-radius: 10px; color: #8b571c; background: #fff5e6; p { margin: 8px 0; } }
  .shotFacts { margin: 20px 0; padding: 16px; border-radius: 10px; background: #eff7ff; h4 { margin-top: 0; } }
  .referenceGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; article { min-width: 0; b, small { display: block; margin-top: 9px; } p { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; } } .referenceImage { display: grid; place-items: center; height: 170px; border-radius: 10px; background: #eef4fa; color: #8296aa; } }
  .contextColumns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; line-height: 1.8; overflow-wrap: anywhere; }
  small, .notice { color: #708397; font-size: 12px; line-height: 1.8; }
  details { margin: 16px 0; summary { color: #1689ec; cursor: pointer; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } }
  .saveActions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 18px; span { color: #708397; font-size: 12px; } }
  @media(max-width: 700px) { .contextColumns { grid-template-columns: 1fr; gap: 4px; } }
}
</style>
