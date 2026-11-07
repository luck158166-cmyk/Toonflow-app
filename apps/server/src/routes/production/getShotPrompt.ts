import { Router } from "express";
import { z } from "zod";
import { compileShotPrompt } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), shotId: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = req.query as { directory: string; projectId: string; shotId: string; inputHash: string };
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, async catalog => {
    try {
      const preparation = await u.production.inspectShotPreparation(directory, catalog, input.projectId, input.shotId);
      const report = compileShotPrompt(catalog, input.projectId, input.shotId);
      const fileIssues = preparation.issues.filter(item => item.code === "referenceBytes");
      return { data: { ...report, fileIssues, canSave: report.canSave && !fileIssues.length } };
    } catch (cause) { return { message: cause instanceof Error ? cause.message : "提示词操作失败" }; }
  });
  if (result.message) return res.status(409).json(error(result.message, null, 409));
  res.json(success(result.data));
});
