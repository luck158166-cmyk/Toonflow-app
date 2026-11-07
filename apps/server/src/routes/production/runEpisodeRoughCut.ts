import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), projectId: z.uuid(), episodeId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  try { res.json(success(await u.production.startEpisodeRoughCut(directory, req.body.projectId, req.body.episodeId, req.body.inputHash))); }
  catch (cause) { res.status(409).json(error(cause instanceof Error ? cause.message : "合成启动失败", null, 409)); }
});
