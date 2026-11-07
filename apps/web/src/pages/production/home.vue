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
      <header class="homeHeader"><div><span class="eyebrow">AI SHORT DRAMA STUDIO</span><h1>短剧项目</h1></div><el-button @click="router.push('/classic-home')">原版功能与设置</el-button></header>
      <div class="homeContent">
        <section class="welcomeCard"><div><span class="eyebrow">从故事出发</span><h2>把一部故事，组织成完整短剧</h2><p>在生产工作台管理原文、分集、角色、镜头、任务与费用。画布保留给需要手动精修的镜头。</p><div class="welcomeActions"><el-button type="primary" size="large" :loading="opening" @click="chooseProject">新建或打开项目</el-button><el-button size="large" :disabled="!recentProjects.length || opening" @click="openProject(recentProjects[0]!)">继续最近项目</el-button></div></div><div class="welcomeArt" aria-hidden="true"><div class="filmFrame"><span>01</span><div class="horizon" /><div class="subject" /></div><div class="filmFrame second"><span>02</span><div class="horizon" /><div class="subject" /></div><div class="filmFrame third"><span>03</span><div class="horizon" /><div class="subject" /></div></div></section>
        <div class="sectionHeading"><div><h2>本地项目</h2><p>选择一个项目进入生产工作台</p></div><span>{{ recentProjects.length }} 个项目</span></div>
        <div v-if="recentProjects.length" class="projectGrid"><button v-for="item in recentProjects" :key="item.directory" class="projectCard" type="button" :disabled="opening" @click="openProject(item)"><span class="projectIcon">{{ item.name.slice(0, 1) || '剧' }}</span><strong>{{ item.name }}</strong><small :title="item.directory">{{ item.directory }}</small><span class="projectFooter">最近打开 {{ new Date(item.lastOpenedAt).toLocaleDateString() }}<b>进入工作台 →</b></span></button></div>
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
const recentProjects = computed(() => [...workspaceStore.projectList].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));

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
.studioHome { display: grid; grid-template-columns: 238px minmax(0, 1fr); width: 100%; height: 100dvh; overflow: hidden; color: var(--el-text-color-primary); background: var(--el-bg-color-page); }
.homeRail { display: flex; flex-direction: column; padding: 27px 16px 20px; border-right: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay); }
.brand { display: flex; align-items: center; gap: 11px; margin: 0 10px 42px; strong, small { display: block; } strong { font-size: 15px; } small { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 11px; letter-spacing: .08em; } }
.brandMark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--el-color-primary); color: white; font-weight: 700; }
.homeRail nav { display: grid; gap: 5px; button { width: 100%; padding: 12px 14px; border: 0; border-radius: 9px; color: var(--el-text-color-regular); background: transparent; text-align: left; cursor: pointer; &.active { color: var(--el-color-primary); background: var(--el-color-primary-light-9); font-weight: 700; } &:hover:not(:disabled) { background: var(--el-fill-color-light); } &:disabled { opacity: .5; cursor: default; } } }
.railNote { margin: auto 12px 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.6; }
.homeMain { min-width: 0; overflow: auto; }
.homeHeader { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 104px; padding: 20px 40px; border-bottom: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay); h1 { margin: 5px 0 0; font-size: 24px; } }
.eyebrow { color: var(--el-color-primary); font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.homeContent { max-width: 1480px; margin: 0 auto; padding: 34px 40px 60px; }
.welcomeCard { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(220px, .65fr); min-height: 290px; overflow: hidden; border: 1px solid var(--el-color-primary-light-7); border-radius: 18px; background: linear-gradient(125deg, var(--el-color-primary-light-9), var(--el-bg-color-overlay) 68%); }
.welcomeCard > div:first-child { padding: 42px; h2 { margin: 12px 0 16px; font-size: clamp(26px, 2.6vw, 37px); line-height: 1.25; } p { max-width: 650px; color: var(--el-text-color-secondary); line-height: 1.8; } }
.welcomeActions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; .el-button { margin: 0; } }
.welcomeArt { position: relative; min-height: 245px; transform: rotate(-9deg); .filmFrame { position: absolute; top: 40px; right: 105px; width: 175px; height: 220px; overflow: hidden; border: 7px solid var(--el-bg-color-overlay); border-radius: 14px; box-shadow: 0 15px 35px #0003; background: linear-gradient(150deg, #23466e, #7d89ad 57%, #d5a28f); span { position: absolute; z-index: 1; top: 12px; left: 12px; color: white; font-size: 11px; } &.second { right: 55px; top: 58px; transform: rotate(10deg); background: linear-gradient(160deg, #1d3855, #b5938d 58%, #e8c0a1); } &.third { right: 8px; top: 75px; transform: rotate(19deg); background: linear-gradient(160deg, #233f63, #7e84a2 58%, #bc816b); } .horizon { position: absolute; right: 0; bottom: 55px; left: 0; height: 2px; background: #ffffff90; } .subject { position: absolute; right: 46px; bottom: 0; width: 70px; height: 112px; border-radius: 40px 40px 0 0; background: #18283aaa; } } }
.sectionHeading { display: flex; align-items: end; justify-content: space-between; margin: 38px 0 18px; h2 { margin: 0 0 5px; font-size: 19px; } p, span { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; } }
.projectGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.projectCard { display: grid; justify-items: start; gap: 12px; min-width: 0; min-height: 195px; padding: 21px; border: 1px solid var(--el-border-color-light); border-radius: 13px; color: inherit; background: var(--el-bg-color-overlay); text-align: left; cursor: pointer; &:hover { border-color: var(--el-color-primary); } &:disabled { opacity: .6; cursor: wait; } strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; } small { max-width: 100%; overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; } }
.projectIcon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 11px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-weight: 700; }
.projectFooter { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; margin-top: auto; color: var(--el-text-color-secondary); font-size: 11px; b { color: var(--el-color-primary); font-weight: 600; } }
.emptyProjects { padding: 45px 20px; border: 1px dashed var(--el-border-color); border-radius: 13px; text-align: center; p { color: var(--el-text-color-secondary); } }
.workflowStrip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 34px; div { display: flex; align-items: center; gap: 9px; padding: 14px; border-radius: 10px; background: var(--el-fill-color-light); font-size: 12px; span { color: var(--el-color-primary); font-weight: 700; } } }
@media (max-width: 1100px) { .projectGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .homeContent { padding: 26px; } }
@media (max-width: 760px) { .studioHome { display: block; overflow: auto; } .homeRail { padding: 12px 16px; .brand, .railNote { display: none; } nav { display: flex; gap: 5px; overflow-x: auto; button { width: auto; min-width: max-content; } } } .homeMain { overflow: visible; } .homeHeader { min-height: 85px; padding: 16px; h1 { font-size: 21px; } } .homeContent { padding: 18px 16px 40px; } .welcomeCard { display: block; .welcomeArt { display: none; } > div:first-child { padding: 24px; } } .projectGrid { grid-template-columns: 1fr; } .workflowStrip { grid-template-columns: repeat(2, 1fr); } }
</style>
