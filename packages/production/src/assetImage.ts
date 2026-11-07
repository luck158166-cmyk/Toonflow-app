import { createHash } from "node:crypto";
import type { ProductionCatalog } from "./catalog";
import { listAssetReferences, listReferenceTargets, type ReferenceRole } from "./assetReference";
import { serializeHostMediaRequest, type ProductionStore } from "./store";
import type { SegmentModelStatus } from "./segmentExecution";

export type AssetImageInput = { projectId: string; entityKind: "asset" | "scene"; entityId: string; role: ReferenceRole; visualStyle: string };
export const assetImageModel = "doubao-seedream-5-0-pro-260628";
export const assetImagePriceUnit = "seedream5ProSingleImageCeiling";
const hash = (input: unknown) => createHash("sha256").update(serializeHostMediaRequest(input)).digest("hex");
const compositions: Record<ReferenceRole, string> = {
  headshot: "单人正面头肩特写，五官清晰、自然中性表情，头部完整，纯净浅色背景，均匀柔光。",
  fullBody: "单人正面全身妆造照，从头顶到鞋底完整入画，双手自然垂放，体型比例清楚，纯净浅色背景，均匀柔光。",
  scene: "短剧场景设定图，建立空间纵深与入口方位，环境与照明明确，不出现人物。",
  prop: "单件道具设定图，完整展现形状、材质、颜色与关键细节，纯净浅色背景，不出现人物或手。",
  costume: "服装设定图，完整展现款式、材质、颜色与配饰，使用无人穿着的平铺展示，不出现人物。",
};

export function planAssetImage(catalog: ProductionCatalog, input: AssetImageInput) {
  const project = catalog.getProjectProduction(input.projectId);
  const target = listReferenceTargets(catalog, input.projectId).find(item => item.entityKind === input.entityKind && item.entityId === input.entityId);
  if (!target || !target.roles.includes(input.role)) throw new Error("资产或图片用途不属于当前故事");
  if (!target.locked) throw new Error("请先审核并锁定资产文字设定");
  const episode = project.episodes[0]; if (!episode) throw new Error("请先建立并审核分集");
  const visualStyle = input.visualStyle.trim() || project.shots.find(shot => shot.direction?.style)?.direction?.style || "";
  if (!visualStyle || visualStyle.length > 120 || !target.description.trim()) throw new Error("请填写明确的资产设定与统一画风（不超过 120 字符）");
  const prompt = `${target.name}。${target.description}。${compositions[input.role]}美术风格：${visualStyle}。单幅画面，不要拼图、多视图、文字、标注、边框或水印。`;
  if ([...prompt].length > 300) throw new Error("资产提示词超过项目 300 字符上限，请精简设定；不会自动截断关键特征");
  const size = ["fullBody", "scene", "costume"].includes(input.role) ? "800x1424" : "1024x1024";
  const requestJson = serializeHostMediaRequest({ providerId: "volcengine", modelId: assetImageModel, prompt, size });
  const current = listAssetReferences(catalog, input.projectId).find(item => item.entityId === input.entityId && item.role === input.role);
  const assetTarget = { entityKind: input.entityKind, entityId: input.entityId, entityHash: target.entityHash, role: input.role, expectedReferenceId: current?.id ?? null };
  const taskKey = `assetImage:${hash([input.projectId, input.entityKind, input.entityId, target.entityHash, input.role, requestJson, "seedreamAsset.v1"])}`;
  return { projectId: input.projectId, episodeId: episode.id, episodeNumber: episode.episodeNumber, targetName: target.name,
    visualStyle, requestJson, assetTarget, taskKey, templateVersion: "seedreamAsset.v1" };
}

export function previewAssetImage(catalog: ProductionCatalog, store: ProductionStore, input: AssetImageInput, model: SegmentModelStatus) {
  const plan = planAssetImage(catalog, input); const blockers: string[] = [];
  if (!model.available) blockers.push("请在模型与设置中安装内置 Seedream 5.0 pro 供应商");
  if (!model.configured || !model.credentialScope) blockers.push("请配置火山方舟 API Key");
  let price: { ruleId: string; amountMicros: number; sourceUrl: string } | null = null;
  try {
    const quote = store.globalBudgets.quotePrice("volcengine", assetImageModel, assetImagePriceUnit, 1);
    if (quote.currency !== "CNY" || quote.amountMicros < 1) throw new Error("须使用有效人民币单图价格");
    price = { ruleId: quote.rule.id, amountMicros: quote.amountMicros, sourceUrl: quote.rule.sourceUrl };
  } catch (cause) { blockers.push(cause instanceof Error ? cause.message : "缺少单图价格"); }
  const basis = { ...plan, price, providerRevision: model.revision, credentialScope: model.credentialScope,
    destination: "https://ark.cn-beijing.volces.com/api/v3/images/generations" };
  const existing = store.findTaskByIdempotencyKey(plan.taskKey);
  const adopted = existing ? listAssetReferences(catalog, input.projectId).find(item => item.origin?.taskId === existing.id) : null;
  return { ...basis, planHash: hash(basis), canSubmit: !blockers.length, blockers,
    existingTask: existing ? { id: existing.id, state: existing.state, requestStarted: existing.requestStarted } : null,
    adoptedReferenceId: adopted?.id ?? null };
}
