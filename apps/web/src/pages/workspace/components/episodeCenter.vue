<template>
  <section class="episodeCenter">
    <p>手动建立分集并查看费用。这里不会启动模型任务；金额按币种分别统计。</p>
    <el-form labelPosition="top" @submit.prevent="createEpisode">
      <div class="episodeFields">
        <el-form-item label="故事">
          <el-select v-model="projectId" placeholder="选择故事" filterable>
            <el-option v-for="story in props.stories" :key="story.id" :label="story.title" :value="story.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="集数"><el-input-number v-model="episodeNumber" :min="1" :max="100000" controlsPosition="right" /></el-form-item>
        <el-form-item label="标题"><el-input v-model="title" maxlength="200" /></el-form-item>
      </div>
      <el-form-item label="本集梗概"><el-input v-model="logline" type="textarea" :rows="2" maxlength="2000" /></el-form-item>
      <el-button type="primary" :loading="saving" :disabled="!projectId || !title.trim()" @click="createEpisode">创建分集</el-button>
      <el-button :loading="loading" :disabled="!projectId" @click="loadEpisodes">刷新</el-button>
    </el-form>
    <el-table :data="episodes" v-loading="loading" maxHeight="220" emptyText="当前故事尚无分集" highlightCurrentRow @current-change="selectEpisode">
      <el-table-column prop="episodeNumber" label="集数" width="72" />
      <el-table-column prop="title" label="标题" minWidth="160" />
      <el-table-column prop="logline" label="梗概" minWidth="240" showOverflowTooltip />
      <el-table-column prop="shotCount" label="镜头" width="72" />
      <el-table-column prop="reviewState" label="审核" width="110" />
    </el-table>
    <div v-if="selectedEpisode" class="episodeCosts" v-loading="loadingCost">
      <div class="sectionHeading"><h3>第 {{ selectedEpisode.episodeNumber }} 集费用</h3><el-button @click="loadCost">刷新费用</el-button></div>
      <template v-if="cost">
        <p v-for="total in totals" :key="total.currency">{{ total.currency }}：已结算 {{ formatMoney(total.chargedMicros, total.currency) }}；在途预留 {{ formatMoney(total.reservedMicros, total.currency) }}</p>
        <p v-if="totals.length === 0">暂无任务或费用。</p>
        <el-table :data="cost.charges" maxHeight="220" emptyText="暂无费用记录">
          <el-table-column label="时间" minWidth="155"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
          <el-table-column prop="stage" label="环节" minWidth="95" />
          <el-table-column prop="provider" label="供应商" minWidth="115" />
          <el-table-column prop="modelId" label="模型" minWidth="130" />
          <el-table-column label="金额" minWidth="115"><template #default="{ row }">{{ formatMoney(row.amountMicros, row.currency) }}</template></el-table-column>
          <el-table-column label="计费状态" minWidth="105"><template #default="{ row }">{{ row.status === "manual" ? "人工核对" : "已核对" }}</template></el-table-column>
          <el-table-column prop="sourceRef" label="来源编号" minWidth="140" showOverflowTooltip />
        </el-table>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import productionApi, { type Episode, type EpisodeCost, type Story } from "@/lib/productionApi";

const props = defineProps<{ directory: string; stories: Story[]; selectedProjectId?: string }>();
const emit = defineEmits<{ changed: [] }>();
const projectId = ref("");
const episodeNumber = ref(1);
const title = ref("");
const logline = ref("");
const episodes = ref<Episode[]>([]);
const selectedEpisode = ref<Episode | null>(null);
const cost = ref<EpisodeCost | null>(null);
const loading = ref(false);
const loadingCost = ref(false);
const saving = ref(false);
const totals = computed(() => {
  const byCurrency = new Map<string, { currency: string; chargedMicros: number; reservedMicros: number }>();
  for (const item of cost.value?.breakdown ?? []) {
    const total = byCurrency.get(item.currency) ?? { currency: item.currency, chargedMicros: 0, reservedMicros: 0 };
    total.chargedMicros += item.chargedMicros;
    total.reservedMicros += item.reservedMicros;
    byCurrency.set(item.currency, total);
  }
  return [...byCurrency.values()];
});

watch(() => props.stories, stories => {
  if (!stories.some(story => story.id === projectId.value)) projectId.value = props.selectedProjectId || stories[0]?.id || "";
}, { immediate: true });
watch(() => props.selectedProjectId, value => { if (value && value !== projectId.value) projectId.value = value; });
watch(projectId, () => { selectedEpisode.value = null; cost.value = null; void loadEpisodes(); });
watch(() => props.directory, () => { selectedEpisode.value = null; cost.value = null; void loadEpisodes(); });

function showError(cause: unknown) {
  ElMessage.error(axios.isAxiosError<{ message?: string }>(cause)
    ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "操作失败");
}

function formatMoney(micros: number, currency: string) {
  return `${(micros / 1_000_000).toFixed(4)} ${currency}`;
}

async function loadEpisodes() {
  const directory = props.directory;
  const storyId = projectId.value;
  if (!directory || !storyId) { episodes.value = []; return; }
  loading.value = true;
  try {
    const result = await productionApi.listEpisodes(directory, storyId);
    if (props.directory === directory && projectId.value === storyId) episodes.value = result;
  } catch (cause) { showError(cause); }
  finally { loading.value = false; }
}

async function createEpisode() {
  if (!projectId.value || !title.value.trim()) return;
  saving.value = true;
  try {
    const episode = await productionApi.createEpisode(props.directory, projectId.value, episodeNumber.value, title.value.trim(), logline.value);
    title.value = "";
    logline.value = "";
    episodeNumber.value = episode.episodeNumber + 1;
    await loadEpisodes();
    emit("changed");
    ElMessage.success("分集已创建");
  } catch (cause) { showError(cause); }
  finally { saving.value = false; }
}

function selectEpisode(episode: Episode | null) {
  selectedEpisode.value = episode;
  cost.value = null;
  if (episode) void loadCost();
}

async function loadCost() {
  const directory = props.directory;
  const storyId = projectId.value;
  const episodeId = selectedEpisode.value?.id;
  if (!episodeId) return;
  loadingCost.value = true;
  try {
    const result = await productionApi.getEpisodeCost(directory, storyId, episodeId);
    if (props.directory === directory && projectId.value === storyId && selectedEpisode.value?.id === episodeId) cost.value = result;
  } catch (cause) { showError(cause); }
  finally { loadingCost.value = false; }
}
</script>

<style scoped lang="scss">
.episodeCenter {
  max-height: 65vh;
  overflow: auto;
  .episodeFields { display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 12px; }
  .sectionHeading { display: flex; align-items: center; justify-content: space-between; }
  .episodeCosts { margin-top: 22px; }
  @media (max-width: 680px) { .episodeFields { grid-template-columns: 1fr; } }
}
</style>
