import { createHash } from "node:crypto";
import { realpath } from "@toonflow/file";
import { assetImageModel, assetImagePriceUnit, planAssetImage, previewAssetImage, bindAssetReference, listAssetReferences,
  type AssetImageInput, type SegmentModelStatus } from "@toonflow/production";
import conf from "@/utils/conf";
import { getMediaProvider } from "@/utils/media/provider";
import * as mediaTasks from "@/utils/media/tasks";
import { imageGenerationSchema } from "@/utils/media/schemas";
import { detectMimeType } from "@/utils/media/priceReference";
import { withProduction } from "./index";
import { productionCredentialScope } from "./generationGate";
import { boundProductionMediaTask, launchProductionMediaTask, recoverProductionMediaTask, syncProductionMediaTask } from "./mediaTasks";
import { preserveReferenceImage, readPreservedReference } from "./referenceImage";

async function modelStatus(): Promise<SegmentModelStatus> {
  const credentialScope = productionCredentialScope(conf.get("settings.mediaProviderConfigs.volcengine.apiKey"));
  try {
    const provider = await getMediaProvider("volcengine");
    return { revision: provider.revision, credentialScope, configured: !!credentialScope,
      available: provider.id === "volcengine" && provider.models.some(model => model.type === "image" && model.id === assetImageModel) };
  } catch { return { revision: "", credentialScope, configured: !!credentialScope, available: false }; }
}

export async function inspectAssetImage(directory: string, input: AssetImageInput) {
  const model = await modelStatus();
  return withProduction(directory, (catalog, store) => {
    const preview = previewAssetImage(catalog, store, input, model);
    imageGenerationSchema.parse(JSON.parse(preview.requestJson));
    return preview;
  });
}

export async function executeAssetImage(workspace: string, input: AssetImageInput,
  approval: { approved: true; maxCalls: 1; planHash: string; maxCostMicros: number }) {
  const directory = await realpath(workspace);
  const existing = await withProduction(directory, (catalog, store) => {
    const plan = planAssetImage(catalog, input);
    const task = store.findTaskByIdempotencyKey(plan.taskKey);
    return task?.requestStarted ? task : null;
  });
  if (existing) return { taskId: existing.id, ...await recoverProductionMediaTask(directory, input.projectId, existing.id, "image") };
  const preview = await inspectAssetImage(directory, input);
  if (!preview.canSubmit || !preview.price) throw new Error(preview.blockers.join("；"));
  if (approval.approved !== true || approval.maxCalls !== 1 || approval.planHash !== preview.planHash
    || !Number.isSafeInteger(approval.maxCostMicros) || approval.maxCostMicros < preview.price.amountMicros) throw new Error("资产方案或费用已变化，请重新检查并授权");
  const model = await modelStatus();
  const dispatch = await withProduction(directory, (catalog, store) => {
    const current = previewAssetImage(catalog, store, input, model);
    if (current.planHash !== preview.planHash || !current.canSubmit) throw new Error("资产投产依据已变化，请重新检查");
    return store.createHostMediaTask({ projectId: input.projectId, episodeId: preview.episodeId, idempotencyKey: preview.taskKey,
      stage: "image", provider: "volcengine", modelId: assetImageModel, requestJson: preview.requestJson, unit: assetImagePriceUnit, quantity: 1 },
    { workspace: directory, segmentKey: `资产图 · ${preview.targetName} · ${input.role}`, mediaType: "image",
      authorization: { approvedRequestHash: createHash("sha256").update(preview.requestJson).digest("hex"), approvedPlanHash: preview.planHash,
        priceRuleId: preview.price!.ruleId, maxCalls: 1, maxCostMicros: approval.maxCostMicros, currency: "CNY",
        providerRevision: model.revision, credentialScope: model.credentialScope, assetTarget: preview.assetTarget } });
  });
  if (dispatch.status === "budget_exhausted") return { taskId: dispatch.task.id, state: "queued", message: "预算不足，尚未提交；调整预算后继续同一任务" };
  if (dispatch.status !== "started") return { taskId: dispatch.task.id, ...await recoverProductionMediaTask(directory, input.projectId, dispatch.task.id, "image") };
  return { taskId: dispatch.task.id, ...await launchProductionMediaTask(directory, input.projectId, dispatch.task.id, "image") };
}

async function candidate(workspace: string, projectId: string, taskId: string) {
  const directory = await realpath(workspace);
  await syncProductionMediaTask(directory, projectId, taskId, "image");
  const { task, binding } = await boundProductionMediaTask(directory, projectId, taskId, "image");
  const record = await mediaTasks.inspect(directory, taskId); const receipt = record?.checkpoint.providerData;
  const file = record?.checkpoint.files?.[0]; const target = binding.authorization.assetTarget;
  if (task.state !== "succeeded" || !target || !file || receipt?.kind !== "arkImage" || receipt.version !== 1
    || receipt.model !== assetImageModel || receipt.mode !== "textToImage" || typeof receipt.created !== "number"
    || !Number.isSafeInteger(receipt.created) || receipt.created < 1 || receipt.created * 1000 > Date.now() + 300_000
    || !binding.authorization.credentialScope) throw new Error("图片尚未成功保存，或缺少可核验的文生图来源");
  const bytes = await readPreservedReference(directory, { path: file.path, sha256: file.hash });
  const request = imageGenerationSchema.parse(JSON.parse(task.requestJson));
  const metadata = await new Bun.Image(bytes).metadata();
  if (detectMimeType(bytes, "") !== "image/png" || `${metadata.width}x${metadata.height}` !== request.size
    || receipt.size !== request.size || receipt.requestedSize !== request.size) throw new Error("实际原图格式或尺寸与授权请求不符，不能采用");
  return { directory, target, file, bytes, origin: { taskId, modelId: assetImageModel, generatedAt: receipt.created * 1000,
    credentialScope: binding.authorization.credentialScope, method: "textToImage" as const, originalSha256: file.hash } };
}

export async function readAssetImage(workspace: string, projectId: string, taskId: string) {
  return (await candidate(workspace, projectId, taskId)).bytes;
}

export async function adoptAssetImage(workspace: string, projectId: string, taskId: string, rightsConfirmed: true) {
  if (rightsConfirmed !== true) throw new Error("请确认实际图片、角色形象与使用权后采用");
  const result = await candidate(workspace, projectId, taskId);
  const existing = await withProduction(result.directory, catalog => listAssetReferences(catalog, projectId).find(reference => reference.origin?.taskId === taskId));
  if (existing) return { reference: existing, created: false };
  const file = await preserveReferenceImage(result.directory, result.file.path, result.file.hash);
  return withProduction(result.directory, catalog => bindAssetReference(catalog, { projectId, ...result.target, rightsConfirmed: true,
    sourceNote: `Seedream 5.0 pro 文生图原图 · ${taskId}`, file }, result.origin));
}
