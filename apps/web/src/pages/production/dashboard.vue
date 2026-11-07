<template>
  <div class="dashboard">
    <div class="dashboardIntro"><div><span class="kicker">PRODUCTION OVERVIEW</span><h2>{{ project?.story.title || '从你的故事开始' }}</h2><p>{{ project ? `${project.story.sourceText.slice(0, 100)}${project.story.sourceText.length > 100 ? '…' : ''}` : '导入小说、故事梗概或剧本，建立短剧生产资料。' }}</p></div><div class="introFacts"><span>故事 {{ storyCount }}</span><span>分集 {{ project?.episodes.length ?? 0 }}</span><span>镜头 {{ project?.shots.length ?? 0 }}</span><span>{{ budgetLabel }}</span></div></div>
    <div v-if="attentionTasks" class="attentionBanner"><span>{{ attentionTasks }} 个任务需要失败处理或供应商对账，已成功产物不会自动重新提交。</span><button type="button" @click="emit('openStage', 'tasks')">查看任务 →</button></div>
    <div v-if="pendingReview" class="attentionBanner reviewBanner"><span>{{ pendingReview }} 个镜头尚未完成内容确认。</span><button type="button" @click="emit('openStage', 'shots')">逐镜检查 →</button></div>
    <div class="topGrid">
      <section class="studioPanel scriptPanel"><div class="panelHeader"><div><small>01 / 剧本</small><h3>剧本与分集</h3></div><button type="button" @click="emit('openStage', 'episodes')">进入编辑 →</button></div><div class="scriptPaper"><template v-if="latestEpisode"><span>第 {{ latestEpisode.episodeNumber }} 集 · {{ latestEpisode.title }}</span><p>{{ latestEpisode.logline || '本集梗概尚未填写' }}</p><ol v-if="latestEpisode.outline.length"><li v-for="(beat, index) in latestEpisode.outline.slice(0, 4)" :key="index">{{ beat }}</li></ol><small>已保存 {{ latestEpisode.script.length }} 个剧本场次</small></template><p v-else>尚未建立分集。先导入故事，再写分集梗概和剧本。</p></div></section>
      <section class="studioPanel workflowPanel"><div class="panelHeader"><div><small>02 / 流程</small><h3>自动生产路径</h3></div><button type="button" @click="emit('openStage', 'tasks')">任务列表 →</button></div><div class="workflow"><button v-for="(step, index) in workflow" :key="step.label" type="button" class="workflowStep" :class="{ ready: step.ready }" @click="emit('openStage', step.stage)"><span class="stepIndex">{{ String(index + 1).padStart(2, '0') }}</span><span class="stepName">{{ step.label }}</span><span class="stepState">{{ step.ready ? '有资料' : '待开始' }}</span></button></div><p class="workflowNote">真实模型任务需要单独授权内容、次数和预算。</p></section>
      <section class="studioPanel characterPanel"><div class="panelHeader"><div><small>03 / 资产</small><h3>角色一览</h3></div><button type="button" @click="emit('openStage', 'assets')">查看资产 →</button></div><div v-if="characters.length" class="characterList"><article v-for="asset in characters" :key="asset.id"><div class="portrait">{{ asset.name.slice(0, 1) }}</div><strong>{{ asset.name }}</strong><small>{{ asset.stableDescription || '外观待确认' }}</small><span>{{ asset.locked ? '已锁定' : '待确认' }}</span></article></div><div v-else class="panelEmpty">尚无角色资产。提取候选和角色设定会显示在这里。</div></section>
    </div>
    <div class="middleGrid">
      <section class="studioPanel timelinePanel"><div class="panelHeader"><div><small>04 / 分镜</small><h3>分镜时间轴</h3></div><button type="button" @click="emit('openStage', 'shots')">镜头详情 →</button></div><div v-if="shots.length" class="shotStrip"><article v-for="shot in shots" :key="shot.id"><div class="shotVisual"><span>{{ shot.episodeNumber }}—{{ String(shot.sequence).padStart(2, '0') }}</span><strong>{{ shot.title || '未命名镜头' }}</strong></div><small>{{ (shot.durationMs / 1000).toFixed(1) }} 秒 · {{ shot.videoReadiness === 'ready' ? '视频就绪' : '待生成' }}</small></article></div><div v-else class="panelEmpty">分镜尚未建立。完成剧本和资产后，在镜头工作台逐镜规划。</div></section>
      <section class="studioPanel scenePanel"><div class="panelHeader"><div><small>05 / 场景</small><h3>场景管理</h3></div><button type="button" @click="emit('openStage', 'assets')">查看场景 →</button></div><div v-if="scenes.length" class="sceneGrid"><article v-for="scene in scenes" :key="scene.id"><div class="sceneVisual"><span>{{ scene.name.slice(0, 1) }}</span></div><strong>{{ scene.name }}</strong><small>{{ scene.location || scene.atmosphere || '场景描述待补充' }}</small></article></div><div v-else class="panelEmpty">尚无场景。场景资料建立后可在此快速查看。</div></section>
    </div>
    <section class="studioPanel previewPanel"><div class="panelHeader"><div><small>06 / 成片</small><h3>成片预览</h3></div><button type="button" @click="emit('openStage', 'exports')">成片管理 →</button></div><div class="previewLayout"><div class="videoPlaceholder"><div class="portraitFrame"><span>9:16</span><strong>成片待生成</strong><small>完成镜头生成和合成后在此预览</small></div></div><div class="previewFacts"><h4>交付规格</h4><dl><div><dt>画幅</dt><dd>竖屏 9:16</dd></div><div><dt>分辨率</dt><dd>1080 × 1920</dd></div><div><dt>格式</dt><dd>MP4 · H.264 + AAC</dd></div><div><dt>已保存任务</dt><dd>{{ project?.tasks.length ?? 0 }}</dd></div></dl><button type="button" @click="emit('openStage', 'costs')">查看费用与备份 →</button></div></div></section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { BudgetOverview, ProjectProduction } from "@/lib/productionApi";

type Stage = "stories" | "episodes" | "assets" | "shots" | "tasks" | "exports" | "costs";
const props = defineProps<{ project: ProjectProduction | null; storyCount: number; budget: BudgetOverview | null }>();
const emit = defineEmits<{ openStage: [stage: Stage] }>();
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
.dashboard { display: grid; gap: 16px; color: #e7edf5; }
.dashboardIntro { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding: 6px 2px 12px; h2 { margin: 8px 0; font-size: 25px; } p { max-width: 690px; margin: 0; color: #9aa9bf; line-height: 1.6; } }
.kicker, .studioPanel .panelHeader small { color: #c7aa72; font-size: 10px; font-weight: 700; letter-spacing: .14em; }
.introFacts { display: flex; gap: 8px; flex-wrap: wrap; span { padding: 7px 10px; border: 1px solid #31455e; border-radius: 7px; color: #bac9d9; font-size: 11px; white-space: nowrap; } }
.attentionBanner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border: 1px solid #836343; border-radius: 8px; background: #31291f; color: #e8cda0; font-size: 11px; button { border: 0; color: #f5d6a0; background: transparent; cursor: pointer; white-space: nowrap; } &.reviewBanner { border-color: #456584; background: #15283b; color: #bcd6f0; button { color: #c7ddf4; } } }
.topGrid, .middleGrid { display: grid; gap: 16px; }
.topGrid { grid-template-columns: 1.12fr .9fr 1fr; }
.middleGrid { grid-template-columns: 1.35fr 1fr; }
.studioPanel { min-width: 0; padding: 17px; border: 1px solid #31445e; border-radius: 13px; background: linear-gradient(150deg, #142238, #101b2b); box-shadow: 0 10px 30px #03091238; }
.panelHeader { display: flex; align-items: start; justify-content: space-between; gap: 8px; margin-bottom: 13px; h3 { margin: 5px 0 0; font-size: 16px; } button { padding: 4px 0; border: 0; color: #cbb78f; background: transparent; white-space: nowrap; cursor: pointer; font-size: 11px; &:hover { color: #f4dfb2; } } }
.scriptPaper { min-height: 202px; max-height: 230px; overflow: auto; padding: 15px; border: 1px solid #28405e; border-radius: 9px; background: #0b1524; color: #c8d5e4; font-size: 12px; line-height: 1.7; span { color: #ddb876; font-weight: 700; } p { margin: 10px 0; } ol { margin: 7px 0; padding-left: 18px; } small { color: #8193ab; } }
.workflow { display: grid; gap: 5px; }
.workflowStep { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 33px; padding: 6px 9px; border: 1px solid #283951; border-radius: 7px; color: #c6d4e4; background: #0d1829; cursor: pointer; text-align: left; &.ready { border-color: #557d78; background: #142a34; } &:hover { border-color: #c7aa72; } .stepIndex { color: #c7aa72; font-size: 10px; } .stepName { flex: 1; font-size: 11px; } .stepState { color: #8299ae; font-size: 10px; } }
.workflowNote { margin: 10px 0 0; color: #92a3b6; font-size: 10px; line-height: 1.5; }
.characterList { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; article { display: grid; gap: 5px; min-width: 0; padding: 7px; border: 1px solid #30435a; border-radius: 9px; background: #0c1829; strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; } small { overflow: hidden; color: #8fa0b5; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; } span { color: #c7aa72; font-size: 10px; } } .portrait { display: grid; place-items: center; height: 115px; margin-bottom: 4px; border-radius: 6px; background: radial-gradient(circle at 52% 35%, #496583, #142237 68%); color: #d8e2f0; font-size: 35px; } }
.panelEmpty { display: grid; place-items: center; min-height: 130px; padding: 20px; border: 1px dashed #3b4e66; border-radius: 8px; color: #8b9bb0; text-align: center; font-size: 12px; line-height: 1.6; }
.shotStrip { display: flex; gap: 9px; overflow-x: auto; padding-bottom: 5px; article { flex: 0 0 112px; min-width: 0; small { color: #91a2b8; font-size: 10px; } } .shotVisual { display: flex; flex-direction: column; justify-content: space-between; height: 105px; margin-bottom: 6px; padding: 9px; border: 1px solid #3a516b; border-radius: 7px; background: linear-gradient(160deg, #233a59, #0c1627); span { color: #d4b77f; font-size: 10px; } strong { font-size: 11px; } } }
.sceneGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; article { min-width: 0; padding: 6px; border: 1px solid #30435a; border-radius: 8px; background: #0d1829; strong, small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } strong { margin-top: 5px; font-size: 11px; } small { color: #8d9eb2; font-size: 10px; } } .sceneVisual { display: grid; place-items: center; height: 60px; border-radius: 5px; background: linear-gradient(125deg, #2e5675, #142437 70%); color: #d6e3ef; font-size: 22px; } }
.previewLayout { display: grid; grid-template-columns: minmax(0, 1fr) 215px; gap: 16px; }
.videoPlaceholder { display: grid; place-items: center; min-height: 205px; border: 1px solid #38506c; border-radius: 9px; background: radial-gradient(circle at 50% 30%, #203c5e, #0a1423 72%); }
.portraitFrame { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 90px; height: 160px; border: 1px solid #6484a7; border-radius: 6px; color: #d6e5f5; text-align: center; span { color: #d3b67b; font-size: 10px; } strong { font-size: 12px; } small { padding: 0 8px; color: #91a3b8; font-size: 9px; line-height: 1.4; } }
.previewFacts { padding: 7px; h4 { margin: 0 0 14px; color: #cdb783; font-size: 12px; } dl { margin: 0; } dl div { display: flex; justify-content: space-between; gap: 8px; padding: 9px 0; border-bottom: 1px solid #2c4058; font-size: 11px; } dt { color: #94a7bb; } dd { margin: 0; text-align: right; } button { margin-top: 17px; padding: 0; border: 0; color: #cbb78f; background: transparent; font-size: 11px; cursor: pointer; } }
@media (max-width: 1300px) { .topGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .characterPanel { grid-column: 1 / -1; } }
@media (max-width: 900px) { .topGrid, .middleGrid { grid-template-columns: 1fr; } .characterPanel { grid-column: auto; } .dashboardIntro { display: block; } .introFacts { margin-top: 12px; } }
@media (max-width: 600px) { .previewLayout { grid-template-columns: 1fr; } .previewFacts { display: none; } }
</style>
