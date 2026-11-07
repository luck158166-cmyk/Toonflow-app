import { createHash } from "node:crypto";
import { realpath } from "@toonflow/file";
import { previewSegmentExecution, reviewSegmentPreflight, segmentTaskKey, type SegmentExecutionInput, type SegmentModelStatus } from "@toonflow/production";
import conf from "@/utils/conf";
import { getMediaProvider } from "@/utils/media/provider";
import { videoGenerationSchema } from "@/utils/media/schemas";
import { withProduction } from "./index";
import { readPreservedReference } from "./referenceImage";
import { launchProductionVideoTask, recoverProductionVideoTask } from "./videoTasks";
import { productionCredentialScope } from "./generationGate";

async function modelStatus(): Promise<SegmentModelStatus> {
  const key: unknown = conf.get("settings.mediaProviderConfigs.volcengine.apiKey");
  try {
    const provider = await getMediaProvider("volcengine");
    return { revision: provider.revision, credentialScope: productionCredentialScope(key), configured: typeof key === "string" && !!key.trim(),
      available: provider.id === "volcengine" && provider.models.some(model => model.type === "video" && model.id === "doubao-seedance-2-5-260628") };
  } catch { return { revision: "", available: false, configured: typeof key === "string" && !!key.trim() }; }
}

export async function inspectSegmentExecution(directory: string, input: SegmentExecutionInput) {
  const model = await modelStatus();
  return withProduction(directory, async (catalog, store) => {
    const preview = previewSegmentExecution(catalog, store, input, model);
    videoGenerationSchema.parse(JSON.parse(preview.requestJson));
    const checked = new Map<string, number>();
    let encodedBytes = 0;
    for (const slot of preview.references) {
      if (!slot.reference) continue;
      const previousSize = checked.get(slot.reference.sha256);
      if (previousSize !== undefined) { encodedBytes += previousSize; continue; }
      try {
        const bytes = await readPreservedReference(directory, slot.reference);
        encodedBytes += 4 * Math.ceil(bytes.length / 3);
        checked.set(slot.reference.sha256, 4 * Math.ceil(bytes.length / 3));
        const { width, height } = await new Bun.Image(bytes).metadata();
        if (width !== slot.reference.width || height !== slot.reference.height || width < 300 || height < 300
          || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) {
          preview.blockers.push({ code: "referenceDimensions", message: `${slot.name}原图尺寸与记录或当前方舟规格不符，请重新准备原图` });
        }
      }
      catch { preview.blockers.push({ code: "referenceBytes", message: `${slot.name}的参考原图缺失、被改动或暂不可读` }); }
    }
    if (encodedBytes + Buffer.byteLength(preview.requestJson) + preview.references.length * 256 >= 64 * 1024 * 1024) {
      preview.blockers.push({ code: "requestSize", message: "本片段原图编码后的请求超过平台大小限制，请重新规划素材" });
    }
    preview.canSubmit = !preview.blockers.length;
    return preview;
  });
}

export async function recordSegmentPreflight(directory: string, input: SegmentExecutionInput, review: Parameters<typeof reviewSegmentPreflight>[2]) {
  const preview = await inspectSegmentExecution(directory, input);
  if (preview.blockers.some(item => item.code === "referenceBytes")) throw new Error("参考原图核验失败，不能保存投产复核");
  return withProduction(directory, catalog => reviewSegmentPreflight(catalog, input, review));
}

export async function executeSegmentVideo(workspace: string, input: SegmentExecutionInput,
  approval: { approved: true; maxCalls: 1; planHash: string; maxCostMicros: number }) {
  const directory = await realpath(workspace);
  // Content identity precedes current configuration: changed prices or review state must never regenerate a started task.
  const existing = await withProduction(directory, (catalog, store) => {
    if (!catalog.getProjectProduction(input.projectId).episodes.some(episode => episode.id === input.episodeId)) throw new Error("分集不属于当前故事");
    const task = store.findTaskByIdempotencyKey(segmentTaskKey(input));
    return task?.requestStarted ? task : null;
  });
  if (existing) return { taskId: existing.id, ...await recoverProductionVideoTask(directory, input.projectId, existing.id) };
  const preview = await inspectSegmentExecution(directory, input);
  if (!preview.canSubmit || !preview.price) throw new Error(preview.blockers.map(item => item.message).join("；"));
  if (approval.approved !== true || approval.maxCalls !== 1 || approval.planHash !== preview.planHash
    || !Number.isSafeInteger(approval.maxCostMicros) || approval.maxCostMicros < preview.price.estimatedCostMicros) throw new Error("方案或费用已变化，请重新检查并确认本次调用");
  const model = await modelStatus();
  const dispatch = await withProduction(directory, (catalog, store) => {
    const current = previewSegmentExecution(catalog, store, input, model);
    if (current.planHash !== preview.planHash || !current.canSubmit) throw new Error("投产依据已变化，请重新检查");
    return store.createHostMediaTask({ projectId: input.projectId, episodeId: input.episodeId,
      idempotencyKey: segmentTaskKey(input), stage: "video", provider: "volcengine", modelId: "doubao-seedance-2-5-260628",
      requestJson: preview.requestJson, unit: preview.price!.unit, quantity: preview.price!.quantity },
    { workspace: directory, segmentKey: `片段 ${input.sequence} · ${input.inputHash.slice(0, 12)}`, mediaType: "video",
      authorization: { approvedRequestHash: createHash("sha256").update(preview.requestJson).digest("hex"),
        approvedPlanHash: preview.planHash, priceRuleId: preview.price!.ruleId, maxCalls: 1,
        maxCostMicros: approval.maxCostMicros, currency: "CNY", providerRevision: model.revision, credentialScope: model.credentialScope } });
  });
  if (dispatch.status === "budget_exhausted") return { taskId: dispatch.task.id, state: "queued", message: "预算不足，任务尚未提交；调整预算后可继续同一任务" };
  if (dispatch.status !== "started") return { taskId: dispatch.task.id, ...await recoverProductionVideoTask(directory, input.projectId, dispatch.task.id) };
  return { taskId: dispatch.task.id, ...await launchProductionVideoTask(directory, input.projectId, dispatch.task.id) };
}
