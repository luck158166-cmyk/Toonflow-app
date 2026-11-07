<template>
  <section class="adaptationSetup">
    <h3>准备小说改编</h3><p>选择本集的章节、题材和画风，保存编剧所需的原文与连续性资料。当前仅准备输入，不调用模型。</p>
    <el-form labelPosition="top" @submit.prevent="prepare"><div class="fields">
      <el-form-item label="集号"><el-input-number v-model="episodeNumber" :min="1" /></el-form-item>
      <el-form-item label="起始章节序号"><el-input-number v-model="firstChapter" :min="1" :max="chapterCount" /></el-form-item>
      <el-form-item label="结束章节序号"><el-input-number v-model="lastChapter" :min="firstChapter" :max="chapterCount" /></el-form-item>
      <el-form-item label="目标时长（秒）"><el-input-number v-model="targetSeconds" :min="1" :max="600" /></el-form-item>
      <el-form-item label="题材"><el-input v-model="genre" maxlength="200" placeholder="例如：悬疑" /></el-form-item>
      <el-form-item label="画风"><el-input v-model="visualStyle" maxlength="200" placeholder="例如：三维动画" /></el-form-item>
    </div><el-button type="primary" :loading="busy" :disabled="!genre.trim() || !visualStyle.trim() || !chapterCount" @click="prepare">保存编剧输入</el-button></el-form>
    <p v-if="failure" role="alert" class="failure">{{ failure }}</p>
    <p v-if="receipt" role="status">{{ receipt }}</p>
    <ul v-if="inputs.length"><li v-for="input in inputs" :key="input.id">第 {{ input.episodeNumber }} 集 · 输入已保存 · {{ input.templateVersion }} · {{ new Date(input.createdAt).toLocaleString() }}</li></ul>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import productionApi, { type AdaptationInputSummary } from "@/lib/productionApi";
const props = defineProps<{ directory: string; projectId: string; chapterCount: number; nextEpisode: number; inputs: AdaptationInputSummary[] }>();
const emit = defineEmits<{ changed: [] }>();
const episodeNumber = ref(props.nextEpisode);
const firstChapter = ref(1); const lastChapter = ref(1); const targetSeconds = ref(60);
const genre = ref(""); const visualStyle = ref(""); const busy = ref(false);
const failure = ref(""); const receipt = ref("");
watch(() => [props.directory, props.projectId], () => {
  episodeNumber.value = props.nextEpisode; firstChapter.value = 1; lastChapter.value = 1;
  genre.value = ""; visualStyle.value = ""; failure.value = ""; receipt.value = "";
});
async function prepare() {
  if (busy.value) return;
  const directory = props.directory; const projectId = props.projectId;
  busy.value = true; failure.value = ""; receipt.value = "";
  try {
    await productionApi.prepareAdaptation(directory, projectId, { episodeNumber: episodeNumber.value,
      firstChapter: firstChapter.value, lastChapter: lastChapter.value, targetSeconds: targetSeconds.value,
      genre: genre.value.trim(), visualStyle: visualStyle.value.trim() });
    if (directory !== props.directory || projectId !== props.projectId) return;
    receipt.value = "编剧输入已保存，包含原文行号、创作要求和已有资产资料。模型执行尚未开放。";
    emit("changed");
  } catch (cause) {
    if (directory === props.directory && projectId === props.projectId) failure.value = axios.isAxiosError(cause)
      ? cause.response?.data?.message ?? cause.message : "编剧输入准备失败";
  } finally { busy.value = false; }
}
</script>

<style scoped lang="scss">
.adaptationSetup { p, li { font-size: 13px; line-height: 1.7; color: #50647b; } .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; } .failure { color: #ad402d; } }
</style>
