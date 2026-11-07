<template>
  <div class="dashboard">
    <div class="dashboardIntro"><div><span class="kicker">AI SHORT DRAMA STUDIO</span><h2>{{ project?.story.title || '从小说章节开始制作' }}</h2><p>{{ project ? `${project.story.sourceText.slice(0, 100)}${project.story.sourceText.length > 100 ? '…' : ''}` : '导入章节后先自动识别原文位置，再逐步进入改编、资产、分镜和成片。' }}</p></div><div class="introFacts"><span>故事 {{ storyCount }}</span><span>分集 {{ project?.episodes.length ?? 0 }}</span><span>镜头 {{ project?.shots.length ?? 0 }}</span><span>{{ budgetLabel }}</span></div></div>
    <div class="startGrid">
      <section class="startCard"><div class="stepTitle"><span>01</span><div><small>输入素材</small><h3>{{ project ? '已导入的故事' : '导入小说章节' }}</h3></div></div>
        <template v-if="project"><div class="sourceSummary"><strong>{{ project.story.title }}</strong><p>原文已保存。{{ project.chapterIndex ? `识别到 ${project.chapterIndex.chapters.length} 个章节` : '当前来源不是小说章节。' }}</p><p v-if="project.chapterIndex?.issues.length" class="sourceWarning">{{ project.chapterIndex.issues[0] }}</p></div><button class="secondaryAction" type="button" @click="emit('openStage', 'stories')">查看原文与章节 →</button></template>
        <template v-else><label for="studioNovelTitle">故事标题</label><input id="studioNovelTitle" v-model="novelTitle" maxlength="200" placeholder="例如：第一卷·雨夜追踪" /><label for="studioNovelText">粘贴章节原文</label><textarea id="studioNovelText" v-model="novelText" maxlength="1000000" rows="8" placeholder="从“第一章”开始粘贴小说内容，或读取 TXT / Markdown 文件" /><div class="sourceActions"><input ref="novelFileInput" class="hiddenInput" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" @change="emit('fileChange', $event)" /><button class="secondaryAction" type="button" @click="novelFileInput?.click()">读取文件</button><button class="primaryAction" type="button" :disabled="savingStory || !novelTitle.trim() || !novelText.trim()" @click="emit('importNovel')">{{ savingStory ? '保存中…' : '保存并识别章节' }}</button></div></template>
      </section>
      <section class="startCard"><div class="stepTitle"><span>02</span><div><small>自动制作</small><h3>生产状态</h3></div></div><div class="statusList"><div><b>章节识别</b><span>{{ project?.chapterIndex?.chapters.length ? `已识别 ${project.chapterIndex.chapters.length} 章` : '等待导入' }}</span></div><div><b>分集剧本</b><span>{{ project?.episodes.length ? `已有 ${project.episodes.length} 集资料` : '尚无剧本' }}</span></div><div><b>角色与场景</b><span>{{ project?.assets.length || project?.scenes.length ? `已有 ${project.assets.length + project.scenes.length} 项资产` : '尚无资产' }}</span></div><div><b>分镜与视频</b><span>{{ project?.shots.length ? `已有 ${project.shots.length} 个镜头` : '尚无镜头' }}</span></div><div><b>成片</b><span>{{ project?.tasks.some(task => task.stage === 'synthesis' && task.outputCount > 0) ? '已有合成任务产物' : '尚无成片' }}</span></div></div><div class="blockingNote"><strong>自动出片尚未开放</strong><p>当前可自动完成原文保存和章节定位；自动编剧、提示词、媒体生成与成片链路仍在开发。这里不会假装启动，也不会产生模型费用。</p></div><button v-if="project" class="secondaryAction" type="button" @click="emit('openStage', 'episodes')">查看分集资料 →</button></section>
    </div>
    <div v-if="attentionTasks" class="attentionBanner"><span>{{ attentionTasks }} 个任务需要失败处理或供应商对账，已成功产物不会自动重新提交。</span><button type="button" @click="emit('openStage', 'tasks')">查看任务 →</button></div>
    <div v-if="pendingReview" class="attentionBanner reviewBanner"><span>{{ pendingReview }} 个镜头尚未完成内容确认。</span><button type="button" @click="emit('openStage', 'shots')">逐镜检查 →</button></div>
    <details class="detailPanels"><summary>展开制作详情：剧本、角色、分镜、场景与成片</summary><div class="topGrid">
      <section class="studioPanel scriptPanel"><div class="panelHeader"><div><small>01 / 剧本</small><h3>剧本与分集</h3></div><button type="button" @click="emit('openStage', 'episodes')">进入编辑 →</button></div><div class="scriptPaper"><template v-if="latestEpisode"><span>第 {{ latestEpisode.episodeNumber }} 集 · {{ latestEpisode.title }}</span><p>{{ latestEpisode.logline || '本集梗概尚未填写' }}</p><ol v-if="latestEpisode.outline.length"><li v-for="(beat, index) in latestEpisode.outline.slice(0, 4)" :key="index">{{ beat }}</li></ol><small>已保存 {{ latestEpisode.script.length }} 个剧本场次</small></template><p v-else>尚未建立分集。先导入故事，再写分集梗概和剧本。</p></div></section>
      <section class="studioPanel workflowPanel"><div class="panelHeader"><div><small>02 / 流程</small><h3>自动生产路径</h3></div><button type="button" @click="emit('openStage', 'tasks')">任务列表 →</button></div><div class="workflow"><button v-for="(step, index) in workflow" :key="step.label" type="button" class="workflowStep" :class="{ ready: step.ready }" @click="emit('openStage', step.stage)"><span class="stepIndex">{{ String(index + 1).padStart(2, '0') }}</span><span class="stepName">{{ step.label }}</span><span class="stepState">{{ step.ready ? '有资料' : '待开始' }}</span></button></div><p class="workflowNote">真实模型任务需要单独授权内容、次数和预算。</p></section>
      <section class="studioPanel characterPanel"><div class="panelHeader"><div><small>03 / 资产</small><h3>角色一览</h3></div><button type="button" @click="emit('openStage', 'assets')">查看资产 →</button></div><div v-if="characters.length" class="characterList"><article v-for="asset in characters" :key="asset.id"><div class="portrait">{{ asset.name.slice(0, 1) }}</div><strong>{{ asset.name }}</strong><small>{{ asset.stableDescription || '外观待确认' }}</small><span>{{ asset.locked ? '已锁定' : '待确认' }}</span></article></div><div v-else class="panelEmpty">尚无角色资产。提取候选和角色设定会显示在这里。</div></section>
    </div>
    <div class="middleGrid">
      <section class="studioPanel timelinePanel"><div class="panelHeader"><div><small>04 / 分镜</small><h3>分镜时间轴</h3></div><button type="button" @click="emit('openStage', 'shots')">镜头详情 →</button></div><div v-if="shots.length" class="shotStrip"><article v-for="shot in shots" :key="shot.id"><div class="shotVisual"><span>{{ shot.episodeNumber }}—{{ String(shot.sequence).padStart(2, '0') }}</span><strong>{{ shot.title || '未命名镜头' }}</strong></div><small>{{ (shot.durationMs / 1000).toFixed(1) }} 秒 · {{ shot.videoReadiness === 'ready' ? '视频就绪' : '待生成' }}</small></article></div><div v-else class="panelEmpty">分镜尚未建立。完成剧本和资产后，在镜头工作台逐镜规划。</div></section>
      <section class="studioPanel scenePanel"><div class="panelHeader"><div><small>05 / 场景</small><h3>场景管理</h3></div><button type="button" @click="emit('openStage', 'assets')">查看场景 →</button></div><div v-if="scenes.length" class="sceneGrid"><article v-for="scene in scenes" :key="scene.id"><div class="sceneVisual"><span>{{ scene.name.slice(0, 1) }}</span></div><strong>{{ scene.name }}</strong><small>{{ scene.location || scene.atmosphere || '场景描述待补充' }}</small></article></div><div v-else class="panelEmpty">尚无场景。场景资料建立后可在此快速查看。</div></section>
    </div>
    <section class="studioPanel previewPanel"><div class="panelHeader"><div><small>06 / 成片</small><h3>成片预览</h3></div><button type="button" @click="emit('openStage', 'exports')">成片管理 →</button></div><div class="previewLayout"><div class="videoPlaceholder"><div class="portraitFrame"><span>9:16</span><strong>成片待生成</strong><small>完成镜头生成和合成后在此预览</small></div></div><div class="previewFacts"><h4>交付规格</h4><dl><div><dt>画幅</dt><dd>竖屏 9:16</dd></div><div><dt>分辨率</dt><dd>1080 × 1920</dd></div><div><dt>格式</dt><dd>MP4 · H.264 + AAC</dd></div><div><dt>已保存任务</dt><dd>{{ project?.tasks.length ?? 0 }}</dd></div></dl><button type="button" @click="emit('openStage', 'costs')">查看费用与备份 →</button></div></div></section></details>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { BudgetOverview, ProjectProduction } from "@/lib/productionApi";

type Stage = "stories" | "episodes" | "assets" | "shots" | "tasks" | "exports" | "costs";
const props = defineProps<{ project: ProjectProduction | null; storyCount: number; budget: BudgetOverview | null; savingStory: boolean }>();
const emit = defineEmits<{ openStage: [stage: Stage]; importNovel: []; fileChange: [event: Event] }>();
const novelTitle = defineModel<string>("storyTitle", { default: "" });
const novelText = defineModel<string>("storyText", { default: "" });
const novelFileInput = ref<HTMLInputElement>();
const latestEpisode = computed(() => props.project?.episodes[0] ?? null);
const characters = computed(() => props.project?.assets.filter(asset => asset.kind === "character").slice(0, 3) ?? []);
const scenes = computed(() => props.project?.scenes.slice(0, 4) ?? []);
const shots = computed(() => props.project?.shots.slice(0, 8) ?? []);
const budgetLabel = computed(() => !props.budget?.global.configured ? "预算未设置"
  : props.budget.global.limitMicros <= 0 ? "新增付费已停止"
    : `预算占用 ${Math.round(props.budget.global.usedMicros / props.budget.global.limitMicros * 100)}%`);
const attentionTasks = computed(() => props.project?.tasks.filter(task => ["failed", "reconcile_required", "reconciling"].includes(task.state)).length ?? 0);
const pendingReview = computed(() => props.project?.shots.filter(shot => shot.reviewState !== "confirmed").length ?? 0);
const workflow = computed(() => [
  { label: "故事分析与分集", stage: "episodes" as Stage, ready: !!props.project?.episodes.length },
  { label: "角色与场景", stage: "assets" as Stage, ready: !!(props.project?.assets.length || props.project?.scenes.length) },
  { label: "镜头规划", stage: "shots" as Stage, ready: !!props.project?.shots.length },
  { label: "画面与视频生成", stage: "tasks" as Stage, ready: !!props.project?.tasks.some(task => task.outputCount > 0) },
  { label: "成片合成", stage: "exports" as Stage, ready: !!props.project?.tasks.some(task => task.stage === "synthesis" && task.outputCount > 0) },
]);
</script>

<style scoped lang="scss">
.dashboard { display: grid; gap: 16px; color: #1d2d42; }
.startGrid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(310px, .9fr); align-items: start; gap: 16px; }
.startCard { min-width: 0; padding: 22px; border: 1px solid #dbe8f4; border-radius: 13px; background: #fff; box-shadow: 0 5px 20px #334b6810; label { display: block; margin: 15px 0 7px; color: #50647b; font-size: 12px; font-weight: 650; } input:not([type='file']), textarea { box-sizing: border-box; width: 100%; padding: 11px 13px; border: 1px solid #d9e4ef; border-radius: 8px; outline: none; color: #1d2d42; background: #fff; font: inherit; font-size: 12px; &:focus { border-color: #1689ec; box-shadow: 0 0 0 3px #1689ec1c; } } textarea { min-height: 186px; resize: vertical; line-height: 1.6; } }
.stepTitle { display: flex; align-items: center; gap: 11px; margin-bottom: 12px; > span { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; color: #fff; background: #1689ec; font-size: 12px; font-weight: 700; } small { color: #6c83a0; font-size: 10px; } h3 { margin: 3px 0 0; font-size: 17px; } }
.sourceActions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 15px; }
.hiddenInput { display: none; }
.primaryAction, .secondaryAction { padding: 10px 15px; border-radius: 7px; cursor: pointer; font-weight: 700; }
.primaryAction { border: 1px solid #1689ec; color: #fff; background: #1689ec; box-shadow: 0 5px 13px #1689ec28; &:hover { background: #0873c9; } &:disabled { opacity: .5; cursor: default; } }
.secondaryAction { border: 1px solid #c7e2fa; color: #126fbc; background: #eaf5ff; &:hover { background: #dcefff; } }
.sourceSummary { padding: 20px; border: 1px solid #dceaf7; border-radius: 9px; background: #f8fbff; strong { font-size: 16px; } p { color: #50647b; font-size: 12px; line-height: 1.7; } .sourceWarning { color: #a56313; } }
.statusList { display: grid; gap: 7px; margin-top: 16px; > div { display: flex; justify-content: space-between; gap: 12px; padding: 9px 11px; border: 1px solid #e3ebf4; border-radius: 7px; background: #f9fcff; font-size: 11px; } b { font-weight: 600; } span { color: #697b8f; text-align: right; } }
.blockingNote { margin: 15px 0; padding: 13px; border: 1px solid #f0dbb7; border-radius: 8px; color: #8e5e18; background: #fff8ea; strong { font-size: 12px; } p { margin: 5px 0 0; font-size: 11px; line-height: 1.6; } }
.detailPanels { margin-top: 6px; summary { margin-bottom: 16px; padding: 14px 18px; border: 1px solid #dbe8f4; border-radius: 10px; color: #126fbc; background: #eaf5ff; cursor: pointer; font-size: 12px; font-weight: 700; } }
.dashboardIntro { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding: 6px 2px 12px; h2 { margin: 8px 0; font-size: 25px; } p { max-width: 690px; margin: 0; color: #697b8f; line-height: 1.6; } }
.introTools { display: grid; justify-items: end; gap: 12px; }
.introAction { padding: 11px 18px; border: 1px solid #1689ec; border-radius: 8px; color: #fff; background: #1689ec; box-shadow: 0 6px 15px #1689ec30; font-size: 12px; font-weight: 700; cursor: pointer; &:hover { background: #0873c9; } }
.kicker, .studioPanel .panelHeader small { color: #1689ec; font-size: 10px; font-weight: 700; letter-spacing: .14em; }
.introFacts { display: flex; gap: 8px; flex-wrap: wrap; span { padding: 7px 10px; border: 1px solid #d7e7f5; border-radius: 7px; color: #4a6a88; background: #fff; font-size: 11px; white-space: nowrap; } }
.attentionBanner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border: 1px solid #efd7ac; border-radius: 8px; background: #fff7e8; color: #98621b; font-size: 11px; button { padding: 6px 10px; border: 0; border-radius: 6px; color: #fff; background: #d99134; cursor: pointer; white-space: nowrap; } &.reviewBanner { border-color: #c7e2fb; background: #edf7ff; color: #286da6; button { background: #1689ec; } } }
.topGrid, .middleGrid { display: grid; gap: 16px; }
.topGrid { grid-template-columns: 1.12fr .9fr 1fr; }
.middleGrid { grid-template-columns: 1.35fr 1fr; }
.studioPanel { min-width: 0; padding: 17px; border: 1px solid #e0e9f2; border-radius: 13px; background: #fff; box-shadow: 0 5px 20px #334b6810; }
.panelHeader { display: flex; align-items: start; justify-content: space-between; gap: 8px; margin-bottom: 13px; h3 { margin: 5px 0 0; font-size: 16px; } button { padding: 7px 10px; border: 0; border-radius: 6px; color: #126fbc; background: #eaf5ff; white-space: nowrap; cursor: pointer; font-size: 11px; &:hover { color: #075c9f; background: #dcefff; } } }
.scriptPaper { min-height: 202px; max-height: 230px; overflow: auto; padding: 15px; border: 1px solid #dceaf7; border-radius: 9px; background: #f8fbff; color: #3f536a; font-size: 12px; line-height: 1.7; span { color: #1677c9; font-weight: 700; } p { margin: 10px 0; } ol { margin: 7px 0; padding-left: 18px; } small { color: #70839a; } }
.workflow { display: grid; gap: 5px; }
.workflowStep { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 33px; padding: 6px 9px; border: 1px solid #dceaf7; border-radius: 7px; color: #3f536a; background: #f9fcff; cursor: pointer; text-align: left; &.ready { border-color: #bfe6d4; background: #eefbf4; } &:hover { border-color: #94c9f4; } .stepIndex { color: #1689ec; font-size: 10px; } .stepName { flex: 1; font-size: 11px; } .stepState { color: #64829c; font-size: 10px; } }
.workflowNote { margin: 10px 0 0; color: #73869b; font-size: 10px; line-height: 1.5; }
.characterList { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; article { display: grid; gap: 5px; min-width: 0; padding: 7px; border: 1px solid #dce9f5; border-radius: 9px; background: #f9fcff; strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; } small { overflow: hidden; color: #70839a; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; } span { color: #1677c9; font-size: 10px; } } .portrait { display: grid; place-items: center; height: 115px; margin-bottom: 4px; border-radius: 6px; background: linear-gradient(140deg, #d9eefe, #dbe1ff 55%, #f6dff3); color: #406ba7; font-size: 35px; } }
.panelEmpty { display: grid; place-items: center; min-height: 130px; padding: 20px; border: 1px dashed #ccdeed; border-radius: 8px; color: #77899c; background: #f9fcff; text-align: center; font-size: 12px; line-height: 1.6; }
.shotStrip { display: flex; gap: 9px; overflow-x: auto; padding-bottom: 5px; article { flex: 0 0 112px; min-width: 0; small { color: #71869b; font-size: 10px; } } .shotVisual { display: flex; flex-direction: column; justify-content: space-between; height: 105px; margin-bottom: 6px; padding: 9px; border: 1px solid #cbdff1; border-radius: 7px; background: linear-gradient(160deg, #e6f5ff, #dbe8ff); span { color: #2079b6; font-size: 10px; } strong { color: #294a6b; font-size: 11px; } } }
.sceneGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; article { min-width: 0; padding: 6px; border: 1px solid #dce9f5; border-radius: 8px; background: #f9fcff; strong, small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } strong { margin-top: 5px; font-size: 11px; } small { color: #70839a; font-size: 10px; } } .sceneVisual { display: grid; place-items: center; height: 60px; border-radius: 5px; background: linear-gradient(125deg, #d5ebff, #c9def5 70%); color: #326fa6; font-size: 22px; } }
.previewLayout { display: grid; grid-template-columns: minmax(0, 1fr) 215px; gap: 16px; }
.videoPlaceholder { display: grid; place-items: center; min-height: 205px; border: 1px dashed #bfd8ed; border-radius: 9px; background: linear-gradient(135deg, #f1f9ff, #edf3ff); }
.portraitFrame { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 90px; height: 160px; border: 1px solid #9dc9ec; border-radius: 6px; color: #315574; background: #ffffffb8; text-align: center; span { color: #1677c9; font-size: 10px; } strong { font-size: 12px; } small { padding: 0 8px; color: #71869b; font-size: 9px; line-height: 1.4; } }
.previewFacts { padding: 7px; h4 { margin: 0 0 14px; color: #1677c9; font-size: 12px; } dl { margin: 0; } dl div { display: flex; justify-content: space-between; gap: 8px; padding: 9px 0; border-bottom: 1px solid #e1eaf3; font-size: 11px; } dt { color: #71869b; } dd { margin: 0; text-align: right; } button { margin-top: 17px; padding: 8px 10px; border: 0; border-radius: 6px; color: #fff; background: #1689ec; font-size: 11px; cursor: pointer; } }
@media (max-width: 1300px) { .topGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .characterPanel { grid-column: 1 / -1; } }
@media (max-width: 900px) { .startGrid, .topGrid, .middleGrid { grid-template-columns: 1fr; } .characterPanel { grid-column: auto; } .dashboardIntro { display: block; } .introFacts { margin-top: 14px; } }
@media (max-width: 600px) { .previewLayout { grid-template-columns: 1fr; } .previewFacts { display: none; } }
</style>
