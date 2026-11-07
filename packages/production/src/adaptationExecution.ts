import { createHash } from "node:crypto";
import type { EpisodeDraft, ProductionCatalog } from "./catalog";
import type { ProductionStore } from "./store";
import { adaptationTaskKey, adoptAdaptationResponse, buildAdaptationTask, readAdaptationInput } from "./adaptationTask";
import { runPricedTextTask, type TextGenerationPort } from "./textWorker";

export type AdaptationModel = { providerId: string; modelId: string; destination: string;
  contextWindow: number; maxOutputTokensLimit: number };
export type AdaptationExecutionInput = { projectId: string; inputId: string; maxOutputTokens: number };
export type AdaptationApproval = { approved: true; maxCalls: 1; planHash: string; maxCostMicros: number };

/** Prices use a separately confirmed ceiling rate, never a cheaper input-only token rate. */
export function previewAdaptationExecution(catalog: ProductionCatalog, store: ProductionStore,
  input: AdaptationExecutionInput, model: AdaptationModel) {
  const { projectId, inputId, maxOutputTokens } = input;
  if (![maxOutputTokens, model.contextWindow, model.maxOutputTokensLimit].every(value => Number.isSafeInteger(value) && value > 0)
    || maxOutputTokens > model.maxOutputTokensLimit) throw new Error("输出长度超过模型配置上限");
  const task = buildAdaptationTask(catalog, projectId, inputId, model.providerId, model.modelId);
  // ACT: Conservative byte-based preflight, not a model tokenizer. Never silently truncate input.
  const inputByteBound = Buffer.byteLength(task.requestJson, "utf8") + 1024;
  if (inputByteBound + maxOutputTokens > model.contextWindow) throw new Error("章节与连续性资料超过模型上下文预检上限，请减少本集章节范围");
  const quantity = model.contextWindow + maxOutputTokens;
  const quote = store.globalBudgets.quotePrice(model.providerId, model.modelId, "textTokenCeiling", quantity);
  if (quote.currency !== "CNY" || quote.amountMicros < 1) throw new Error("请先录入人民币文本保守计价规则");
  const { options } = readAdaptationInput(catalog, projectId, inputId);
  const plan = { projectId, inputId, maxOutputTokens, providerId: model.providerId, modelId: model.modelId,
    destination: model.destination, contextWindow: model.contextWindow, maxOutputTokensLimit: model.maxOutputTokensLimit,
    options, inputByteBound, quantity, unit: "textTokenCeiling",
    priceRuleId: quote.rule.id, estimatedCostMicros: quote.amountMicros, currency: "CNY" as const,
    sourceUrl: quote.rule.sourceUrl, requestJson: task.requestJson };
  return { ...plan, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

/** One approval starts at most one request. Invalid content is retained and never auto-rerolled. */
export async function executeAdaptation(catalog: ProductionCatalog, store: ProductionStore,
  input: AdaptationExecutionInput, model: AdaptationModel, approval: AdaptationApproval,
  provider: TextGenerationPort, parseDraft: (value: unknown) => EpisodeDraft) {
  if (approval.approved !== true || approval.maxCalls !== 1 || !Number.isSafeInteger(approval.maxCostMicros) || approval.maxCostMicros < 1) {
    throw new Error("请明确授权当前编剧输入、一次调用和人民币上限");
  }
  const existing = store.findTaskByIdempotencyKey(adaptationTaskKey(input.projectId, input.inputId, model.providerId, model.modelId));
  let taskId: string;
  let status: string;
  if (existing?.requestStarted) {
    const saved = store.getTextAuthorization(existing.id);
    if (!saved || saved.approvedPlanHash !== approval.planHash || saved.maxCostMicros !== approval.maxCostMicros
      || saved.maxOutputTokens !== input.maxOutputTokens) throw new Error("本次授权与已保存任务不一致，请在任务列表查看原任务");
    taskId = existing.id;
    status = existing.state === "succeeded" ? "already_succeeded" : existing.state === "reconcile_required" ? "reconcile_required" : "already_dispatched";
  } else {
    const plan = previewAdaptationExecution(catalog, store, input, model);
    if (plan.planHash !== approval.planHash) throw new Error("编剧内容、模型配置或价格已变更，请重新预览并授权");
    const task = buildAdaptationTask(catalog, input.projectId, input.inputId, model.providerId, model.modelId);
    const result = await runPricedTextTask(store, { ...task, unit: plan.unit, quantity: plan.quantity }, {
      approvedRequestHash: input.inputId, approvedPlanHash: plan.planHash, priceRuleId: plan.priceRuleId,
      maxCalls: 1, maxCostMicros: approval.maxCostMicros, currency: "CNY", maxOutputTokens: input.maxOutputTokens,
      destination: model.destination, contextWindow: model.contextWindow, maxOutputTokensLimit: model.maxOutputTokensLimit,
    }, provider);
    taskId = result.taskId;
    status = result.status;
  }
  if (status !== "succeeded" && status !== "already_succeeded") return { taskId, status };
  try {
    const adopted = adoptAdaptationResponse(catalog, store, input.projectId, input.inputId, taskId, parseDraft);
    return { taskId, status, episodeId: adopted.episodeId, alreadyAdopted: adopted.alreadyAdopted };
  } catch (cause) {
    return { taskId, status, adoptionError: cause instanceof Error ? cause.message : "编剧结果校验失败" };
  }
}
