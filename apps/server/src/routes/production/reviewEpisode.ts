import { Router } from "express";
import { z } from "zod";
import { reviewEpisode } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();
export default router.post("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), episodeId: z.uuid(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["confirmed", "changes_requested"]), note: z.string().max(4000),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, catalog => {
    if (catalog.getEpisode(req.body.episodeId)?.projectId !== req.body.projectId) return { status: 404, message: "当前故事没有这个分集" };
    try { return { status: 200, data: reviewEpisode(catalog, req.body) }; }
    catch (cause) { return { status: 409, message: cause instanceof Error ? cause.message : "审核未保存" }; }
  });
  if (result.status !== 200) return res.status(result.status).json(error(result.message ?? "审核未保存", null, result.status));
  res.json(success(result.data));
});
