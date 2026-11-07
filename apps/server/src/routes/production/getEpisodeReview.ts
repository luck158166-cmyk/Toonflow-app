import { Router } from "express";
import { z } from "zod";
import { getEpisodeReview } from "@toonflow/production";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();
export default router.get("/", validateFields({ directory: z.string().min(1).max(4096),
  projectId: z.uuid(), episodeId: z.uuid() }, "query"), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("当前仅支持本地工作区", null, 403));
  const result = await u.production.withProduction(directory, catalog => {
    if (catalog.getEpisode(req.query.episodeId as string)?.projectId !== req.query.projectId) return null;
    return getEpisodeReview(catalog, req.query.projectId as string, req.query.episodeId as string);
  });
  if (!result) return res.status(404).json(error("当前故事没有这个分集", null, 404));
  res.json(success(result));
});
