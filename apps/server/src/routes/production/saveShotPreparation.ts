import { Router } from "express";
import { z } from "zod";
import { saveShotPreparation } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), shotId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, async catalog => {
    try {
      const report = await u.production.inspectShotPreparation(directory, catalog, req.body.projectId, req.body.shotId);
      if (report.inputHash !== req.body.inputHash) throw new Error("镜头或参考图版本已变化，请刷新后重新检查");
      if (report.issues.length) throw new Error(report.issues[0]!.message);
      return { data: saveShotPreparation(catalog, req.body.projectId, req.body.shotId, req.body.inputHash) };
    } catch (cause) { return { message: cause instanceof Error ? cause.message : "镜头资料未保存" }; }
  });
  if (result.message) return res.status(409).json(error(result.message, null, 409));
  res.json(success(result.data));
});
