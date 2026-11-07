import { Router } from "express";
import { z } from "zod";
import { saveShotPrompt } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), shotId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const input = req.body as { directory: string; projectId: string; shotId: string; inputHash: string };
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, async catalog => {
    try {
      const preparation = await u.production.inspectShotPreparation(directory, catalog, input.projectId, input.shotId);
      if (preparation.issues.length) throw new Error(preparation.issues[0]!.message);
      return { data: saveShotPrompt(catalog, input.projectId, input.shotId, input.inputHash) };
    } catch (cause) { return { message: cause instanceof Error ? cause.message : "提示词操作失败" }; }
  });
  if (result.message) return res.status(409).json(error(result.message, null, 409));
  res.json(success(result.data));
});
