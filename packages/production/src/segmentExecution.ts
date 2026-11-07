import { createHash, randomUUID } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import { getEpisodeSegmentPlan } from "./segmentPlan";
import { serializeHostMediaRequest, type ProductionStore } from "./store";

export type SegmentExecutionInput = { projectId: string; episodeId: string; sequence: number; inputHash: string };
export type SegmentPreflightReview = { id: string; note: string; reviewedBy: string; createdAt: number };
export type SegmentModelStatus = { revision: string; available: boolean; configured: boolean };
export const segmentVideoPriceUnit = "seedance25NoVideo1080SecondCeiling";
export const segmentVideoDestination = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
const hash = (value: unknown) => createHash("sha256").update(serializeHostMediaRequest(value)).digest("hex");

function selection(catalog: ProductionCatalog, input: SegmentExecutionInput) {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("片段序号无效");
  const plan = getEpisodeSegmentPlan(catalog, input.projectId, input.episodeId);
  if (plan.inputHash !== input.inputHash) throw new Error("片段依据已变化，请重新规划并预检");
  const segment = plan.snapshot.segments.find(item => item.sequence === input.sequence);
  if (!segment) throw new Error("当前方案中没有这个片段");
  const saved = plan.history.find(item => item.inputHash === input.inputHash);
  return { plan, segment, saved };
}

function readReview(catalog: ProductionCatalog, input: SegmentExecutionInput) {
  return catalog.db.query(`SELECT id, note, reviewed_by AS reviewedBy, created_at AS createdAt
    FROM segment_preflight_review WHERE project_id = ? AND episode_id = ? AND plan_hash = ? AND segment_sequence = ?`)
    .get(input.projectId, input.episodeId, input.inputHash, input.sequence) as SegmentPreflightReview | null;
}

export function reviewSegmentPreflight(catalog: ProductionCatalog, input: SegmentExecutionInput,
  review: { actionConfirmed: true; continuityConfirmed: true; dialogueConfirmed: true; referencesConfirmed: true; note: string }) {
  if (review.actionConfirmed !== true || review.continuityConfirmed !== true || review.dialogueConfirmed !== true
    || review.referencesConfirmed !== true || !review.note.trim() || review.note.length > 2000) throw new Error("请逐项复核片段并填写发音或连续性核对说明");
  return catalog.withTransaction(() => {
    const { saved, segment } = selection(catalog, input);
    if (!saved || segment.checks.some(item => item.state === "failed")) throw new Error("请先修正静态问题并保存当前片段方案");
    const old = readReview(catalog, input);
    if (old) {
      if (old.note !== review.note.trim()) throw new Error("本版本已保存复核记录；内容变更后请建立新方案再审核");
      return old;
    }
    catalog.db.query(`INSERT INTO segment_preflight_review(id, project_id, episode_id, plan_hash,
      segment_sequence, note, reviewed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'local-user', ?)`)
      .run(randomUUID(), input.projectId, input.episodeId, input.inputHash, input.sequence, review.note.trim(), Date.now());
    return readReview(catalog, input)!;
  });
}

export function segmentTaskKey(input: SegmentExecutionInput) {
  return `segmentVideo:${hash([input.projectId, input.episodeId, input.inputHash, input.sequence, "volcengine", "doubao-seedance-2-5-260628"])}`;
}

/** Review resolves human preflight only. It cannot substitute for platform face provenance or post-generation QC. */
export function previewSegmentExecution(catalog: ProductionCatalog, store: ProductionStore, input: SegmentExecutionInput, model: SegmentModelStatus) {
  const { segment, saved } = selection(catalog, input); const review = readReview(catalog, input);
  const checks = segment.checks.map(item => review && item.state === "pending" && ["P17", "contentQuality"].includes(item.code)
    ? { ...item, state: "passed" as const, message: `本机人工投产复核已记录；不代表生成后质量通过（${item.code}）` } : item);
  const blockers = checks.filter(item => item.state !== "passed").map(item => ({ code: item.code, message: item.message }));
  if (!saved) blockers.push({ code: "plan", message: "请先保存当前片段方案" });
  if (!model.available) blockers.push({ code: "model", message: "请安装支持当前规格的内置方舟视频供应商" });
  if (!model.configured) blockers.push({ code: "configuration", message: "请在模型与设置中配置方舟密钥" });
  const images = segment.references.flatMap(slot => slot.reference ? [{ path: slot.reference.path, mimeType: slot.reference.mimeType }] : []);
  const request = { providerId: "volcengine", modelId: segment.requestDraft.model, prompt: segment.requestDraft.prompt,
    images, referenceOrder: images.map((_image, index) => ({ type: "image" as const, index })),
    duration: segment.requestDraft.duration, ratio: segment.requestDraft.ratio, resolution: segment.requestDraft.resolution,
    generateAudio: segment.requestDraft.generateAudio, mode: images.length ? ["imageReference:30"] : "text" };
  const requestJson = serializeHostMediaRequest(request);
  let price: { ruleId: string; estimatedCostMicros: number; sourceUrl: string; unit: string; quantity: number } | null = null;
  try {
    if (request.modelId !== "doubao-seedance-2-5-260628" || request.ratio !== "9:16" || request.resolution !== "1080p"
      || !Number.isInteger(request.duration) || request.duration < 4 || request.duration > 30) throw new Error("当前预留规则仅支持 Seedance 2.5、9:16、1080p、4–30 秒且不含输入视频的任务");
    const quote = store.globalBudgets.quotePrice("volcengine", request.modelId, segmentVideoPriceUnit, request.duration);
    if (quote.currency !== "CNY" || quote.amountMicros < 1) throw new Error("请确认有效的人民币视频保守秒价");
    price = { ruleId: quote.rule.id, estimatedCostMicros: quote.amountMicros, sourceUrl: quote.rule.sourceUrl, unit: segmentVideoPriceUnit, quantity: request.duration };
  } catch (cause) { blockers.push({ code: "price", message: `缺少适用的视频价格：${cause instanceof Error ? cause.message : "报价失败"}` }); }
  const basis = { ...input, reviewId: review?.id ?? null, modelRevision: model.revision, requestJson, price, destination: segmentVideoDestination };
  const existing = store.findTaskByIdempotencyKey(segmentTaskKey(input));
  return { ...basis, planHash: hash(basis), review, checks, blockers, canSubmit: blockers.length === 0,
    savedVersion: saved?.version ?? null, references: segment.references, timeline: segment.timeline,
    existingTask: existing ? { id: existing.id, state: existing.state, requestStarted: existing.requestStarted } : null };
}
