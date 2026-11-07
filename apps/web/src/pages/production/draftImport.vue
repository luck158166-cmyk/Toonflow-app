<template>
  <details class="draftImport"><summary>采用结构化编剧草稿</summary>
    <p>导入包含原文版本、分场剧本、人物、场景、道具和镜头的 JSON 草稿。通过校验后统一保存为待审核资料。</p>
    <input ref="fileInput" type="file" accept=".json,application/json" class="hiddenInput" @change="readDraft" />
    <el-button :disabled="busy" @click="fileInput?.click()">选择草稿文件</el-button>
    <div v-if="draftTitle" class="draftPreview"><strong>{{ draftTitle }}</strong><p>{{ draftSummary }}</p>
      <el-button type="primary" :loading="busy" @click="adopt">校验并采用草稿</el-button>
    </div>
    <p v-if="failure" role="alert" class="draftError">{{ failure }}</p>
    <p v-if="receipt" role="status">{{ receipt }}</p>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";
import productionApi from "@/lib/productionApi";

const props = defineProps<{ directory: string; projectId: string }>();
const emit = defineEmits<{ changed: [] }>();
const fileInput = ref<HTMLInputElement>();
const busy = ref(false);
const failure = ref("");
const receipt = ref("");
const draftTitle = ref("");
const draftSummary = ref("");
let payload: { sourceHash: string; draft: unknown } | null = null;
let readSequence = 0;
watch(() => [props.directory, props.projectId], () => { readSequence++; payload = null; draftTitle.value = ""; failure.value = ""; receipt.value = ""; });

async function readDraft(event: Event) {
  const request = ++readSequence;
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = "";
  payload = null; draftTitle.value = ""; failure.value = ""; receipt.value = "";
  if (!file) return;
  const directory = props.directory; const projectId = props.projectId;
  try {
    if (file.size > 2_000_000) throw new Error("草稿文件不能超过 2 MB");
    const contents = await file.text();
    if (request !== readSequence || props.directory !== directory || props.projectId !== projectId) return;
    const data = JSON.parse(contents);
    if (!data || typeof data.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(data.sourceHash)
      || !data.draft || typeof data.draft.title !== "string" || !Number.isSafeInteger(data.draft.episodeNumber)) {
      throw new Error("文件需包含 sourceHash 和 draft，draft 中需有集号和标题");
    }
    payload = { sourceHash: data.sourceHash, draft: data.draft };
    draftTitle.value = `第 ${data.draft.episodeNumber} 集 · ${data.draft.title}`;
    const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
    draftSummary.value = `${count(data.draft.script)} 场剧本 · ${count(data.draft.characters)} 人物 · ${count(data.draft.scenes)} 场景 · ${count(data.draft.props)} 道具 · ${count(data.draft.shots)} 镜头`;
  } catch (cause) { if (request === readSequence) failure.value = cause instanceof Error ? cause.message : "草稿文件无法读取"; }
}
async function adopt() {
  if (!payload || busy.value) return;
  const directory = props.directory; const projectId = props.projectId;
  busy.value = true; failure.value = "";
  try {
    await productionApi.adoptEpisodeDraft(directory, projectId, payload.sourceHash, payload.draft);
    if (props.directory !== directory || props.projectId !== projectId) return;
    payload = null; draftTitle.value = "";
    receipt.value = "剧本、资产和镜头已保存为待审核资料。尚未提交媒体生成任务。";
    emit("changed");
  } catch (cause) {
    if (props.directory !== directory || props.projectId !== projectId) return;
    if (axios.isAxiosError(cause)) {
      const response = cause.response?.data;
      const details = Array.isArray(response?.data) ? response.data.filter((item: unknown) => typeof item === "string").slice(0, 5).join("；") : "";
      failure.value = details || response?.message || cause.message;
    } else failure.value = "采用草稿失败";
  } finally { busy.value = false; }
}
</script>

<style scoped lang="scss">
.draftImport { color: #40566f; summary { color: #126fbc; cursor: pointer; font-weight: 650; } p { font-size: 13px; line-height: 1.7; } .hiddenInput { display: none; } .draftPreview { margin-top: 16px; padding: 16px; border: 1px solid #d6e6f6; border-radius: 10px; background: #f5faff; } .draftError { color: #ad402d; } }
</style>
