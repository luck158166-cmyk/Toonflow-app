import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "@toonflow/file";
import { serializeHostMediaRequest } from "@toonflow/production";
import * as mediaTasks from "@/utils/media/tasks";
import { videoGenerationSchema, imageGenerationSchema } from "@/utils/media/schemas";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { withProduction } from "./index";
import { withProductionMediaSubmission } from "./generationGate";

export async function boundProductionMediaTask(directory: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  return withProduction(directory, (catalog, store) => {
    const project = catalog.getProjectProduction(projectId);
    const task = store.getTask(taskId); const binding = store.getHostMediaBinding(taskId);
    if (!binding || binding.workspace !== directory || task.projectId !== projectId
      || !project.episodes.some(episode => episode.id === task.episodeId)
      || binding.mediaType !== mediaType || task.stage !== mediaType || task.provider !== "volcengine") {
      throw new Error("该媒体任务不属于当前工作区与故事");
    }
    const request = (mediaType === "video" ? videoGenerationSchema : imageGenerationSchema).parse(JSON.parse(task.requestJson));
    if (serializeHostMediaRequest(request) !== task.requestJson || request.providerId !== task.provider || request.modelId !== task.modelId) {
      throw new Error("媒体任务请求与生产记录不一致");
    }
    return { task, binding, request };
  });
}

/** Reconcile native persisted evidence, never infer a fee or a missing provider receipt. */
const reconciliations = new Map<string, Promise<{ state: string; message: string }>>();
export async function syncProductionMediaTask(workspace: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  const directory = await realpath(workspace);
  const key = JSON.stringify([directory, projectId, taskId, mediaType]);
  const pending = reconciliations.get(key);
  if (pending) return pending;
  const reconciliation = sync(directory, projectId, taskId, mediaType).finally(() => { reconciliations.delete(key); });
  reconciliations.set(key, reconciliation);
  return reconciliation;
}

async function sync(directory: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  const { task, binding } = await boundProductionMediaTask(directory, projectId, taskId, mediaType);
  const record = await mediaTasks.inspect(directory, taskId);
  if (!record) {
    if (binding.launchClaimed && task.state !== "succeeded") {
      await withProduction(directory, (_catalog, store) => { if (store.getTask(taskId).state !== "succeeded") store.markReconciliationRequired(taskId); });
    }
    return { state: task.state === "succeeded" ? "succeeded" : binding.launchClaimed ? "reconcile_required" : task.state,
      message: binding.launchClaimed ? "宿主记录缺失，保留费用预留并等待核对，不重新提交" : "尚未提交宿主任务" };
  }
  if (record.cwd !== directory || record.mediaType !== mediaType || serializeHostMediaRequest(record.request) !== task.requestJson) {
    throw new Error("宿主任务与生产请求不一致，已停止恢复");
  }
  const receipt = record.checkpoint.providerData;
  const providerTaskId = receipt?.kind === "arkVideo" && receipt.version === 1 && receipt.model === task.modelId
    && typeof receipt.taskId === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(receipt.taskId) ? receipt.taskId : null;
  if (providerTaskId && task.state !== "succeeded") {
    await withProduction(directory, (_catalog, store) => {
      const current = store.getTask(taskId);
      if (current.state !== "succeeded") store.registerProviderTask(taskId, providerTaskId);
      else if (current.providerTaskId !== providerTaskId) throw new Error("已成功任务的平台凭据不一致");
    });
  } else if (task.providerTaskId && task.providerTaskId !== providerTaskId) throw new Error("宿主平台任务凭据与生产记录不一致");
  if (record.state === "succeeded") {
    const file = record.checkpoint.files?.[0];
    const imageValid = mediaType === "image" && receipt?.kind === "arkImage" && receipt.version === 1 && receipt.model === task.modelId && receipt.mode === "textToImage";
    if (!(mediaType === "video" ? providerTaskId : imageValid) || record.checkpoint.assetCount !== 1 || record.checkpoint.files?.length !== 1 || !file
      || file.index !== 0 || file.mediaType !== mediaType || record.result?.data?.length !== 1
      || record.result.data[0]?.path !== file.path) throw new Error("媒体成功凭据或产物清单不完整");
    const resolved = await resolveWorkspacePath(directory, file.path);
    const release = lockWorkspaceFiles([resolved.path]);
    try {
      const info = await lstat(resolved.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 100 * 1024 * 1024) throw new Error("媒体产物文件无效");
      const bytes = await readFile(resolved.path);
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash) throw new Error("媒体产物哈希不符；不会重新付费生成");
      await withProduction(directory, (_catalog, store) => store.completeTask(taskId, { slot: mediaType, path: file.path, sha256: file.hash }));
    } finally { release(); }
    return { state: "succeeded", message: `${mediaType === "image" ? "图片" : "视频"}已保存并核验，费用仍待平台对账；内容质量尚未确认` };
  }
  if (record.state !== "running" && task.state !== "succeeded") {
    await withProduction(directory, (_catalog, store) => { if (store.getTask(taskId).state !== "succeeded") store.markReconciliationRequired(taskId); });
  }
  return { state: record.state === "running" ? "running" : "reconcile_required",
    message: record.result?.message ?? "宿主正在处理媒体任务，未新增调用" };
}

const observers = new Map<string, Promise<void>>();
const submissions = new Map<string, Promise<{ state: string; message: string }>>();
function observe(directory: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  const key = JSON.stringify([directory, taskId, mediaType]);
  if (observers.has(key)) return;
  const completion = (async () => {
    try { await mediaTasks.wait(directory, taskId); } catch { /* Native result/receipt is authoritative, including unknown outcomes. */ }
    await syncProductionMediaTask(directory, projectId, taskId, mediaType);
  })().catch(cause => { console.error("同步生产媒体任务失败", taskId, cause instanceof Error ? cause.message : "未知错误"); })
    .finally(() => { observers.delete(key); });
  observers.set(key, completion);
}

/** Internal entry for a ready, priced and authorized production plan. No arbitrary request is accepted. */
export async function launchProductionMediaTask(workspace: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  const directory = await realpath(workspace);
  const key = JSON.stringify([directory, projectId, taskId, mediaType]);
  const pending = submissions.get(key);
  if (pending) return pending;
  const submission = launch(directory, projectId, taskId, mediaType).finally(() => { submissions.delete(key); });
  submissions.set(key, submission);
  return submission;
}

async function launch(directory: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  const { request, binding } = await boundProductionMediaTask(directory, projectId, taskId, mediaType);
  if (binding.launchClaimed) return syncProductionMediaTask(directory, projectId, taskId, mediaType);
  const claimed = await withProduction(directory, (_catalog, store) =>
    store.claimHostMediaLaunch(taskId, directory, mediaType, serializeHostMediaRequest(request)));
  if (!claimed) return syncProductionMediaTask(directory, projectId, taskId, mediaType);
  try {
    await withProductionMediaSubmission(directory, taskId, () => mediaTasks.start(directory, taskId, mediaType, request));
    observe(directory, projectId, taskId, mediaType);
    return { state: "running", message: "已交给宿主持久化任务执行" };
  } catch (cause) {
    await withProduction(directory, (_catalog, store) => store.markReconciliationRequired(taskId));
    throw cause;
  }
}

/** Recovery only inspects/resumes the bound UUID. It never calls start or creates a new UUID. */
export async function recoverProductionMediaTask(workspace: string, projectId: string, taskId: string, mediaType: "video" | "image") {
  const directory = await realpath(workspace);
  await submissions.get(JSON.stringify([directory, projectId, taskId, mediaType]));
  const { binding } = await boundProductionMediaTask(directory, projectId, taskId, mediaType);
  if (!binding.launchClaimed) return syncProductionMediaTask(directory, projectId, taskId, mediaType);
  await syncProductionMediaTask(directory, projectId, taskId, mediaType);
  const snapshot = (await mediaTasks.status(directory, [taskId], true))[0]!;
  if (snapshot.state === "running") observe(directory, projectId, taskId, mediaType);
  return syncProductionMediaTask(directory, projectId, taskId, mediaType);
}
