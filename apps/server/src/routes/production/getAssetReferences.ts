import { Router } from "express";
import { z } from "zod";
import { listAssetReferences, listReferenceTargets } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const projectId = req.query.projectId as string;
  const result = await u.production.withProduction(directory, catalog => catalog.getStory(projectId)
    ? { targets: listReferenceTargets(catalog, projectId), references: listAssetReferences(catalog, projectId) } : null);
  if (!result) return res.status(404).json(error("当前故事不存在", null, 404));
  res.json(success(result));
});
