<template>
  <el-dialog v-model="visible" title="短剧生产" width="min(900px, calc(100vw - 32px))" appendToBody destroyOnClose>
    <div class="productionCenter">
      <section class="storyLibrary">
        <div class="sectionHeading">
          <h3>故事资料</h3>
          <el-button :loading="loading" @click="loadStories">刷新</el-button>
        </div>
        <el-empty v-if="!loading && stories.length === 0" description="还没有导入故事" :imageSize="80" />
        <div v-else class="storyList" v-loading="loading">
          <button v-for="story in stories" :key="story.id" class="storyItem" :class="{ selected: selectedStory?.id === story.id }" type="button" @click="selectStory(story.id)">
            <strong>{{ story.title }}</strong>
            <span>{{ sourceKindLabel(story.sourceKind) }} · {{ new Date(story.createdAt).toLocaleString() }}</span>
          </button>
        </div>
      </section>
      <section class="storyEditor">
        <div v-if="selectedStory" class="storyDetail">
          <div class="sectionHeading"><h3>{{ selectedStory.title }}</h3><el-button @click="selectedStory = null">关闭</el-button></div>
          <p>原文已保存在当前工作区的生产资料库。</p>
          <el-input :modelValue="selectedStory.sourceText" type="textarea" :rows="14" readonly aria-label="故事原文" />
        </div>
        <div v-else>
          <h3>导入故事</h3>
          <p>可粘贴梗概、小说或剧本，或读取本地 TXT / Markdown 文件。</p>
          <el-form labelPosition="top" @submit.prevent="importStory">
            <el-form-item label="标题"><el-input v-model="title" maxlength="200" showWordLimit /></el-form-item>
            <el-form-item label="来源类型">
              <el-select v-model="sourceKind"><el-option label="故事梗概" value="synopsis" /><el-option label="小说" value="novel" /><el-option label="剧本" value="script" /></el-select>
            </el-form-item>
            <el-form-item label="原文"><el-input v-model="sourceText" type="textarea" :rows="10" maxlength="1000000" showWordLimit /></el-form-item>
            <div class="importActions">
              <input ref="fileInput" class="fileInput" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" @change="loadFile" />
              <el-button @click="fileInput?.click()">读取 TXT / Markdown</el-button>
              <el-button type="primary" :loading="saving" :disabled="!title.trim() || !sourceText.trim()" @click="importStory">保存原文</el-button>
            </div>
          </el-form>
        </div>
      </section>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import axios from "axios";
import { ElMessage } from "element-plus";
import { ref, watch } from "vue";

type SourceKind = "synopsis" | "novel" | "script";
type Story = { id: string; title: string; sourceKind: SourceKind; workflowState: string; createdAt: number; updatedAt: number };
type StoryDetail = Story & { sourceText: string };

const props = defineProps<{ directory: string }>();
const visible = defineModel<boolean>({ required: true });
const stories = ref<Story[]>([]);
const selectedStory = ref<StoryDetail | null>(null);
const title = ref("");
const sourceKind = ref<SourceKind>("synopsis");
const sourceText = ref("");
const fileInput = ref<HTMLInputElement>();
const loading = ref(false);
const saving = ref(false);
const headers = { "x-toonflow-workspace": "1" };

watch([visible, () => props.directory], ([open]) => {
  selectedStory.value = null;
  stories.value = [];
  if (open && props.directory) void loadStories();
});

function sourceKindLabel(kind: SourceKind) {
  return { synopsis: "故事梗概", novel: "小说", script: "剧本" }[kind];
}

function errorMessage(cause: unknown) {
  return axios.isAxiosError<{ message?: string }>(cause)
    ? cause.response?.data?.message || cause.message
    : cause instanceof Error ? cause.message : "操作失败";
}

async function loadStories() {
  const directory = props.directory;
  if (!directory) return;
  loading.value = true;
  try {
    const { data } = await axios.get<{ data: { stories: Story[] } }>("/api/production/listStories", { params: { directory }, headers });
    if (props.directory === directory) stories.value = data.data.stories;
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    loading.value = false;
  }
}

async function selectStory(projectId: string) {
  const directory = props.directory;
  try {
    const { data } = await axios.get<{ data: { story: StoryDetail } }>("/api/production/getStory", { params: { directory, projectId }, headers });
    if (props.directory === directory && visible.value) selectedStory.value = data.data.story;
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  }
}

async function loadFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 4_000_000) throw new Error("文件超过 4 MB，请分段导入");
    const bytes = await file.arrayBuffer();
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { content = new TextDecoder("gbk", { fatal: true }).decode(bytes); }
    if (content.length > 1_000_000) throw new Error("原文超过 100 万字，请分段导入");
    sourceText.value = content.replace(/^\uFEFF/, "");
    title.value = file.name.replace(/\.(txt|md|markdown)$/i, "").slice(0, 200);
    sourceKind.value = "novel";
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    input.value = "";
  }
}

async function importStory() {
  const directory = props.directory;
  if (!directory || !title.value.trim() || !sourceText.value.trim() || saving.value) return;
  saving.value = true;
  try {
    const { data } = await axios.post<{ data: { projectId: string } }>("/api/production/importStory", {
      directory, title: title.value.trim(), sourceKind: sourceKind.value, sourceText: sourceText.value,
    }, { headers });
    if (props.directory !== directory) return;
    title.value = "";
    sourceText.value = "";
    await loadStories();
    await selectStory(data.data.projectId);
    ElMessage.success("故事原文已保存");
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.productionCenter {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) minmax(300px, 2fr);
  gap: 20px;
  max-height: 75vh;
  overflow: auto;

  .sectionHeading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h3 { margin: 0 0 12px; }
  p { color: var(--el-text-color-secondary); font-size: 13px; }
  .storyLibrary {
    .storyList { display: flex; flex-direction: column; gap: 6px; min-height: 120px; }
    .storyItem { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 1px solid var(--el-border-color); border-radius: 6px; background: transparent; text-align: left; color: inherit; cursor: pointer;
      &.selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
      span { font-size: 12px; color: var(--el-text-color-secondary); }
    }
  }
  .storyEditor {
    .importActions { display: flex; justify-content: flex-end; gap: 8px;
      .fileInput { display: none; }
    }
  }
}
@media (max-width: 680px) { .productionCenter { grid-template-columns: 1fr; } }
</style>
