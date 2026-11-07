<template>
  <section v-if="videos.length" class="videoTaskPanel">
    <h3>片段视频任务</h3>
    <p>恢复会查询原任务并继续下载。状态不明时保留费用预留；不会重新生成视频。</p>
    <template v-for="task in videos" :key="task.id"><article>
      <div><strong>{{ episodeLabel(task.episodeId) }} · {{ task.segmentKey }}</strong><small>{{ task.modelId }} · {{ task.state === 'succeeded' ? '文件已保存，待质量与费用核对' : '可核对宿主任务状态' }}</small></div>
      <el-button :type="task.state === 'succeeded' ? undefined : 'primary'" :loading="pending === task.id" :disabled="!!pending && pending !== task.id" @click="recover(task.id)">{{ task.state === 'succeeded' ? '核验已保存视频' : '恢复并核对' }}</el-button>
      <el-button v-if="task.state === 'succeeded'" type="primary" @click="selectedTaskId = selectedTaskId === task.id ? '' : task.id">{{ selectedTaskId === task.id ? '收起审片' : '预览并采用' }}</el-button>
    </article>
    <segmentVideoPanel v-if="selectedTaskId === task.id" :directory="directory" :projectId="projectId" :taskId="task.id" @changed="emit('changed')" /></template>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="failure" class="failure" role="alert">{{ failure }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import axios from "axios";
import productionApi, { type ProjectProduction } from "@/lib/productionApi";
import segmentVideoPanel from "./segmentVideoPanel.vue";
const props = defineProps<{ directory: string; projectId: string; tasks: ProjectProduction["tasks"]; episodes: ProjectProduction["episodes"] }>();
const emit = defineEmits<{ changed: [] }>();
const videos = computed(() => props.tasks.filter(task => task.stage === "video" && task.hostTaskId));
const selectedTaskId = ref("");
const pending = ref(""); const notice = ref(""); const failure = ref(""); let version = 0;
watch(() => [props.directory, props.projectId], () => { version++; pending.value = ""; notice.value = ""; failure.value = ""; selectedTaskId.value = ""; });
onBeforeUnmount(() => { version++; });
function episodeLabel(id: string) { const episode = props.episodes.find(item => item.id === id); return episode ? `第 ${episode.episodeNumber} 集` : "所属分集资料缺失"; }
async function recover(taskId: string) {
  if (pending.value) return;
  const current = version; pending.value = taskId; notice.value = ""; failure.value = "";
  try {
    const result = await productionApi.recoverVideoTask(props.directory, props.projectId, taskId);
    if (current !== version) return;
    notice.value = result.message; emit("changed");
  } catch (cause) {
    if (current === version) failure.value = axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "恢复失败";
  } finally { if (current === version) pending.value = ""; }
}
</script>

<style scoped lang="scss">
.videoTaskPanel { padding: 22px; background: white; border: 1px solid #dfe9f2; border-radius: 12px; margin-bottom: 20px;
  h3 { margin: 0; } p, small { color: #657b91; font-size: 13px; line-height: 1.8; }
  article { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 16px 0; border-top: 1px solid #e8eef5; div { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; } }
  .failure { color: #a5422b; }
  @media(max-width: 600px) { article { flex-wrap: wrap; } }
}
</style>
