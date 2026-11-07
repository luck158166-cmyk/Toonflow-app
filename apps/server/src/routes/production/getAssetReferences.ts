import { Router } from "express";
import { z } from "zod";
import { inspectPortraitEligibility, listAssetReferences, listReferenceTargets } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const projectId = req.query.projectId as string;
  const result = await u.production.withProduction(directory, catalog => {
    if (!catalog.getStory(projectId)) return null;
    const targets = listReferenceTargets(catalog, projectId); const references = listAssetReferences(catalog, projectId);
    const scope = u.production.productionCredentialScope(u.conf.get("settings.mediaProviderConfigs.volcengine.apiKey"));
    const portraits = inspectPortraitEligibility(references.map((reference, index) => ({ index: index + 1, entityId: reference.entityId,
      name: targets.find(target => target.entityId === reference.entityId)?.name ?? "未知资产", role: reference.role, description: "", reference })), scope);
    return { targets, references, portraits };
  });
  if (!result) return res.status(404).json(error("当前故事不存在", null, 404));
  res.json(success(result));
});
