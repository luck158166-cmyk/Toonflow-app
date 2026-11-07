import { createHash } from "node:crypto";
import { applyEpisodeDraft, type EpisodeDraft, type ProductionCatalog } from "./catalog";
import { buildAdaptationInput, type AdaptationOptions } from "./adaptationInput";
import type { ProductionStore, PricedTaskInput } from "./store";
import { validateShotDirection, validateShotSceneContext } from "./shotDirection";

export function readAdaptationInput(catalog: ProductionCatalog, projectId: string, inputId: string) {
  const row = catalog.db.query(`SELECT request_json AS requestJson FROM adaptation_input WHERE id = ? AND project_id = ?`)
    .get(inputId, projectId) as { requestJson: string } | null;
  if (!row || createHash("sha256").update(row.requestJson).digest("hex") !== inputId) throw new Error("编剧输入不存在或已被改动");
  const request = JSON.parse(row.requestJson) as { options: AdaptationOptions; responseSchema: unknown; templateVersion: "novelEpisode.v1" | "novelEpisode.v2" | "novelEpisode.v3" };
  return { ...row, ...request };
}

export function adaptationTaskKey(projectId: string, inputId: string, provider: string, modelId: string) {
  return createHash("sha256").update(JSON.stringify(["adaptation.v1", projectId, inputId, provider, modelId])).digest("hex");
}

/** Caller supplies confirmed pricing/authorization; this builder never dispatches or spends. */
export function buildAdaptationTask(catalog: ProductionCatalog, projectId: string, inputId: string,
  provider: string, modelId: string): Omit<PricedTaskInput, "unit" | "quantity"> {
  if (!provider.trim() || !modelId.trim()) throw new Error("编剧供应商与模型不能为空");
  const input = readAdaptationInput(catalog, projectId, inputId);
  if (buildAdaptationInput(catalog, projectId, input.options, input.responseSchema, input.templateVersion).id !== inputId) {
    throw new Error("原文或连续性资料已变更，请重新准备编剧输入");
  }
  return { projectId, episodeId: `adaptation:${input.options.episodeNumber}`, stage: "text", provider, modelId,
    requestJson: input.requestJson,
    idempotencyKey: adaptationTaskKey(projectId, inputId, provider, modelId) };
}

/** Adoption receipt and episode writes commit together, independently of the immutable model response. */
export function adoptAdaptationResponse(catalog: ProductionCatalog, store: ProductionStore,
  projectId: string, inputId: string, taskId: string, parseDraft: (value: unknown) => EpisodeDraft) {
  const input = readAdaptationInput(catalog, projectId, inputId);
  const task = store.getTask(taskId);
  if (task.projectId !== projectId || task.stage !== "text" || task.state !== "succeeded"
    || task.episodeId !== `adaptation:${input.options.episodeNumber}` || task.requestJson !== input.requestJson) {
    throw new Error("编剧任务与当前输入不匹配或尚未完成");
  }
  const output = store.getTextOutput(taskId);
  if (!output || createHash("sha256").update(output.responseText).digest("hex") !== output.sha256) throw new Error("编剧响应缺失或校验失败");
  const receipt = catalog.db.query(`SELECT input_id AS inputId, response_hash AS responseHash, episode_id AS episodeId
    FROM adaptation_adoption WHERE task_id = ?`).get(taskId) as { inputId: string; responseHash: string; episodeId: string } | null;
  if (receipt) {
    if (receipt.inputId !== inputId || receipt.responseHash !== output.sha256) throw new Error("编剧采用记录与响应不一致");
    return { episodeId: receipt.episodeId, alreadyAdopted: true };
  }
  const draft = parseDraft(JSON.parse(output.responseText));
  const schema = input.responseSchema as { properties?: { shots?: { items?: { required?: string[] } } } } | null;
  if (schema?.properties?.shots?.items?.required?.includes("direction")) {
    for (const shot of draft.shots) validateShotDirection(shot.direction, shot.characterNames);
  }
  if (schema?.properties?.shots?.items?.required?.includes("sceneContext")) {
    for (const shot of draft.shots) validateShotSceneContext(shot.sceneContext, draft.script, shot.sceneName);
  }
  if (draft.episodeNumber !== input.options.episodeNumber) throw new Error("生成的集号与编剧任务不一致");
  const duration = draft.shots.reduce((sum, shot) => sum + shot.durationMs, 0);
  if (Math.abs(duration - input.options.targetSeconds * 1000) > Math.max(1000, input.options.targetSeconds * 150)) {
    throw new Error("分镜总时长与目标相差超过 15%，需修正后采用");
  }
  function checkChapter(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(checkChapter); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (typeof item.chapterSequence === "number" && (item.chapterSequence < input.options.firstChapter || item.chapterSequence > input.options.lastChapter)) {
      throw new Error("草稿引用了本次选择范围以外的章节");
    }
    Object.values(item).forEach(checkChapter);
  }
  checkChapter(draft);
  const result = applyEpisodeDraft(catalog, projectId, draft, { taskId, inputId, responseHash: output.sha256,
    validateCurrentInput: () => {
      if (buildAdaptationInput(catalog, projectId, input.options, input.responseSchema, input.templateVersion).id !== inputId) {
        throw new Error("原文或连续性资料已变更，请重新准备编剧输入");
      }
    } });
  return { episodeId: result.episodeId, alreadyAdopted: false };
}
