<template>
  <section class="assetReferencePanel">
    <header><div><h3>参考图库</h3><p>将人物、场景和道具关联到原图，后续镜头复用同一版本。</p></div><el-button :loading="loading" :disabled="saving" @click="loadReferences">刷新图库</el-button></header>
    <p v-if="errorText" class="errorText" role="alert">{{ errorText }}</p>
    <div class="referenceSelectors"><el-select v-model="selectedId" :disabled="saving || loading" placeholder="选择人物、场景或道具" aria-label="参考图资产" popperClass="studioSelectPopup"><el-option v-for="target in targets" :key="target.entityId" :value="target.entityId" :label="`${kindLabel(target.kind)} · ${target.name}`" /></el-select><el-select v-model="role" :disabled="saving || loading" aria-label="参考图用途" popperClass="studioSelectPopup"><el-option v-for="item in selectedTarget?.roles ?? []" :key="item" :value="item" :label="roleLabel(item)" /></el-select></div>
    <template v-if="selectedTarget && !loading">
      <div class="assetDescription"><strong>{{ selectedTarget.name }}</strong><p>{{ selectedTarget.description }}</p><small>{{ selectedTarget.locked ? '资产描述已锁定' : '先在分集审核中确认资产描述，再绑定图片' }}</small></div>
      <assetImagePanel :directory="directory" :projectId="projectId" :target="selectedTarget" :role="role" @changed="loadReferences(); emit('changed')" @openCosts="emit('openCosts')" />
      <div class="referenceComparison">
        <article><h4>当前{{ roleLabel(role) }} <span v-if="currentReference">v{{ currentReference.version }}</span></h4><div class="imageFrame"><referenceThumb v-if="currentReference" :directory="directory" :projectId="projectId" :referenceId="currentReference.id" :label="selectedTarget.name" /><span v-else>尚未绑定原图</span></div><p v-if="currentReference">{{ currentReference.width }} × {{ currentReference.height }} · {{ currentReference.sourceNote }}</p><p v-if="currentReference && currentReference.entityHash !== selectedTarget.entityHash" class="errorText">资产描述已变化，原参考图需重新核对。</p></article>
        <article><h4>{{ currentReference ? '替换为新版本' : '选择参考图' }}</h4><div class="imageFrame"><img v-if="previewUrl" :src="previewUrl" alt="待确认的参考图" @load="imageReady = true" @error="imageReady = false" /><span v-else>选择原图后在此预览</span></div><input ref="fileInput" class="hiddenInput" type="file" accept="image/png,image/jpeg,image/webp" :disabled="saving" @change="chooseFile" /><el-button type="primary" :disabled="saving || !selectedTarget.locked" @click="fileInput?.click()">选择本地原图</el-button><small>{{ selectedFile?.name || 'PNG / JPEG / WebP，最大 20 MB；保留原始尺寸' }}</small></article>
      </div>
      <div v-if="selectedFile" class="bindActions">
        <label for="referenceSourceNote">图片来源与使用权说明</label><el-input id="referenceSourceNote" v-model="sourceNote" :disabled="saving" maxlength="2000" placeholder="填写图片来源及使用授权" />
        <el-checkbox v-model="rightsConfirmed" :disabled="saving">我已确认图片使用权及当前预览；{{ currentReference ? '同意新增版本，旧图继续保留' : '同意作为该资产的参考图' }}</el-checkbox>
        <el-button type="primary" :loading="saving" :disabled="!canBind" @click="bindReference">{{ currentReference ? '确认替换并保留旧版' : '确认绑定原图' }}</el-button>
      </div>
      <p class="notice">这里保存本地原图与用途，不压缩、不重绘，也不会自动声明平台人脸信任或视频就绪。模型是否接受该素材仍需生成前检查。</p>
      <details v-if="history.length"><summary>查看{{ roleLabel(role) }}历史（{{ history.length }} 版）</summary><article v-for="reference in history" :key="reference.id" class="historyRow"><div class="historyImage"><referenceThumb :directory="directory" :projectId="projectId" :referenceId="reference.id" :label="`${selectedTarget.name} 第 ${reference.version} 版`" /></div><div><b>v{{ reference.version }} {{ reference.id === currentReference?.id ? '· 当前版本' : '' }}</b><p>{{ reference.sourceNote }}</p><small>{{ reference.width }} × {{ reference.height }} · {{ new Date(reference.createdAt).toLocaleString() }}<br />SHA-256：{{ reference.sha256.slice(0, 16) }}…</small></div></article></details>
    </template>
    <p v-else-if="!loading" class="notice">生成分集并确认资产描述后，即可在此关联参考图。</p>
  </section>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import productionApi, { type AssetReference, type ReferenceRole, type ReferenceTarget } from "@/lib/productionApi";
import referenceThumb from "./referenceThumb.vue";
import assetImagePanel from "./assetImagePanel.vue";
const props = defineProps<{ directory: string; projectId: string }>();
const emit = defineEmits<{ changed: []; openCosts: [] }>();
const targets = ref<ReferenceTarget[]>([]);
const references = ref<AssetReference[]>([]);
const selectedId = ref("");
const role = ref<ReferenceRole>("headshot");
const loading = ref(false);
const saving = ref(false);
const errorText = ref("");
const fileInput = ref<HTMLInputElement>();
const selectedFile = ref<File | null>(null);
const previewUrl = ref("");
const imageReady = ref(false);
const sourceNote = ref("");
const rightsConfirmed = ref(false);
let requestVersion = 0;
const selectedTarget = computed(() => targets.value.find(item => item.entityId === selectedId.value));
const history = computed(() => references.value.filter(item => item.entityId === selectedId.value && item.role === role.value));
const currentReference = computed(() => history.value[0] ?? null);
const canBind = computed(() => !saving.value && !loading.value && selectedTarget.value?.locked
  && !!selectedFile.value && imageReady.value && rightsConfirmed.value && !!sourceNote.value.trim());
function kindLabel(kind: string) { return ({ character: "角色", scene: "场景", prop: "道具", costume: "服装" } as Record<string, string>)[kind] ?? kind; }
function roleLabel(value: ReferenceRole) { return { headshot: "面部图", fullBody: "全身妆造图", scene: "场景图", prop: "道具图", costume: "服装图" }[value]; }
function clearSelection() { selectedFile.value = null; imageReady.value = false; rightsConfirmed.value = false; sourceNote.value = ""; if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); previewUrl.value = ""; if (fileInput.value) fileInput.value.value = ""; }
watch(selectedId, () => { role.value = selectedTarget.value?.roles[0] ?? "headshot"; clearSelection(); });
watch(role, clearSelection);
watch(sourceNote, () => { rightsConfirmed.value = false; });
watch(() => [props.directory, props.projectId], () => { targets.value = []; references.value = []; selectedId.value = ""; void loadReferences(); }, { immediate: true });
onBeforeUnmount(() => { requestVersion++; clearSelection(); });
function message(cause: unknown) { return axios.isAxiosError<{ message?: string }>(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "参考图操作失败"; }
async function loadReferences() {
  const version = ++requestVersion; clearSelection(); errorText.value = "";
  if (!props.directory || !props.projectId) { loading.value = false; return; }
  loading.value = true;
  try {
    const result = await productionApi.getAssetReferences(props.directory, props.projectId);
    if (version !== requestVersion) return;
    targets.value = result.targets; references.value = result.references;
    if (!result.targets.some(item => item.entityId === selectedId.value)) selectedId.value = result.targets[0]?.entityId ?? "";
  } catch (cause) { if (version === requestVersion) errorText.value = message(cause); }
  finally { if (version === requestVersion) loading.value = false; }
}
function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  clearSelection(); errorText.value = "";
  if (!file) return;
  if (!file.size || file.size > 20 * 1024 * 1024) { errorText.value = "请选择不超过 20 MB 的非空图片"; return; }
  selectedFile.value = file; previewUrl.value = URL.createObjectURL(file);
}
async function bindReference() {
  if (!canBind.value || !selectedTarget.value || !selectedFile.value) return;
  const directory = props.directory; const projectId = props.projectId;
  const target = selectedTarget.value; const selectedRole = role.value; const file = selectedFile.value;
  const expectedReferenceId = currentReference.value?.id ?? null; const note = sourceNote.value.trim();
  saving.value = true; errorText.value = "";
  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    const files = useWorkspaceFiles(directory);
    for (const folder of ["assets", "assets/referenceImports"]) {
      try { await files.mkdir(folder); } catch { await files.list(folder); }
    }
    const path = `assets/referenceImports/image${crypto.randomUUID().replaceAll("-", "")}.bin`;
    await files.write(path, bytes, true);
    await productionApi.bindAssetReference(directory, { projectId, entityKind: target.entityKind, entityId: target.entityId,
      entityHash: target.entityHash, role: selectedRole, expectedReferenceId, rightsConfirmed: true, sourceNote: note, path, sha256 });
    if (props.directory !== directory || props.projectId !== projectId) return;
    await loadReferences(); emit("changed"); ElMessage.success("原图已绑定，旧版本与来源记录已保留");
  } catch (cause) { if (props.directory === directory && props.projectId === projectId) { errorText.value = message(cause); rightsConfirmed.value = false; } }
  finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.assetReferencePanel {
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; h3 { margin: 0; } p { color: #708397; font-size: 13px; } }
  .referenceSelectors { display: flex; gap: 12px; margin: 18px 0; .el-select { max-width: 350px; } }
  .assetDescription { padding: 14px; border-radius: 9px; color: #31516f; background: #eef7ff; p { line-height: 1.7; margin: 8px 0; } small { color: #6086a8; } }
  .referenceComparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; article { min-width: 0; h4 { font-weight: 600; } p { font-size: 12px; overflow-wrap: anywhere; } > small { display: block; margin: 10px 0; color: #8092a6; } } .imageFrame { display: grid; place-items: center; height: 260px; margin-bottom: 12px; border: 1px solid #dce8f3; border-radius: 10px; background: #f5f9fd; overflow: hidden; color: #8da1b7; img { height: 100%; width: 100%; object-fit: contain; } } }
  .hiddenInput { display: none; }
  .bindActions { display: grid; gap: 12px; margin-top: 18px; padding: 18px; border-radius: 10px; background: #eef7ff; .el-button { justify-self: start; } .el-checkbox { height: auto; :deep(.el-checkbox__label) { white-space: normal; line-height: 1.7; } } }
  .notice, small { color: #788da2; font-size: 12px; line-height: 1.7; }
  .errorText { padding: 12px; color: #a46c22; background: #fff6e6; border-radius: 8px; }
  details summary { padding: 12px 0; cursor: pointer; color: #1689ec; }
  .historyRow { display: flex; gap: 16px; padding: 12px 0; border-top: 1px solid #e6eef6; .historyImage { width: 90px; height: 110px; flex-shrink: 0; } p { margin: 8px 0; overflow-wrap: anywhere; } }
  @media(max-width: 700px) { .referenceComparison { grid-template-columns: 1fr; } .referenceSelectors { flex-wrap: wrap; } }
}
</style>
