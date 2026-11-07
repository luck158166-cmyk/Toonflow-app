<template>
  <el-dialog v-model="visible" title="短剧生产" width="min(900px, calc(100vw - 32px))" appendToBody destroyOnClose>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="故事资料" name="stories">
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
      </el-tab-pane>
      <el-tab-pane label="价格规则" name="prices">
        <div class="priceCenter">
          <p>价格由你按供应商资料录入；保存规则不会发起模型请求。</p>
          <el-form labelPosition="top" @submit.prevent="recordPriceRule">
            <div class="priceFields">
              <el-form-item label="供应商 ID"><el-input v-model="priceProvider" maxlength="96" /></el-form-item>
              <el-form-item label="模型 ID"><el-input v-model="priceModel" maxlength="256" /></el-form-item>
              <el-form-item label="计费单位"><el-input v-model="priceUnit" placeholder="如 token、second、image" maxlength="64" /></el-form-item>
              <el-form-item label="每单位包含数量"><el-input-number v-model="priceUnitSize" :min="1" :max="1000000000" controlsPosition="right" /></el-form-item>
              <el-form-item label="每单位价格"><el-input v-model="priceAmount" placeholder="如 2.50" /></el-form-item>
              <el-form-item label="币种"><el-input v-model="priceCurrency" maxlength="3" /></el-form-item>
            </div>
            <el-form-item label="价格来源 HTTPS 链接"><el-input v-model="priceSourceUrl" placeholder="https://" maxlength="2048" /></el-form-item>
            <div class="priceActions"><el-button type="primary" :loading="savingPrice" @click="recordPriceRule">记录当前生效价格</el-button></div>
          </el-form>
          <div class="sectionHeading"><h3>已记录规则</h3><el-button :loading="loadingPrices" @click="loadPriceRules">刷新</el-button></div>
          <el-table :data="priceRules" v-loading="loadingPrices" maxHeight="260" emptyText="尚未录入价格规则">
            <el-table-column prop="provider" label="供应商" minWidth="110" />
            <el-table-column prop="modelId" label="模型" minWidth="160" />
            <el-table-column label="价格" minWidth="165"><template #default="{ row }">{{ formatPrice(row as PriceRule) }}</template></el-table-column>
            <el-table-column label="生效时间" minWidth="155"><template #default="{ row }">{{ new Date(row.effectiveAt).toLocaleString() }}</template></el-table-column>
            <el-table-column label="来源" minWidth="80"><template #default="{ row }"><a :href="row.sourceUrl" target="_blank" rel="noopener noreferrer">查看</a></template></el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
      <el-tab-pane label="预算与费用" name="budget">
        <div class="budgetCenter">
          <p>设置上限只会保存预算规则，不会授权或启动真实模型调用。</p>
          <el-form labelPosition="top" @submit.prevent="saveBudget">
            <div class="budgetFields">
              <el-form-item label="范围">
                <el-select v-model="budgetScope"><el-option label="全部项目" value="global" /><el-option label="当前故事" value="project" /></el-select>
              </el-form-item>
              <el-form-item v-if="budgetScope === 'project'" label="故事">
                <el-select v-model="budgetProjectId" placeholder="选择故事">
                  <el-option v-for="story in stories" :key="story.id" :label="story.title" :value="story.id" />
                </el-select>
              </el-form-item>
              <el-form-item label="上限金额"><el-input v-model="budgetLimit" placeholder="如 100.00；0 表示停止新增付费任务" /></el-form-item>
              <el-form-item label="币种"><el-input v-model="budgetCurrency" maxlength="3" /></el-form-item>
              <el-form-item label="预警阈值 (%)"><el-input-number v-model="budgetWarningPercent" :min="1" :max="100" controlsPosition="right" /></el-form-item>
            </div>
            <div class="budgetActions"><el-button type="primary" :loading="savingBudget" @click="saveBudget">保存预算上限</el-button></div>
          </el-form>
          <div class="sectionHeading"><h3>当前使用情况</h3><el-button :loading="loadingBudget" @click="loadBudget">刷新</el-button></div>
          <div v-loading="loadingBudget" class="budgetSummary">
            <p v-if="budgetScope === 'project' && !budgetProjectId">请选择故事查看预算。</p>
            <p v-else-if="!selectedBudget?.configured">{{ budgetScope === 'global' ? '尚未设置全局预算；付费生产请求将被拦截。' : '尚未设置单故事上限；全局预算仍然生效。' }}</p>
            <template v-else>
              <p>上限：{{ formatMoney(selectedBudget.limitMicros, selectedBudget.currency) }}</p>
              <p>已结算：{{ formatMoney(selectedBudget.chargedMicros, selectedBudget.currency) }}；在途预留：{{ formatMoney(selectedBudget.reservedMicros, selectedBudget.currency) }}</p>
              <p>已占用：{{ formatMoney(selectedBudget.usedMicros, selectedBudget.currency) }}；预警阈值：{{ selectedBudget.warningBasisPoints / 100 }}%</p>
            </template>
          </div>
          <h3>修改记录</h3>
          <el-table :data="selectedBudgetHistory" maxHeight="190" emptyText="尚无预算变更">
            <el-table-column label="时间" minWidth="160"><template #default="{ row }">{{ new Date(row.changedAt).toLocaleString() }}</template></el-table-column>
            <el-table-column label="新上限" minWidth="160"><template #default="{ row }">{{ formatMoney(row.limitMicros, row.currency) }}</template></el-table-column>
            <el-table-column label="预警阈值" minWidth="100"><template #default="{ row }">{{ row.warningBasisPoints / 100 }}%</template></el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<script setup lang="ts">
import axios from "axios";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import productionApi, { type BudgetOverview, type PriceRule, type SourceKind, type Story, type StoryDetail } from "@/lib/productionApi";

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
const activeTab = ref("stories");
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
const budgetScope = ref<"global" | "project">("global");
const budgetProjectId = ref("");
const budgetLimit = ref("");
const budgetCurrency = ref("CNY");
const budgetWarningPercent = ref(90);
const budgetOverview = ref<BudgetOverview | null>(null);
const loadingBudget = ref(false);
const savingBudget = ref(false);
const selectedBudget = computed(() => budgetScope.value === "global" ? budgetOverview.value?.global : budgetOverview.value?.project);
const selectedBudgetHistory = computed(() => budgetScope.value === "global"
  ? budgetOverview.value?.globalHistory ?? [] : budgetOverview.value?.projectHistory ?? []);

watch([visible, () => props.directory], ([open]) => {
  selectedStory.value = null;
  stories.value = [];
  priceRules.value = [];
  budgetOverview.value = null;
  if (open && props.directory) { void loadStories(); void loadPriceRules(); void loadBudget(); }
});
watch([budgetScope, budgetProjectId], () => { if (visible.value) void loadBudget(); });

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
    const result = await productionApi.listStories(directory);
    if (props.directory === directory) stories.value = result;
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    loading.value = false;
  }
}

async function selectStory(projectId: string) {
  const directory = props.directory;
  try {
    const result = await productionApi.getStory(directory, projectId);
    if (props.directory === directory && visible.value) selectedStory.value = result;
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
    const projectId = await productionApi.importStory(directory, title.value.trim(), sourceKind.value, sourceText.value);
    if (props.directory !== directory) return;
    title.value = "";
    sourceText.value = "";
    await loadStories();
    await selectStory(projectId);
    ElMessage.success("故事原文已保存");
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    saving.value = false;
  }
}

function moneyMicros(value: string) {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)) throw new Error("价格需为非负数字，最多 6 位小数");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
}

function formatPrice(rule: PriceRule) {
  return `${(rule.unitPriceMicros / 1_000_000).toFixed(6)} ${rule.currency} / ${rule.unitSize} ${rule.unit}`;
}

function formatMoney(micros: number, currency: string | null) {
  return `${(micros / 1_000_000).toFixed(6)} ${currency ?? ""}`.trim();
}

async function loadPriceRules() {
  const directory = props.directory;
  if (!directory) return;
  loadingPrices.value = true;
  try {
    const rules = await productionApi.listPriceRules(directory);
    if (props.directory === directory) priceRules.value = rules;
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally { loadingPrices.value = false; }
}

async function recordPriceRule() {
  const directory = props.directory;
  if (!directory || savingPrice.value) return;
  savingPrice.value = true;
  try {
    await productionApi.recordPriceRule(directory, {
      provider: priceProvider.value.trim(), modelId: priceModel.value.trim(), unit: priceUnit.value.trim(),
      unitSize: priceUnitSize.value, unitPriceMicros: moneyMicros(priceAmount.value.trim()),
      currency: priceCurrency.value.trim().toUpperCase(), sourceUrl: priceSourceUrl.value.trim(), effectiveAt: Date.now(),
    });
    if (props.directory !== directory) return;
    await loadPriceRules();
    ElMessage.success("价格规则已记录");
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally { savingPrice.value = false; }
}

async function loadBudget() {
  const directory = props.directory;
  const projectId = budgetScope.value === "project" ? budgetProjectId.value : "";
  if (!directory || budgetScope.value === "project" && !projectId) { budgetOverview.value = null; return; }
  loadingBudget.value = true;
  try {
    const result = await productionApi.getBudget(directory, projectId || undefined);
    if (props.directory === directory && (budgetScope.value !== "project" || budgetProjectId.value === projectId)) {
      budgetOverview.value = result;
    }
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally { loadingBudget.value = false; }
}

async function saveBudget() {
  const directory = props.directory;
  if (!directory || savingBudget.value) return;
  if (budgetScope.value === "project" && !budgetProjectId.value) { ElMessage.warning("请先选择故事"); return; }
  savingBudget.value = true;
  try {
    await productionApi.setBudget(directory, { scopeType: budgetScope.value,
      projectId: budgetScope.value === "project" ? budgetProjectId.value : undefined,
      limitMicros: moneyMicros(budgetLimit.value.trim()), currency: budgetCurrency.value.trim().toUpperCase(),
      warningBasisPoints: budgetWarningPercent.value * 100 });
    if (props.directory !== directory) return;
    await loadBudget();
    ElMessage.success("预算上限已保存");
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally { savingBudget.value = false; }
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
.priceCenter {
  p { color: var(--el-text-color-secondary); font-size: 13px; }
  .priceFields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 12px; }
  .priceActions { display: flex; justify-content: flex-end; margin-bottom: 18px; }
  .sectionHeading { display: flex; align-items: center; justify-content: space-between; }
}
@media (max-width: 680px) { .priceCenter .priceFields { grid-template-columns: 1fr; } }
.budgetCenter {
  p { color: var(--el-text-color-secondary); font-size: 13px; }
  .budgetFields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 12px; }
  .budgetActions { display: flex; justify-content: flex-end; margin-bottom: 18px; }
  .sectionHeading { display: flex; align-items: center; justify-content: space-between; }
  .budgetSummary { min-height: 84px; }
}
@media (max-width: 680px) { .budgetCenter .budgetFields { grid-template-columns: 1fr; } }
</style>
