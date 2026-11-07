<template>
  <main class="studioHome">
    <aside class="homeRail">
      <div class="brand"><span class="brandMark">映</span><div><strong>Toonflow Studio</strong><small>AI 短剧生产</small></div></div>
      <nav aria-label="主导航">
        <button class="active" type="button">项目首页</button>
        <button type="button" :disabled="!workspaceStore.project" @click="openProject(workspaceStore.project!)">继续制作</button>
        <button type="button" @click="router.push('/classic-home')">画布创作</button>
      </nav>
      <p class="railNote">本地工作区 · 生产资料保存在你的电脑上</p>
    </aside>
    <section class="homeMain">
      <header class="homeHeader"><div><span class="eyebrow">TOONFLOW STUDIO</span><h1>项目列表</h1></div><el-button type="primary" :loading="opening" @click="chooseProject">＋ 新建项目</el-button></header>
      <div class="homeContent">
        <section class="welcomeCard"><div><span class="eyebrow">从故事出发</span><h2>让小说章节进入短剧生产流程</h2><p>在一个工作台查看原文、分集、角色、场景、道具、分镜、任务和费用；需要时进入画布精修。</p><div class="welcomeActions"><el-button type="primary" size="large" :loading="opening" @click="chooseProject">新建或打开项目</el-button><el-button size="large" :disabled="!recentProjects.length || opening" @click="openProject(recentProjects[0]!)">继续最近项目</el-button></div></div></section>
        <div class="sectionHeading"><div><h2>本地项目</h2><p>选择一个项目进入生产工作台</p></div><span>{{ recentProjects.length }} 个项目</span></div>
        <div v-if="recentProjects.length" class="projectControls"><el-input v-model="searchTerm" clearable aria-label="搜索项目" placeholder="搜索项目名称或路径" /><el-select v-model="projectSort" aria-label="项目排序"><el-option label="最近打开" value="recent" /><el-option label="名称排序" value="name" /></el-select></div>
        <div v-if="displayProjects.length" class="projectGrid"><button v-for="item in displayProjects" :key="item.directory" class="projectCard" type="button" :disabled="opening" @click="openProject(item)"><span class="projectBanner"><span class="projectIcon">{{ item.name.slice(0, 1) || '剧' }}</span><strong>{{ item.name }}</strong></span><small :title="item.directory">{{ item.directory }}</small><span class="projectFooter">最近打开 {{ new Date(item.lastOpenedAt).toLocaleDateString() }}<b>进入工作台 →</b></span></button></div>
        <div v-else-if="recentProjects.length" class="emptyProjects">没有匹配的项目</div>
        <div v-else class="emptyProjects"><strong>还没有短剧项目</strong><p>选择一个空文件夹建立项目，或选择已有 Toonflow 工作区继续。</p><el-button @click="chooseProject">选择项目目录</el-button></div>
        <section class="workflowStrip"><div><span>01</span><strong>导入故事</strong></div><div><span>02</span><strong>分集与资产</strong></div><div><span>03</span><strong>镜头与任务</strong></div><div><span>04</span><strong>成片与费用</strong></div></section>
      </div>
    </section>
    <workspacePicker ref="projectPicker" hideTrigger />
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import { ElMessage } from "element-plus";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import workspacePicker from "@/pages/home/workspacePicker.vue";

const router = useRouter();
const workspaceStore = useWorkspaceStore();
const projectPicker = ref<InstanceType<typeof workspacePicker>>();
const opening = ref(false);
const searchTerm = ref("");
const projectSort = ref<"recent" | "name">("recent");
const recentProjects = computed(() => [...workspaceStore.projectList].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
const displayProjects = computed(() => {
  const query = searchTerm.value.trim().toLocaleLowerCase();
  const filtered = recentProjects.value.filter(item => !query || `${item.name} ${item.directory}`.toLocaleLowerCase().includes(query));
  return projectSort.value === "name" ? filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })) : filtered;
});

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

async function openProject(item: Project) {
  if (opening.value) return;
  opening.value = true;
  try { await workspaceStore.openProject(item.directory); await router.push("/production"); }
  catch (cause) { showError(cause); }
  finally { opening.value = false; }
}

function showError(cause: unknown) {
  ElMessage.error(axios.isAxiosError<{ message?: string }>(cause)
    ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "无法打开项目");
}
</script>

<style scoped lang="scss">
.studioHome { --el-bg-color-page: #f4f7fb; --el-bg-color-overlay: #fff; --el-border-color: #d9e4ef; --el-border-color-light: #e3ebf4; --el-text-color-primary: #1d2d42; --el-text-color-secondary: #697b8f; --el-text-color-regular: #3c5067; --el-color-primary: #1689ec; --el-color-primary-light-9: #eaf5ff; --el-color-primary-light-7: #b9ddfb; --el-fill-color-light: #f2f7fc; display: grid; grid-template-columns: 222px minmax(0, 1fr); width: 100%; height: 100dvh; overflow: hidden; color: var(--el-text-color-primary); background: var(--el-bg-color-page); }
.homeRail { display: flex; flex-direction: column; padding: 27px 16px 20px; border-right: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay); }
.brand { display: flex; align-items: center; gap: 11px; margin: 0 10px 42px; strong, small { display: block; } strong { font-size: 15px; } small { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 11px; letter-spacing: .08em; } }
.brandMark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: linear-gradient(135deg, #29b4ef, #627bfa); color: white; font-weight: 700; box-shadow: 0 5px 13px #1788ed38; }
.homeRail nav { display: grid; gap: 5px; button { width: 100%; padding: 12px 14px; border: 0; border-radius: 9px; color: var(--el-text-color-regular); background: transparent; text-align: left; cursor: pointer; &.active { color: #0873c9; background: #e5f3ff; font-weight: 700; } &:hover:not(:disabled) { background: var(--el-fill-color-light); } &:disabled { opacity: .5; cursor: default; } } }
.railNote { margin: auto 12px 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.6; }
.homeMain { min-width: 0; overflow: auto; }
.homeHeader { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 88px; padding: 20px 40px; border-bottom: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay); h1 { margin: 5px 0 0; font-size: 24px; } .el-button--primary { padding-inline: 22px; box-shadow: 0 6px 15px #1689ec30; } }
.eyebrow { color: var(--el-color-primary); font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.homeContent { max-width: 1480px; margin: 0 auto; padding: 28px 40px 60px; }
.welcomeCard { overflow: hidden; border: 1px solid #d4e7f8; border-radius: 16px; background: linear-gradient(105deg, #eaf6ff, #f7fbff 58%, #fff); box-shadow: 0 7px 24px #3157820d; }
.welcomeCard > div:first-child { padding: 30px 36px; h2 { margin: 9px 0 10px; font-size: clamp(24px, 2.4vw, 32px); line-height: 1.3; } p { max-width: 740px; margin: 0; color: var(--el-text-color-secondary); line-height: 1.7; } }
.welcomeActions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; .el-button { margin: 0; } .el-button:not(.el-button--primary) { color: #1477c9; border-color: #bddfff; background: #fff; } }
.sectionHeading { display: flex; align-items: end; justify-content: space-between; margin: 38px 0 18px; h2 { margin: 0 0 5px; font-size: 19px; } p, span { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; } }
.projectControls { display: flex; gap: 10px; max-width: 560px; margin: 0 0 16px; .el-select { flex: 0 0 140px; } }
.projectGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.projectCard { display: grid; justify-items: stretch; gap: 13px; min-width: 0; min-height: 185px; padding: 12px; border: 1px solid var(--el-border-color-light); border-radius: 13px; color: inherit; background: var(--el-bg-color-overlay); text-align: left; cursor: pointer; box-shadow: 0 5px 18px #334b680b; transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; &:hover { border-color: #9fcffa; box-shadow: 0 12px 26px #2668a31c; transform: translateY(-2px); } &:disabled { opacity: .6; cursor: wait; } small { max-width: 100%; margin: 0 4px; overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; } }
.projectBanner { display: flex; align-items: center; gap: 12px; min-height: 86px; padding: 16px; border-radius: 9px; color: #fff; background: linear-gradient(110deg, #5f6ff0, #6d9ef3 55%, #2bbbd1); strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; } }
.projectCard:nth-child(3n + 2) .projectBanner { background: linear-gradient(110deg, #fa8d4c, #f5af77 58%, #f6c86a); }
.projectCard:nth-child(3n + 3) .projectBanner { background: linear-gradient(110deg, #254061, #3d648a 60%, #5291ac); }
.projectIcon { display: grid; flex: 0 0 34px; place-items: center; width: 34px; height: 34px; border: 1px solid #ffffffa8; border-radius: 10px; background: #ffffff26; color: #fff; font-weight: 700; }
.projectFooter { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; margin-top: auto; padding: 0 4px 3px; color: var(--el-text-color-secondary); font-size: 11px; b { padding: 7px 10px; border-radius: 6px; color: #fff; background: #1689ec; font-weight: 600; } }
.emptyProjects { padding: 45px 20px; border: 1px dashed var(--el-border-color); border-radius: 13px; text-align: center; p { color: var(--el-text-color-secondary); } }
.workflowStrip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 34px; div { display: flex; align-items: center; gap: 9px; padding: 14px; border: 1px solid #dceaf7; border-radius: 10px; background: #fff; font-size: 12px; span { color: var(--el-color-primary); font-weight: 700; } } }
.studioHome :deep(.el-button:not(.is-text):not(.el-button--primary)) { color: #126fbc; border-color: #c7e2fa; background: #eef7ff; }
.studioHome :deep(.el-button:not(.is-text):not(.el-button--primary):hover) { color: #075c9f; border-color: #a7d4f8; background: #e1f1ff; }
.studioHome :deep(.el-button--primary) { color: #fff; border-color: #1689ec; background: #1689ec; box-shadow: 0 5px 13px #1689ec28; }
@media (max-width: 1100px) { .projectGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .homeContent { padding: 26px; } }
@media (max-width: 760px) { .studioHome { display: block; overflow: auto; } .homeRail { padding: 12px 16px; .brand, .railNote { display: none; } nav { display: flex; gap: 5px; overflow-x: auto; button { width: auto; min-width: max-content; } } } .homeMain { overflow: visible; } .homeHeader { min-height: 85px; padding: 16px; h1 { font-size: 21px; } } .homeContent { padding: 18px 16px 40px; } .welcomeCard > div:first-child { padding: 24px; } .projectGrid { grid-template-columns: 1fr; } .projectControls { .el-select { flex-basis: 120px; } } .workflowStrip { grid-template-columns: repeat(2, 1fr); } }
</style>
