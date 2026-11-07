<template>
  <main class="productionPage">
    <aside class="sideRail">
      <div class="brandBlock"><span class="brandMark">映</span><div><strong>Toonflow Studio</strong><small>短剧生产工作台</small></div></div>
      <div class="projectBlock"><span>当前工作区</span><strong :title="directory">{{ workspaceStore.project?.name }}</strong></div>
      <nav class="stageNav" aria-label="生产流程">
        <button v-for="item in navigation.filter(entry => entry.key === 'overview' || entry.key === 'exports')" :key="item.key" type="button" :class="{ active: activeStage === item.key }" @click="activeStage = item.key">
          <component :is="item.icon" :size="17" aria-hidden="true" /><span>{{ item.label }}</span><span v-if="item.count !== undefined" class="stageCount">{{ item.count }}</span>
        </button>
        <details class="advancedNav" :open="activeStage !== 'overview' && activeStage !== 'exports'">
          <summary>制作资料与设置</summary>
          <button v-for="item in navigation.filter(entry => entry.key !== 'overview' && entry.key !== 'exports')" :key="item.key" type="button" :class="{ active: activeStage === item.key }" @click="activeStage = item.key">
            <component :is="item.icon" :size="17" aria-hidden="true" /><span>{{ item.label }}</span><span v-if="item.count !== undefined" class="stageCount">{{ item.count }}</span>
          </button>
        </details>
      </nav>
      <div class="railFooter">
        <el-button text @click="router.push('/workspace')">打开画布精修</el-button>
        <el-button text @click="router.push('/home')">返回项目列表</el-button>
      </div>
    </aside>
    <section class="mainArea">
      <header class="topBar">
        <div><span class="eyebrow">AI SHORT DRAMA PRODUCTION</span><h1>{{ stageTitle }}</h1></div>
        <div class="topActions"><span class="safeState">真实模型调用未授权</span><el-button class="mobileLink" text @click="router.push('/workspace')">画布</el-button><el-button class="mobileLink" text @click="router.push('/home')">项目</el-button><el-button :loading="loading" @click="refresh">刷新资料</el-button></div>
      </header>
      <div class="pageBody" v-loading="loading">
        <dashboard v-if="activeStage === 'overview'" v-model:storyTitle="storyTitle" v-model:storyText="storyText" :project="project" :storyCount="stories.length" :budget="budget" :savingStory="savingStory" @openStage="activeStage = $event" @importNovel="importNovel" @fileChange="readStoryFile" />

        <template v-else-if="activeStage === 'stories'">
          <div class="sectionHeading"><div><h2>故事资料</h2><p>原文保留在当前工作区，后续分析以它为依据。</p></div><el-button @click="loadStories">刷新故事</el-button></div>
          <div class="twoColumns">
            <section class="surfaceCard"><h3>故事列表</h3><div v-if="!stories.length" class="storyEmpty"><span class="storyEmptyIcon"><icon-book-2 :size="30" aria-hidden="true" /></span><strong>尚未导入故事</strong><small>导入章节后可查看原文与分章索引</small></div><button v-for="story in stories" :key="story.id" type="button" class="storyRow" :class="{ selected: selectedStoryId === story.id }" @click="selectedStoryId = story.id"><strong>{{ story.title }}</strong><span>{{ sourceLabel(story.sourceKind) }} · {{ new Date(story.createdAt).toLocaleDateString() }}</span></button></section>
            <section class="surfaceCard">
              <template v-if="project"><div class="cardHeading"><h3>{{ project.story.title }}</h3><el-tag size="small">{{ project.story.workflowState }}</el-tag></div><p class="subtleText">故事原文</p><el-input :modelValue="project.story.sourceText" type="textarea" :rows="16" readonly aria-label="故事原文" /></template>
              <template v-else><h3>导入新故事</h3><p class="subtleText">优先导入小说章节，也支持故事梗概或现成剧本；TXT 与 Markdown 可直接读取。</p><el-form labelPosition="top" @submit.prevent="importStory"><el-form-item label="标题"><el-input v-model="storyTitle" maxlength="200" /></el-form-item><el-form-item label="来源"><el-select v-model="sourceKind" popperClass="studioSelectPopup"><el-option label="小说章节" value="novel" /><el-option label="故事梗概" value="synopsis" /><el-option label="剧本" value="script" /></el-select></el-form-item><el-form-item label="原文"><el-input v-model="storyText" type="textarea" :rows="11" maxlength="1000000" /></el-form-item><div class="formActions"><input ref="storyFileInput" class="hiddenInput" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" @change="readStoryFile" /><el-button @click="storyFileInput?.click()">读取 TXT / Markdown</el-button><el-button type="primary" :loading="savingStory" :disabled="!storyTitle.trim() || !storyText.trim()" @click="importStory">保存原文</el-button></div></el-form></template>
              <el-button v-if="project" text @click="selectedStoryId = ''">导入另一个故事</el-button>
            </section>
          </div>
          <section v-if="project?.chapterIndex" class="surfaceCard"><div class="cardHeading"><h3>小说章节索引</h3><small>原文 SHA-256：{{ project.chapterIndex.sourceHash.slice(0, 12) }}…</small></div><p class="subtleText">{{ project.chapterIndex.chapters.length }} 章 · {{ project.chapterIndex.lineCount }} 行。每章保留原文行号，后续事件和剧本须据此引用。</p><p v-for="(issue, index) in project.chapterIndex.issues" :key="index" class="sourceIssue">{{ issue }}</p><el-table :data="project.chapterIndex.chapters" maxHeight="340" emptyText="请确认小说分章边界"><el-table-column prop="sequence" label="序号" width="72" /><el-table-column prop="title" label="章节" minWidth="220" /><el-table-column label="原文行号" width="150"><template #default="{ row }">{{ row.lineStart }}–{{ row.lineEnd }}</template></el-table-column><el-table-column prop="characterCount" label="正文字数" width="110" /></el-table></section>
          <section v-if="project?.analysis" class="surfaceCard"><div class="cardHeading"><h3>故事分析 · 第 {{ project.analysis.version }} 版</h3><small>{{ new Date(project.analysis.updatedAt).toLocaleString() }}</small></div><div class="twoColumns"><div><h4>事件</h4><pre v-for="(event, index) in project.analysis.events" :key="index" class="structuredItem">{{ JSON.stringify(event, null, 2) }}</pre><p v-if="!project.analysis.events.length" class="subtleText">暂无事件</p></div><div><h4>人物关系</h4><pre v-for="(relation, index) in project.analysis.relations" :key="index" class="structuredItem">{{ JSON.stringify(relation, null, 2) }}</pre><p v-if="!project.analysis.relations.length" class="subtleText">暂无关系</p></div></div></section>
        </template>

        <template v-else-if="activeStage === 'episodes'">
          <div class="sectionHeading"><div><h2>分集剧本</h2><p>每集的梗概、提纲和剧本与故事资料关联。</p></div></div>
          <section v-if="project?.chapterIndex" class="surfaceCard"><adaptationSetup :directory="directory" :projectId="selectedStoryId" :chapterCount="project.chapterIndex.chapters.length" :nextEpisode="Math.max(0, ...project.episodes.map(item => item.episodeNumber)) + 1" :inputs="project.adaptationInputs" @changed="refreshProject" /></section>
          <section class="surfaceCard"><episodeCenter :key="project?.episodes.length" :directory="directory" :stories="stories" :selectedProjectId="selectedStoryId" @changed="refreshProject" /></section>
          <section v-if="project" class="surfaceCard"><draftImport :directory="directory" :projectId="selectedStoryId" @changed="refreshProject" /></section>
          <section v-if="project?.episodes.length" class="surfaceCard"><h3>已保存的提纲与剧本</h3><div v-for="episode in project.episodes" :key="episode.id" class="episodeDetail"><div class="cardHeading"><strong>第 {{ episode.episodeNumber }} 集 · {{ episode.title }}</strong><el-tag size="small" :type="episode.scriptReport.passed ? 'success' : 'warning'">{{ episode.scriptReport.passed ? '基础校验通过' : `${episode.scriptReport.checks.length} 项待修正` }}</el-tag></div><p>{{ episode.logline || '尚无本集梗概' }}</p><ol v-if="episode.outline.length"><li v-for="(beat, index) in episode.outline" :key="index">{{ beat }}</li></ol><p v-else class="subtleText">尚无结构化提纲</p><small>剧本场次：{{ episode.script.length }} · 预估时长 {{ episode.scriptReport.estimatedSeconds }} 秒</small><ul v-if="episode.scriptReport.checks.length" class="scriptIssues"><li v-for="(check, index) in episode.scriptReport.checks" :key="index">{{ check.scene ? `第 ${check.scene} 场：` : '' }}{{ check.message }}</li></ul></div></section>
        </template>

        <template v-else-if="activeStage === 'assets'">
          <div class="sectionHeading"><div><h2>人物与场景资产</h2><p>人物、服装、道具和场景独立保存，锁定的资产不能被提取候选覆盖。</p></div><el-button :disabled="!selectedStoryId" @click="refreshProject">刷新资产</el-button></div>
          <div v-if="!project" class="emptyStage">先在左侧故事列表中选择一个故事。</div>
          <template v-else><div class="metricGrid"><article class="metricCard"><span>人物</span><strong>{{ countAssets('character') }}</strong></article><article class="metricCard"><span>场景</span><strong>{{ project.scenes.length }}</strong></article><article class="metricCard"><span>道具与服装</span><strong>{{ countAssets('prop') + countAssets('costume') }}</strong></article></div><div class="assetGrid"><article v-for="asset in project.assets" :key="asset.id" class="surfaceCard assetCard"><div class="cardHeading"><strong>{{ asset.name }}</strong><el-tag size="small" :type="asset.locked ? 'warning' : 'info'">{{ asset.locked ? '已锁定' : assetKindLabel(asset.kind) }}</el-tag></div><p>{{ asset.stableDescription || '尚无稳定外观描述' }}</p><small>首次出现：{{ asset.firstAppearance || '待记录' }}</small></article><article v-for="scene in project.scenes" :key="scene.id" class="surfaceCard assetCard"><div class="cardHeading"><strong>{{ scene.name }}</strong><el-tag size="small">场景</el-tag></div><p>{{ scene.location || '地点待补充' }} · {{ scene.atmosphere || '氛围待补充' }}</p><small>{{ scene.timeWeather || '时间与天气待补充' }}</small></article></div><div v-if="!project.assets.length && !project.scenes.length" class="emptyStage">当前故事尚未建立人物或场景资产。</div></template>
        </template>

        <template v-else-if="activeStage === 'shots'">
          <div class="sectionHeading"><div><h2>镜头与片段</h2><p>内容确认、运行任务和视频准备度分别显示，避免把“已写好”误认成“已生成”。</p></div><el-button :disabled="!selectedStoryId" @click="refreshProject">刷新镜头</el-button></div>
          <section class="surfaceCard"><el-table :data="project?.shots ?? []" maxHeight="calc(100vh - 245px)" emptyText="当前故事尚无分镜"><el-table-column label="镜头" width="100"><template #default="{ row }">{{ row.episodeNumber }}-{{ row.sequence }}</template></el-table-column><el-table-column prop="title" label="标题" minWidth="130" /><el-table-column prop="scriptExcerpt" label="剧本依据" minWidth="200" showOverflowTooltip /><el-table-column label="道具状态" minWidth="220" showOverflowTooltip><template #default="{ row }">{{ propSummary(row.id) }}</template></el-table-column><el-table-column label="时长" width="90"><template #default="{ row }">{{ (row.durationMs / 1000).toFixed(1) }} 秒</template></el-table-column><el-table-column prop="reviewState" label="内容确认" width="110" /><el-table-column prop="runtimeState" label="运行状态" width="110" /><el-table-column prop="videoReadiness" label="视频准备" width="110" /><el-table-column prop="promptText" label="提示词" minWidth="220" showOverflowTooltip /></el-table></section>
        </template>

        <template v-else-if="activeStage === 'tasks'">
          <section v-if="project?.tasks.some(task => task.stage === 'text' && task.state === 'succeeded')" class="surfaceCard"><h3>已保存的编剧结果</h3><p class="subtleText">采用前检查原文版本、章节范围、集号、时长和证据；采用后仍需内容审核。</p><div v-for="task in project.tasks.filter(item => item.stage === 'text' && item.state === 'succeeded')" :key="task.id" class="cardHeading"><span>{{ task.modelId }} · {{ new Date(task.updatedAt).toLocaleString() }}</span><el-tag v-if="project.adaptationAdoptions.some(item => item.taskId === task.id)" type="success">已采用</el-tag><el-button v-else type="primary" :loading="adoptingTaskId === task.id" :disabled="!!adoptingTaskId && adoptingTaskId !== task.id" @click="adoptTextResult(task.id)">校验并采用</el-button></div></section>
          <div class="sectionHeading"><div><h2>生成任务</h2><p>在途请求必须先对账；成功产物保留，不能因重启或失败重新提交同一付费任务。</p></div><el-button :disabled="!selectedStoryId" @click="refreshProject">刷新任务</el-button></div>
          <section class="surfaceCard"><el-table :data="project?.tasks ?? []" maxHeight="calc(100vh - 245px)" emptyText="当前故事尚无生成任务"><el-table-column prop="stage" label="环节" width="100" /><el-table-column prop="provider" label="供应商" minWidth="120" /><el-table-column prop="modelId" label="模型" minWidth="150" /><el-table-column prop="state" label="状态" width="145" /><el-table-column label="已结算" width="145"><template #default="{ row }">{{ formatMoney(row.chargedMicros, row.currency) }}</template></el-table-column><el-table-column label="在途预留" width="145"><template #default="{ row }">{{ formatMoney(row.reservedMicros, row.currency) }}</template></el-table-column><el-table-column prop="outputCount" label="产物" width="70" /><el-table-column label="更新时间" minWidth="165"><template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template></el-table-column></el-table></section>
        </template>

        <template v-else-if="activeStage === 'exports'">
          <div class="sectionHeading"><div><h2>成片管理</h2><p>合成与重新导出使用已有镜头产物，字幕或配乐修改不应重新付费生成视频。</p></div></div>
          <section class="surfaceCard"><el-table :data="synthesisTasks" emptyText="尚无成片合成任务"><el-table-column prop="episodeId" label="分集 ID" minWidth="220" /><el-table-column prop="state" label="状态" width="150" /><el-table-column prop="outputCount" label="产物数量" width="110" /><el-table-column label="更新时间" minWidth="180"><template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template></el-table-column></el-table></section>
        </template>

        <template v-else-if="activeStage === 'costs'">
          <div class="sectionHeading"><div><h2>费用与备份</h2><p>预算是上限约束；保存预算不会授权真实模型调用。</p></div><el-button :loading="loadingBudget" @click="loadBudget">刷新预算</el-button></div>
          <div class="metricGrid"><article class="metricCard"><span>全局预算上限</span><strong>{{ budget?.global.configured ? formatMoney(budget.global.limitMicros, budget.global.currency) : '未设置' }}</strong><small>未设置时付费任务被拦截</small></article><article class="metricCard"><span>已结算</span><strong>{{ formatMoney(budget?.global.chargedMicros ?? 0, budget?.global.currency ?? 'CNY') }}</strong></article><article class="metricCard"><span>在途预留</span><strong>{{ formatMoney(budget?.global.reservedMicros ?? 0, budget?.global.currency ?? 'CNY') }}</strong></article></div>
          <div class="twoColumns"><section class="surfaceCard"><h3>设置预算上限</h3><el-form labelPosition="top" @submit.prevent="saveBudget"><el-form-item label="范围"><el-select v-model="budgetScope" popperClass="studioSelectPopup"><el-option label="全部项目" value="global" /><el-option label="当前故事" value="project" /></el-select></el-form-item><el-form-item v-if="budgetScope === 'project'" label="故事"><el-select v-model="budgetProjectId" placeholder="选择故事" popperClass="studioSelectPopup"><el-option v-for="story in stories" :key="story.id" :label="story.title" :value="story.id" /></el-select></el-form-item><el-form-item label="金额"><el-input v-model="budgetAmount" placeholder="如 100.00；0 表示停止新增付费任务" /></el-form-item><el-form-item label="币种"><el-select v-model="budgetCurrency" popperClass="studioSelectPopup"><el-option label="人民币 CNY" value="CNY" /><el-option label="美元 USD" value="USD" /></el-select></el-form-item><el-form-item label="预警阈值"><el-input-number v-model="warningPercent" :min="1" :max="100" /> %</el-form-item><el-button type="primary" :loading="savingBudget" @click="saveBudget">保存预算上限</el-button></el-form><p v-if="budgetScope === 'project' && budget?.project" class="subtleText">当前故事上限：{{ budget.project.configured ? formatMoney(budget.project.limitMicros, budget.project.currency) : '未设置' }}</p></section><section class="surfaceCard"><h3>项目生产备份</h3><p>备份包含工作区原文、素材、项目数据库一致快照及当前项目对应的全局任务账本。</p><el-button :loading="exportingBackup" @click="exportBackup">下载生产备份 ZIP</el-button><p class="subtleText">恢复入口仍在开发；请勿把此导出误当作已验证的完整恢复方案。</p></section></div>
          <section class="surfaceCard"><div class="cardHeading"><h3>模型价格规则</h3><el-button :loading="loadingPrices" @click="loadPriceRules">刷新价格</el-button></div><p class="subtleText">记录供应商的计费依据用于预算估算；录入价格不会启动模型。</p><el-form labelPosition="top" @submit.prevent="recordPriceRule"><div class="priceFields"><el-form-item label="供应商 ID"><el-input v-model="priceProvider" /></el-form-item><el-form-item label="模型 ID"><el-input v-model="priceModel" /></el-form-item><el-form-item label="计费单位"><el-input v-model="priceUnit" placeholder="token / second / image" /></el-form-item><el-form-item label="单位数量"><el-input-number v-model="priceUnitSize" :min="1" :max="1000000000" /></el-form-item><el-form-item label="单位价格"><el-input v-model="priceAmount" placeholder="如 2.50" /></el-form-item><el-form-item label="币种"><el-input v-model="priceCurrency" maxlength="3" /></el-form-item></div><el-form-item label="价格来源 HTTPS 链接"><el-input v-model="priceSourceUrl" placeholder="https://" /></el-form-item><el-button type="primary" :loading="savingPrice" @click="recordPriceRule">记录价格</el-button></el-form><el-table :data="priceRules" class="priceTable" emptyText="尚未录入价格规则"><el-table-column prop="provider" label="供应商" minWidth="120" /><el-table-column prop="modelId" label="模型" minWidth="160" /><el-table-column label="价格" minWidth="180"><template #default="{ row }">{{ formatPrice(row as PriceRule) }}</template></el-table-column><el-table-column label="生效时间" minWidth="160"><template #default="{ row }">{{ new Date(row.effectiveAt).toLocaleString() }}</template></el-table-column><el-table-column label="来源" width="90"><template #default="{ row }"><a :href="row.sourceUrl" target="_blank" rel="noopener noreferrer">查看</a></template></el-table-column></el-table></section>
        </template>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { IconBook2, IconBox, IconChartBar, IconChecklist, IconClipboardText, IconHome, IconMovie, IconPhotoVideo } from "@tabler/icons-vue";
import saveFile from "@/lib/saveFile";
import productionApi, { type BudgetOverview, type PriceRule, type ProjectProduction, type SourceKind, type Story } from "@/lib/productionApi";
import { useWorkspaceStore } from "@/stores/workspace";
import episodeCenter from "@/pages/workspace/components/episodeCenter.vue";
import dashboard from "./dashboard.vue";
import draftImport from "./draftImport.vue";
import adaptationSetup from "./adaptationSetup.vue";

type Stage = "overview" | "stories" | "episodes" | "assets" | "shots" | "tasks" | "exports" | "costs";
const router = useRouter();
const route = useRoute();
const workspaceStore = useWorkspaceStore();
const directory = computed(() => workspaceStore.project?.directory ?? "");
const activeStage = ref<Stage>("overview");
const stories = ref<Story[]>([]);
const selectedStoryId = ref("");
const project = ref<ProjectProduction | null>(null);
const loading = ref(false);
const loadingBudget = ref(false);
const savingStory = ref(false);
const savingBudget = ref(false);
const exportingBackup = ref(false);
const adoptingTaskId = ref("");
const storyTitle = ref("");
const storyText = ref("");
const sourceKind = ref<SourceKind>("novel");
const storyFileInput = ref<HTMLInputElement>();
const budget = ref<BudgetOverview | null>(null);
const budgetScope = ref<"global" | "project">("global");
const budgetProjectId = ref("");
const budgetAmount = ref("");
const budgetCurrency = ref("CNY");
const warningPercent = ref(90);
const priceRules = ref<PriceRule[]>([]);
const loadingPrices = ref(false);
const savingPrice = ref(false);
const priceProvider = ref("");
const priceModel = ref("");
const priceUnit = ref("");
const priceUnitSize = ref(1);
const priceAmount = ref("");
const priceCurrency = ref("CNY");
const priceSourceUrl = ref("");
const stageLabels: Record<Stage, string> = { overview: "制作首页", stories: "故事资料", episodes: "分集剧本", assets: "人物场景道具", shots: "镜头与片段", tasks: "生成任务", exports: "成片管理", costs: "费用与备份" };
const stageTitle = computed(() => stageLabels[activeStage.value]);
const navigation = computed(() => ([
  { key: "overview", label: "制作首页", icon: IconHome },
  { key: "stories", label: "故事资料", icon: IconBook2, count: stories.value.length },
  { key: "episodes", label: "分集剧本", icon: IconClipboardText, count: project.value?.episodes.length },
  { key: "assets", label: "人物场景道具", icon: IconBox, count: (project.value?.assets.length ?? 0) + (project.value?.scenes.length ?? 0) },
  { key: "shots", label: "镜头与片段", icon: IconPhotoVideo, count: project.value?.shots.length },
  { key: "tasks", label: "生成任务", icon: IconChecklist, count: project.value?.tasks.length },
  { key: "exports", label: "成片管理", icon: IconMovie, count: synthesisTasks.value.length },
  { key: "costs", label: "费用与备份", icon: IconChartBar },
] as Array<{ key: Stage; label: string; icon: typeof IconHome; count?: number }>));
const synthesisTasks = computed(() => project.value?.tasks.filter(task => task.stage === "synthesis") ?? []);

watch(directory, () => { stories.value = []; selectedStoryId.value = ""; project.value = null; void loadStories(); }, { immediate: true });
watch(selectedStoryId, () => { project.value = null; void refreshProject(); void loadBudget(); });
watch(activeStage, stage => { if (stage === "costs") { void loadBudget(); void loadPriceRules(); } });
watch([budgetScope, budgetProjectId], () => { if (activeStage.value === "costs") void loadBudget(); });
watch(selectedStoryId, value => { if (value && !budgetProjectId.value) budgetProjectId.value = value; });

function errorMessage(cause: unknown) {
  return axios.isAxiosError<{ message?: string }>(cause)
    ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "操作失败";
}
function sourceLabel(kind: SourceKind) { return { synopsis: "故事梗概", novel: "小说", script: "剧本" }[kind]; }
function assetKindLabel(kind: ProjectProduction["assets"][number]["kind"]) { return { character: "人物", prop: "道具", costume: "服装" }[kind]; }
function countAssets(kind: ProjectProduction["assets"][number]["kind"]) { return project.value?.assets.filter(asset => asset.kind === kind).length ?? 0; }
function propSummary(shotId: string) {
  return project.value?.shotProps.filter(link => link.shotId === shotId)
    .map(link => `${link.propName}：${link.stateBefore} → ${link.stateAfter}${link.holderAfterName ? `（${link.holderAfterName}持有）` : ""}`)
    .join("；") || "—";
}
function formatMoney(micros: number, currency: string | null) { return `${(micros / 1_000_000).toFixed(2)} ${currency ?? "CNY"}`; }

async function loadStories() {
  const path = directory.value;
  if (!path) return;
  loading.value = true;
  try {
    const result = await productionApi.listStories(path);
    if (directory.value !== path) return;
    stories.value = result;
    if (!result.some(story => story.id === selectedStoryId.value)) {
      const requestedId = typeof route.query.storyId === "string" ? route.query.storyId : "";
      selectedStoryId.value = result.find(story => story.id === requestedId)?.id ?? result[0]?.id ?? "";
    }
  } catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { loading.value = false; }
}
async function refreshProject() {
  const path = directory.value;
  const projectId = selectedStoryId.value;
  if (!path || !projectId) { project.value = null; return; }
  loading.value = true;
  try {
    const result = await productionApi.getProjectProduction(path, projectId);
    if (directory.value === path && selectedStoryId.value === projectId) project.value = result;
  } catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { loading.value = false; }
}
async function refresh() { await loadStories(); await refreshProject(); if (activeStage.value === "costs") await loadBudget(); }
async function adoptTextResult(taskId: string) {
  if (adoptingTaskId.value) return;
  const path = directory.value; const projectId = selectedStoryId.value;
  adoptingTaskId.value = taskId;
  try {
    await productionApi.adoptTextResult(path, projectId, taskId);
    if (directory.value !== path || selectedStoryId.value !== projectId) return;
    await refreshProject(); ElMessage.success("编剧结果已保存为待审核分集");
  } catch (cause) { if (directory.value === path && selectedStoryId.value === projectId) ElMessage.error(errorMessage(cause)); }
  finally { adoptingTaskId.value = ""; }
}
async function readStoryFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    if (file.size > 4_000_000) throw new Error("文件不能超过 4 MB");
    const bytes = await file.arrayBuffer();
    try { storyText.value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { storyText.value = new TextDecoder("gbk", { fatal: true }).decode(bytes); }
    storyText.value = storyText.value.replace(/^\uFEFF/, "");
    if (storyText.value.length > 1_000_000) throw new Error("原文不能超过 100 万字");
    if (!storyTitle.value.trim()) storyTitle.value = file.name.replace(/\.(txt|md|markdown)$/i, "");
  } catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { (event.target as HTMLInputElement).value = ""; }
}
async function importStory() {
  if (!directory.value || !storyTitle.value.trim() || !storyText.value.trim()) return;
  savingStory.value = true;
  try {
    const projectId = await productionApi.importStory(directory.value, storyTitle.value.trim(), sourceKind.value, storyText.value);
    storyTitle.value = ""; storyText.value = "";
    await loadStories(); selectedStoryId.value = projectId; await refreshProject();
    ElMessage.success("故事已导入");
  } catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { savingStory.value = false; }
}
async function importNovel() { sourceKind.value = "novel"; await importStory(); }
async function loadBudget() {
  const path = directory.value;
  if (!path) return;
  const projectId = budgetScope.value === "project" ? budgetProjectId.value : selectedStoryId.value;
  if (budgetScope.value === "project" && !projectId) return;
  loadingBudget.value = true;
  try { const result = await productionApi.getBudget(path, projectId || undefined); if (directory.value === path) budget.value = result; }
  catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { loadingBudget.value = false; }
}
async function saveBudget() {
  if (!directory.value || savingBudget.value) return;
  if (budgetScope.value === "project" && !budgetProjectId.value) { ElMessage.warning("请先选择故事"); return; }
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(budgetAmount.value.trim());
  if (!match) { ElMessage.warning("请输入最多六位小数的非负金额"); return; }
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) { ElMessage.warning("金额过大"); return; }
  savingBudget.value = true;
  try { await productionApi.setBudget(directory.value, { scopeType: budgetScope.value,
    projectId: budgetScope.value === "project" ? budgetProjectId.value : undefined, limitMicros: micros,
    currency: budgetCurrency.value, warningBasisPoints: warningPercent.value * 100 }); await loadBudget(); ElMessage.success("预算上限已保存"); }
  catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { savingBudget.value = false; }
}
function formatPrice(rule: PriceRule) { return `${(rule.unitPriceMicros / 1_000_000).toFixed(6)} ${rule.currency} / ${rule.unitSize} ${rule.unit}`; }
async function loadPriceRules() {
  const path = directory.value;
  if (!path) return;
  loadingPrices.value = true;
  try { const rules = await productionApi.listPriceRules(path); if (directory.value === path) priceRules.value = rules; }
  catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { loadingPrices.value = false; }
}
async function recordPriceRule() {
  if (!directory.value || savingPrice.value) return;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(priceAmount.value.trim());
  if (!match) { ElMessage.warning("价格需为最多六位小数的非负金额"); return; }
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) { ElMessage.warning("价格过大"); return; }
  savingPrice.value = true;
  try { await productionApi.recordPriceRule(directory.value, { provider: priceProvider.value.trim(), modelId: priceModel.value.trim(),
    unit: priceUnit.value.trim(), unitSize: priceUnitSize.value, unitPriceMicros: micros,
    currency: priceCurrency.value.trim().toUpperCase(), sourceUrl: priceSourceUrl.value.trim(), effectiveAt: Date.now() });
    await loadPriceRules(); ElMessage.success("价格规则已记录"); }
  catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { savingPrice.value = false; }
}
async function exportBackup() {
  if (!directory.value || exportingBackup.value) return;
  exportingBackup.value = true;
  try { await saveFile(() => productionApi.exportBackup(directory.value), "toonflowProductionBackup.zip"); }
  catch (cause) { ElMessage.error(errorMessage(cause)); }
  finally { exportingBackup.value = false; }
}
</script>

<style scoped lang="scss">
.productionPage { --el-bg-color-page: #f4f7fb; --el-bg-color: #fff; --el-bg-color-overlay: #fff; --el-fill-color-blank: #fff; --el-input-bg-color: #fff; --el-border-color: #d9e4ef; --el-border-color-light: #e3ebf4; --el-text-color-primary: #1d2d42; --el-text-color-secondary: #697b8f; --el-text-color-regular: #3c5067; --el-color-primary: #1689ec; --el-color-primary-light-9: #eaf5ff; --el-color-primary-light-7: #b9ddfb; --el-fill-color-light: #f2f7fc; display: grid; grid-template-columns: 222px minmax(0, 1fr); width: 100%; height: 100dvh; color: var(--el-text-color-primary); background: var(--el-bg-color-page); }
.sideRail { display: flex; flex-direction: column; min-width: 0; padding: 26px 16px 18px; border-right: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay);
  .brandBlock { display: flex; align-items: center; gap: 10px; padding: 0 10px 26px; strong, small { display: block; } strong { font-size: 15px; } small { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 11px; letter-spacing: .08em; } }
  .brandMark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #29b4ef, #627bfa); color: white; font-weight: 700; box-shadow: 0 5px 13px #1788ed38; }
  .projectBlock { display: grid; gap: 5px; padding: 12px 14px; border: 1px solid var(--el-border-color-light); border-radius: 10px; span { color: var(--el-text-color-secondary); font-size: 11px; } strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; } }
  .stageNav { display: grid; gap: 3px; margin-top: 24px; button { display: flex; align-items: center; gap: 11px; width: 100%; min-height: 43px; padding: 0 12px; border: 0; border-radius: 9px; color: var(--el-text-color-regular); background: transparent; text-align: left; cursor: pointer; &.active { color: #0873c9; background: #e5f3ff; font-weight: 700; } &:hover { background: var(--el-fill-color-light); } } .stageCount { margin-left: auto; color: var(--el-text-color-secondary); font-size: 11px; } }
  .advancedNav { margin-top: 11px; padding-top: 12px; border-top: 1px solid #e3ebf4; summary { padding: 10px 12px; color: #697b8f; font-size: 12px; cursor: pointer; } button { min-height: 39px; margin-top: 3px; padding-left: 18px; font-size: 12px; } }
  .railFooter { display: grid; gap: 4px; margin-top: auto; padding-top: 16px; border-top: 1px solid var(--el-border-color-light); .el-button { justify-content: flex-start; margin: 0; } }
}
.mainArea { min-width: 0; overflow: hidden; }
.topBar { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 92px; padding: 18px 28px; border-bottom: 1px solid var(--el-border-color-light); background: var(--el-bg-color-overlay); h1 { margin: 5px 0 0; font-size: 22px; } .topActions { display: flex; align-items: center; gap: 14px; } .safeState { padding: 7px 10px; border-radius: 7px; color: #9a650e; background: #fff6e3; font-size: 12px; } .mobileLink { display: none; } }
.eyebrow { color: var(--el-color-primary); font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.pageBody { height: calc(100dvh - 92px); overflow: auto; padding: 22px 28px 48px; }
.heroCard { display: flex; align-items: end; justify-content: space-between; gap: 20px; min-height: 205px; padding: 28px 32px; border-radius: 16px; background: linear-gradient(120deg, var(--el-color-primary-light-9), var(--el-bg-color-overlay) 70%); border: 1px solid var(--el-color-primary-light-7); h2 { margin: 9px 0 10px; font-size: 26px; } p { max-width: 650px; color: var(--el-text-color-secondary); line-height: 1.7; } }
.metricGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 20px 0 30px; }
.metricCard { display: grid; gap: 8px; min-height: 108px; padding: 18px 20px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color-overlay); box-shadow: 0 5px 18px #334b680b; span, small { color: var(--el-text-color-secondary); font-size: 12px; } strong { color: #166cb6; font-size: 24px; font-weight: 650; overflow-wrap: anywhere; } }
.sectionHeading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin: 0 0 18px; h2 { margin: 0 0 5px; font-size: 19px; } p, span { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; } }
.flowGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.flowCard { display: grid; gap: 10px; min-height: 128px; padding: 20px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color-overlay); color: inherit; text-align: left; cursor: pointer; &:hover { border-color: var(--el-color-primary); } span { color: var(--el-color-primary); font-size: 11px; } strong { font-size: 15px; } small { color: var(--el-text-color-secondary); font-size: 12px; } }
.twoColumns { display: grid; grid-template-columns: minmax(250px, 1fr) minmax(360px, 2fr); gap: 16px; }
.surfaceCard { min-width: 0; margin-bottom: 16px; padding: 22px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color-overlay); box-shadow: 0 5px 18px #334b680b; h3 { margin: 0 0 16px; font-size: 16px; } p { line-height: 1.6; } }
.storyRow { display: grid; gap: 4px; width: 100%; margin: 6px 0; padding: 12px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; &.selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); } span { color: var(--el-text-color-secondary); font-size: 11px; } }
.cardHeading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.subtleText { color: var(--el-text-color-secondary); font-size: 12px; }
.sourceIssue, .scriptIssues { color: #a56313; font-size: 12px; }
.scriptIssues { padding-left: 20px; line-height: 1.7; }
.formActions { display: flex; justify-content: flex-end; gap: 8px; }
.hiddenInput { display: none; }
.episodeDetail { padding: 14px 0; border-top: 1px solid var(--el-border-color-light); &:first-of-type { border-top: 0; } ol { padding-left: 20px; } small { color: var(--el-text-color-secondary); } }
.assetGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; .assetCard { margin: 0; min-height: 140px; small { color: var(--el-text-color-secondary); } } }
.emptyStage { padding: 70px 20px; border: 1px dashed var(--el-border-color); border-radius: 12px; color: var(--el-text-color-secondary); text-align: center; }
.storyEmpty { display: grid; justify-items: center; align-content: center; gap: 9px; min-height: 285px; color: #1d2d42; text-align: center; strong { font-size: 13px; } small { color: #697b8f; font-size: 11px; } }
.storyEmptyIcon { display: grid; place-items: center; width: 66px; height: 66px; margin-bottom: 8px; border: 1px solid #c9e4f9; border-radius: 18px; color: #1689ec; background: linear-gradient(135deg, #eaf6ff, #e8ecff); }
.structuredItem { overflow-x: auto; padding: 12px; border-radius: 8px; background: var(--el-fill-color-light); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.priceFields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 12px; }
.priceTable { margin-top: 22px; }
.productionPage :deep(.el-button:not(.is-text):not(.el-button--primary)) { color: #126fbc; border-color: #c7e2fa; background: #eef7ff; }
.productionPage :deep(.el-button:not(.is-text):not(.el-button--primary):hover) { color: #075c9f; border-color: #a7d4f8; background: #e1f1ff; }
.productionPage :deep(.el-button--primary) { color: #fff; border-color: #1689ec; background: #1689ec; box-shadow: 0 5px 13px #1689ec28; }
@media (max-width: 950px) { .productionPage { grid-template-columns: 190px minmax(0, 1fr); } .topBar, .pageBody { padding-left: 22px; padding-right: 22px; } .metricGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .flowGrid, .assetGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .twoColumns { grid-template-columns: 1fr; } .priceFields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) { .productionPage { display: block; overflow: auto; } .sideRail { position: sticky; top: 0; z-index: 2; padding: 10px 12px; .brandBlock, .projectBlock, .railFooter { display: none; } .stageNav { display: flex; gap: 4px; margin: 0; overflow-x: auto; button { width: auto; min-width: max-content; padding: 0 10px; } } } .mainArea { overflow: visible; } .topBar { height: auto; min-height: 84px; padding: 12px 16px; h1 { font-size: 20px; } .topActions { gap: 6px; .safeState { display: none; } .mobileLink { display: inline-flex; } } } .pageBody { height: auto; padding: 18px 16px 40px; } .heroCard { display: block; padding: 22px; } .metricGrid, .flowGrid, .assetGrid { grid-template-columns: 1fr 1fr; } }
</style>
