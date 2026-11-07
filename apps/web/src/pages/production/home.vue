<template>
  <main class="studioHome">
    <aside class="homeRail">
      <div class="brand"><span class="brandMark">映</span><div><strong>Toonflow Studio</strong><small>AI 短剧生产</small></div></div>
      <nav aria-label="主导航">
        <button class="active" type="button"><icon-layout-grid :size="18" />项目列表</button>
        <button type="button" :disabled="!workspaceStore.project" @click="openProject(workspaceStore.project!)"><icon-movie :size="18" />制作工作台</button>
        <studioSettings />
      </nav>
      <p class="railNote">本地工作区 · 生产资料保存在你的电脑上</p>
    </aside>
    <section class="homeMain">
      <header class="homeHeader">
        <div><span class="eyebrow">TOONFLOW STUDIO</span><h1>我的短剧</h1><p>从章节到成片，在一个工作台里完成创作。</p></div>
        <el-button type="primary" :loading="opening" @click="chooseProject">＋ 新建项目</el-button>
      </header>
      <div class="homeContent">
        <div class="projectControls">
          <el-input v-model="searchTerm" clearable aria-label="搜索项目" placeholder="搜索项目名称或原文" />
          <div class="filters" aria-label="项目筛选"><button v-for="item in filters" :key="item.value" type="button" :class="{ active: projectFilter === item.value }" @click="projectFilter = item.value">{{ item.label }}</button></div>
          <el-select v-model="projectSort" aria-label="项目排序" popperClass="studioSelectPopup"><el-option label="最近更新" value="recent" /><el-option label="名称排序" value="name" /></el-select>
          <button class="refreshButton" type="button" :disabled="loadingSummaries" @click="loadSummaries">{{ loadingSummaries ? '读取中…' : '刷新' }}</button>
        </div>
        <div class="projectLayout">
          <div class="projectArea">
            <div class="sectionHeading"><h2>我的项目</h2><span>{{ displayCards.length }} 个</span></div>
            <div v-if="displayCards.length" class="projectGrid">
              <article v-for="card in displayCards" :key="cardKey(card)" class="projectCard" :class="{ selected: selectedCard && cardKey(card) === cardKey(selectedCard) }">
                <button class="cardSelect" type="button" @click="selectedKey = cardKey(card)">
                  <span class="projectBanner"><small>{{ card.story ? sourceLabel(card.story.sourceKind) : '本地工作区' }}</small><strong>{{ card.story?.title || card.workspace.name }}</strong><em>{{ card.story ? storyStatus(card.story) : summaryErrors[card.workspace.directory] ? '读取失败' : '待导入' }}</em></span>
                  <span class="projectDescription">{{ card.story?.description || summaryErrors[card.workspace.directory] || '导入小说章节后，在此查看剧本、资产、分镜和成片进度。' }}</span>
                  <span class="progressLabel">{{ card.story ? `资料覆盖 ${dataStageCount(card.story)} / 4` : summaryErrors[card.workspace.directory] ? '项目资料暂不可读' : '尚未导入故事' }}</span>
                  <span class="progressTrack"><span :style="{ width: `${card.story ? dataStageCount(card.story) * 25 : 0}%` }" /></span>
                  <span class="cardNumbers"><span>章节 <b>{{ card.story?.chapterCount ?? 0 }}</b></span><span>分集 <b>{{ card.story?.episodeCount ?? 0 }}</b></span><span>角色 <b>{{ card.story?.characterCount ?? 0 }}</b></span><span>镜头 <b>{{ card.story?.shotCount ?? 0 }}</b></span></span>
                </button>
                <div class="projectFooter"><small>{{ card.story ? `更新于 ${formatDate(card.story.updatedAt)}` : `打开于 ${formatDate(card.workspace.lastOpenedAt)}` }}</small><button type="button" :disabled="opening" @click="openProject(card.workspace, card.story)">{{ card.story ? '继续制作' : summaryErrors[card.workspace.directory] ? '打开项目' : '导入章节' }} →</button></div>
              </article>
            </div>
            <div v-else class="emptyProjects"><strong>{{ recentProjects.length ? '没有匹配的项目' : '还没有短剧项目' }}</strong><p>{{ recentProjects.length ? '试试其他关键词或筛选条件。' : '选择一个本地文件夹建立项目，导入小说章节后开始制作。' }}</p><el-button v-if="!recentProjects.length" type="primary" @click="chooseProject">选择项目目录</el-button></div>
          </div>
          <aside class="projectPreview" aria-label="项目预览">
            <h2>项目预览</h2>
            <template v-if="selectedCard">
              <div class="previewBanner"><small>{{ selectedCard.story ? sourceLabel(selectedCard.story.sourceKind) : '本地工作区' }}</small><strong>{{ selectedCard.story?.title || selectedCard.workspace.name }}</strong></div>
              <span class="previewLabel">原文摘录</span><p>{{ selectedCard.story?.description || summaryErrors[selectedCard.workspace.directory] || '尚未导入故事。进入制作台后粘贴或导入小说章节。' }}</p>
              <span class="previewLabel">制作资料</span><div class="previewProgress"><span :style="{ width: `${selectedCard.story ? dataStageCount(selectedCard.story) * 25 : 0}%` }" /></div><small class="previewProgressText">{{ selectedCard.story ? `已建立 ${dataStageCount(selectedCard.story)} / 4 类制作资料` : summaryErrors[selectedCard.workspace.directory] ? '资料暂不可读' : '等待原文导入' }} · 此处不代表成片完成度</small>
              <dl><div><dt>章节</dt><dd>{{ selectedCard.story?.chapterCount ?? 0 }}</dd></div><div><dt>分集</dt><dd>{{ selectedCard.story?.episodeCount ?? 0 }}</dd></div><div><dt>人物</dt><dd>{{ selectedCard.story?.characterCount ?? 0 }}</dd></div><div><dt>场景</dt><dd>{{ selectedCard.story?.sceneCount ?? 0 }}</dd></div><div><dt>道具</dt><dd>{{ selectedCard.story?.propCount ?? 0 }}</dd></div><div><dt>镜头</dt><dd>{{ selectedCard.story?.shotCount ?? 0 }}</dd></div></dl>
              <button class="previewAction" type="button" :disabled="opening" @click="openProject(selectedCard.workspace, selectedCard.story)">{{ selectedCard.story ? '进入制作台' : summaryErrors[selectedCard.workspace.directory] ? '打开项目' : '导入小说章节' }} →</button>
            </template>
            <p v-else class="previewEmpty">选择左侧项目查看资料。</p>
          </aside>
        </div>
      </div>
    </section>
    <workspacePicker ref="projectPicker" hideTrigger lightTheme />
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import { ElMessage } from "element-plus";
import { IconLayoutGrid, IconMovie } from "@tabler/icons-vue";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import productionApi, { type StorySummary } from "@/lib/productionApi";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import workspacePicker from "@/pages/home/workspacePicker.vue";
import studioSettings from "./studioSettings.vue";

type ProjectCard = { workspace: Project; story: StorySummary | null };
const router = useRouter();
const workspaceStore = useWorkspaceStore();
const projectPicker = ref<InstanceType<typeof workspacePicker>>();
const opening = ref(false);
const loadingSummaries = ref(false);
const summaries = ref<Record<string, StorySummary[]>>({});
const summaryErrors = ref<Record<string, string>>({});
const selectedKey = ref("");
const searchTerm = ref("");
const projectSort = ref<"recent" | "name">("recent");
const projectFilter = ref<"all" | "story" | "empty">("all");
const filters = [{ label: "全部", value: "all" }, { label: "有故事", value: "story" }, { label: "待导入", value: "empty" }] as const;
const recentProjects = computed(() => [...workspaceStore.projectList].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
const cards = computed<ProjectCard[]>(() => recentProjects.value.flatMap<ProjectCard>(workspace => {
  const stories = summaries.value[workspace.directory] ?? [];
  return stories.length ? stories.map(story => ({ workspace, story })) : [{ workspace, story: null }];
}));
const displayCards = computed(() => cards.value.filter(card => {
  if (projectFilter.value === "story" && !card.story || projectFilter.value === "empty" && (card.story || summaryErrors.value[card.workspace.directory])) return false;
  const query = searchTerm.value.trim().toLocaleLowerCase();
  return !query || `${card.story?.title ?? ""} ${card.story?.description ?? ""} ${card.workspace.name}`.toLocaleLowerCase().includes(query);
}).sort((a, b) => projectSort.value === "name"
  ? (a.story?.title ?? a.workspace.name).localeCompare(b.story?.title ?? b.workspace.name, "zh-CN", { numeric: true })
  : (b.story?.updatedAt ?? b.workspace.lastOpenedAt) - (a.story?.updatedAt ?? a.workspace.lastOpenedAt)));
const selectedCard = computed(() => displayCards.value.find(card => cardKey(card) === selectedKey.value) ?? displayCards.value[0] ?? null);
let summaryRequest = 0;

watch(() => workspaceStore.projectList.map(item => item.directory).join("\u0000"), () => { void loadSummaries(); }, { immediate: true });

function cardKey(card: ProjectCard) { return JSON.stringify([card.workspace.directory, card.story?.id ?? null]); }
function sourceLabel(kind: StorySummary["sourceKind"]) { return { novel: "小说章节", synopsis: "故事梗概", script: "剧本" }[kind]; }
function storyStatus(story: StorySummary) { return story.shotCount ? "分镜已建" : story.episodeCount ? "分集已建" : "原文已导入"; }
function dataStageCount(story: StorySummary) { return 1 + Number(story.episodeCount > 0)
  + Number(story.characterCount > 0 && story.sceneCount > 0) + Number(story.shotCount > 0); }
function formatDate(value: number) { return new Date(value).toLocaleDateString("zh-CN"); }

async function loadSummaries() {
  const request = ++summaryRequest;
  const projects = recentProjects.value;
  loadingSummaries.value = true;
  const results = await Promise.allSettled(projects.map(project => productionApi.listStorySummaries(project.directory)));
  if (request !== summaryRequest) return;
  summaries.value = Object.fromEntries(projects.map((project, index) => [project.directory,
    results[index]?.status === "fulfilled" ? results[index].value : []]));
  summaryErrors.value = Object.fromEntries(projects.flatMap((project, index) => {
    const result = results[index];
    return result?.status === "rejected" ? [[project.directory, result.reason instanceof Error ? result.reason.message : "项目资料读取失败"]] : [];
  }));
  loadingSummaries.value = false;
}

async function chooseProject() {
  if (opening.value) return;
  const path = await projectPicker.value?.chooseDirectory();
  if (!path) return;
  opening.value = true;
  try {
    const files = useWorkspaceFiles(path);
    const { directory, empty } = await files.list();
    if (empty) await useWorkspaceFiles(directory).writeJson("画布1.json", { toonflowCanvas: true,
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, true);
    await workspaceStore.openProject(directory);
    await router.push("/production");
  } catch (cause) { showError(cause); }
  finally { opening.value = false; }
}

async function openProject(item: Project, story?: StorySummary | null) {
  if (opening.value) return;
  opening.value = true;
  try {
    await workspaceStore.openProject(item.directory);
    await router.push({ path: "/production", query: story ? { storyId: story.id } : {} });
  } catch (cause) { showError(cause); }
  finally { opening.value = false; }
}

function showError(cause: unknown) {
  ElMessage.error(axios.isAxiosError<{ message?: string }>(cause)
    ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "无法打开项目");
}
</script>

<style scoped lang="scss">
.studioHome { --el-bg-color-page: #f4f7fb; --el-bg-color: #fff; --el-bg-color-overlay: #fff; --el-fill-color-blank: #fff; --el-input-bg-color: #fff; --el-border-color: #d9e4ef; --el-border-color-light: #e3ebf4; --el-text-color-primary: #1d2d42; --el-text-color-secondary: #697b8f; --el-text-color-regular: #3c5067; --el-color-primary: #1689ec; --el-fill-color-light: #f2f7fc; display: grid; grid-template-columns: 222px minmax(0, 1fr); width: 100%; height: 100dvh; overflow: hidden; color: #1d2d42; background: #f4f7fb; }
.homeRail { display: flex; flex-direction: column; padding: 27px 16px 20px; border-right: 1px solid #e3ebf4; background: #fff; .brand { display: flex; align-items: center; gap: 11px; margin: 0 10px 42px; strong, small { display: block; } strong { font-size: 15px; } small { margin-top: 4px; color: #697b8f; font-size: 11px; } } nav { display: grid; gap: 5px; button { display: flex; align-items: center; gap: 11px; width: 100%; padding: 12px 14px; border: 0; border-radius: 9px; color: #3c5067; background: transparent; text-align: left; cursor: pointer; &.active { color: #0873c9; background: #e5f3ff; font-weight: 700; } &:hover:not(:disabled) { background: #f2f7fc; } &:disabled { opacity: .5; cursor: default; } } } .railNote { margin: auto 12px 0; color: #697b8f; font-size: 11px; line-height: 1.6; } }
.brandMark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; color: #fff; background: linear-gradient(135deg, #29b4ef, #627bfa); box-shadow: 0 5px 13px #1788ed38; font-weight: 700; }
.homeMain { min-width: 0; overflow: auto; }
.homeHeader { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 93px; padding: 18px 30px; border-bottom: 1px solid #e3ebf4; background: #fff; h1 { margin: 3px 0; font-size: 24px; } p { margin: 0; color: #697b8f; font-size: 12px; } .el-button--primary { padding-inline: 22px; } }
.eyebrow { color: #1689ec; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.homeContent { padding: 22px 30px 48px; }
.projectControls { display: flex; align-items: center; gap: 11px; padding: 13px 15px; border: 1px solid #e3ebf4; border-radius: 12px; background: #fff; .el-input { width: min(300px, 30%); } .el-select { width: 140px; margin-left: auto; } }
.filters { display: flex; gap: 4px; button { padding: 8px 12px; border: 0; border-radius: 7px; color: #50647b; background: transparent; cursor: pointer; &.active { color: #fff; background: #1689ec; } &:hover:not(.active) { background: #eaf5ff; } } }
.refreshButton { padding: 8px 12px; border: 1px solid #c7e2fa; border-radius: 7px; color: #126fbc; background: #eaf5ff; cursor: pointer; &:disabled { opacity: .55; } }
.projectLayout { display: grid; grid-template-columns: minmax(0, 1fr) 290px; align-items: start; gap: 16px; margin-top: 17px; }
.projectArea { min-width: 0; }
.sectionHeading { display: flex; justify-content: space-between; align-items: baseline; margin: 5px 0 14px; h2 { margin: 0; font-size: 18px; } span { color: #697b8f; font-size: 12px; } }
.projectGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(244px, 1fr)); gap: 14px; }
.projectCard { min-width: 0; padding: 11px; border: 1px solid #e3ebf4; border-radius: 12px; background: #fff; box-shadow: 0 4px 16px #334b680b; &.selected { border-color: #7287fc; box-shadow: 0 0 0 2px #7287fc3d; } }
.cardSelect { display: grid; justify-items: stretch; gap: 12px; width: 100%; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.projectBanner { display: grid; align-content: center; gap: 5px; position: relative; min-height: 82px; padding: 13px 14px; border-radius: 8px; color: #fff; background: linear-gradient(110deg, #ee5839, #d1356e 55%, #28b68b); small { font-size: 11px; } strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; } em { position: absolute; top: 11px; right: 10px; padding: 3px 6px; border-radius: 4px; color: #9b640e; background: #fff8dc; font-size: 10px; font-style: normal; } }
.projectCard:nth-child(3n + 2) .projectBanner { background: linear-gradient(110deg, #fa8d4c, #e95f78 55%, #f6bd56); }
.projectCard:nth-child(3n + 3) .projectBanner { background: linear-gradient(110deg, #9450e9, #6578ee 55%, #24bfcb); }
.projectDescription { display: -webkit-box; min-height: 34px; overflow: hidden; color: #50647b; font-size: 11px; line-height: 1.5; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.progressLabel { color: #697b8f; font-size: 10px; }
.progressTrack, .previewProgress { display: block; height: 6px; overflow: hidden; border-radius: 8px; background: #e8edf4; > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6c6cf2, #a64def); } }
.cardNumbers { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 6px 0; span { display: grid; gap: 3px; color: #8795a5; font-size: 10px; } b { color: #1d2d42; font-size: 14px; } }
.projectFooter { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 0 0; small { min-width: 0; overflow: hidden; color: #8795a5; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; } button { flex-shrink: 0; padding: 7px 9px; border: 0; border-radius: 6px; color: #fff; background: #1689ec; font-size: 11px; cursor: pointer; &:hover { background: #0873c9; } &:disabled { opacity: .55; } } }
.projectPreview { min-width: 0; padding: 18px; border: 1px solid #e3ebf4; border-radius: 12px; background: #fff; box-shadow: 0 4px 16px #334b680b; h2 { margin: 0 0 15px; font-size: 15px; } p { min-height: 48px; color: #50647b; font-size: 11px; line-height: 1.6; } dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 18px 0; div { display: grid; gap: 5px; } dt { color: #8795a5; font-size: 11px; } dd { margin: 0; font-size: 20px; } } }
.previewBanner { display: grid; gap: 5px; padding: 17px; border-radius: 9px; color: #fff; background: linear-gradient(110deg, #6470e9, #34bfd4); small { font-size: 11px; } strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; } }
.previewLabel { display: block; margin-top: 16px; color: #8795a5; font-size: 11px; }
.previewProgress { margin-top: 8px; }
.previewProgressText { display: block; margin-top: 6px; color: #697b8f; font-size: 10px; }
.previewAction { width: 100%; padding: 10px; border: 0; border-radius: 7px; color: #fff; background: #1689ec; cursor: pointer; font-weight: 700; &:hover { background: #0873c9; } &:disabled { opacity: .55; } }
.previewEmpty { padding: 55px 0; text-align: center; }
.emptyProjects { padding: 72px 20px; border: 1px dashed #c9d9e8; border-radius: 12px; text-align: center; p { color: #697b8f; } }
.studioHome :deep(.el-button--primary) { color: #fff; border-color: #1689ec; background: #1689ec; }
@media (max-width: 1100px) { .projectLayout { grid-template-columns: 1fr; } .projectPreview { order: -1; } .projectPreview dl { grid-template-columns: repeat(6, 1fr); } }
@media (max-width: 760px) { .studioHome { display: block; overflow: auto; } .homeRail { padding: 12px 16px; .brand, .railNote { display: none; } nav { display: flex; gap: 5px; overflow-x: auto; button { width: auto; min-width: max-content; } } } .homeMain { overflow: visible; } .homeHeader { padding: 16px; h1 { font-size: 20px; } p { display: none; } } .homeContent { padding: 16px; } .projectControls { flex-wrap: wrap; .el-input { width: 100%; } .el-select { margin-left: 0; } } .projectPreview dl { grid-template-columns: repeat(3, 1fr); } }
</style>

<style lang="scss">
.studioSelectPopup { --el-bg-color-overlay: #fff; --el-fill-color-blank: #fff; --el-fill-color-light: #eaf5ff; --el-text-color-primary: #1d2d42; --el-text-color-regular: #3c5067; --el-border-color-light: #d9e4ef; --el-color-primary: #1689ec; background: #fff; border-color: #d9e4ef; box-shadow: 0 12px 30px #2c527222; .el-select-dropdown__item { color: #3c5067; } .el-select-dropdown__item.is-selected { color: #0873c9; background: #eaf5ff; } .el-select-dropdown__item:hover { background: #f2f7fc; } }
</style>
